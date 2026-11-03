import { NativeClient, object, type Notification } from "../codex/client.ts";
import { diagnostic } from "../diagnostics.ts";

export interface NativeTurn {
  id: string;
  status: string;
  error: unknown;
  items: Record<string, unknown>[];
}

export interface ThreadState {
  id: string;
  status: Record<string, unknown>;
  turns: NativeTurn[];
}

export function threadState(value: unknown, ref: string): ThreadState {
  const thread = object(object(value).thread);
  if (thread.id !== ref || !Array.isArray(thread.turns))
    throw new Error("Invalid Codex thread response");
  const turns = thread.turns.map((value: unknown) => {
    const turn = object(value);
    if (
      typeof turn.id !== "string" ||
      typeof turn.status !== "string" ||
      !Array.isArray(turn.items)
    ) {
      throw new Error("Invalid Codex turn response");
    }
    return {
      id: turn.id,
      status: turn.status,
      error: turn.error,
      items: turn.items.map(object),
    };
  });
  return { id: ref, status: object(thread.status), turns };
}

export class Observation {
  readonly changes = new Set<() => void>();
  sessionref: string | undefined;
  thread: ThreadState | undefined;
  available = true;
  initialized = false;
  willRetry: boolean | undefined;
  expectedFile: string | undefined;
  assignmentVersion = 0;
  version = 0;
  private snapshotVersion = 0;
  private latestStatus: Record<string, unknown> | undefined;
  private binding: Promise<void> | undefined;
  private stopped = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly notification;
  private readonly connectionLost;
  private readonly markerItems: Record<string, unknown>[] = [];

  private readonly client: NativeClient;

  constructor(client: NativeClient) {
    this.client = client;
    this.notification = (notification: Notification) =>
      this.observe(notification);
    this.connectionLost = () => {
      if (this.stopped || !this.available) return;
      this.available = false;
      this.initialized = false;
      this.willRetry = undefined;
      this.invalidate();
      diagnostic(this.sessionref, "observation disconnected");
      this.scheduleReconnect();
    };
    client.notifications.add(this.notification);
    client.disconnections.add(this.connectionLost);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, 10_000);
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      await this.client.reconnect();
      if (this.stopped) return;
      this.latestStatus = undefined;
      this.willRetry = undefined;
      this.binding = undefined;
      if (this.sessionref) await this.bind(this.sessionref);
      else {
        this.available = true;
        this.invalidate();
      }
    } catch {
      if (!this.stopped) {
        this.available = false;
        this.initialized = false;
        this.invalidate();
        diagnostic(this.sessionref, "observation reconnect failed");
      }
    } finally {
      this.reconnecting = false;
      if (!this.stopped && !this.available) this.scheduleReconnect();
    }
  }

  private invalidate(invalidateSnapshot = true): void {
    this.version++;
    if (invalidateSnapshot) this.snapshotVersion++;
    for (const listener of this.changes) listener();
  }

  assign(expectedFile: string): void {
    if (this.expectedFile === expectedFile) return;
    this.expectedFile = expectedFile;
    this.assignmentVersion++;
    this.invalidate();
  }

  async bind(
    ref: string,
    items: Record<string, unknown>[] = [],
  ): Promise<void> {
    if (!this.available && !this.reconnecting)
      throw new Error("Codex observation unavailable");
    if (this.sessionref !== undefined && this.sessionref !== ref)
      throw new Error("Codex session is already bound");
    if (this.binding) return this.binding;
    this.sessionref = ref;
    this.binding = this.attach(ref);
    // Publish evidence before initialization finishes so readiness stops new input.
    this.markerItems.push(...items);
    this.invalidate(false);
    try {
      await this.binding;
    } catch (error) {
      this.binding = undefined;
      throw error;
    }
  }

  private async attach(ref: string): Promise<void> {
    // Native resume attaches this connection's listener without sending a business turn.
    await this.client.request("thread/resume", {
      threadId: ref,
      excludeTurns: true,
    });
    while (!this.stopped) {
      const version = this.snapshotVersion;
      await this.refresh();
      if (this.stopped) return;
      if (!this.client.available)
        throw new Error("Codex observation unavailable");
      // Reconnection must reconcile history superseded by live notifications.
      if (this.reconnecting && version !== this.snapshotVersion) continue;
      this.available = true;
      this.initialized = true;
      this.invalidate(false);
      return;
    }
  }

  async refresh(): Promise<void> {
    const ref = this.sessionref;
    if (!ref || this.stopped || !this.client.available) return;
    const version = this.snapshotVersion;
    const status = this.latestStatus;
    const result = threadState(
      await this.client.request("thread/read", {
        threadId: ref,
        includeTurns: true,
      }),
      ref,
    );
    if (
      this.stopped ||
      !this.client.available ||
      version !== this.snapshotVersion
    )
      return;
    if (this.latestStatus && status !== this.latestStatus)
      result.status = this.latestStatus;
    if (this.thread?.turns.at(-1)?.id !== result.turns.at(-1)?.id)
      this.willRetry = undefined;
    this.thread = result;
    for (const listener of this.changes) listener();
  }

  get items(): Record<string, unknown>[] {
    return [
      ...this.markerItems,
      ...(this.thread?.turns.flatMap((turn) => turn.items) ?? []),
    ];
  }

  private observe({ method, params }: Notification): void {
    if (this.stopped || (!this.available && !this.reconnecting)) return;
    if (!this.sessionref) {
      if (
        [
          "thread/started",
          "item/started",
          "item/completed",
          "turn/completed",
        ].includes(method)
      )
        this.invalidate();
      return;
    }
    if (params.threadId !== this.sessionref) return;
    if (method === "thread/status/changed") {
      this.latestStatus = object(params.status);
      if (this.thread) this.thread.status = this.latestStatus;
      // Status patches merge into pending snapshots without discarding their history.
      this.invalidate(false);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = object(params.item);
      if (item.type === "commandExecution" && item.source === "userShell")
        this.markerItems.push(item);
      const turn = this.thread?.turns.at(-1);
      if (turn && turn.id === params.turnId) {
        const existing = turn.items.findIndex(
          (previous) => typeof item.id === "string" && previous.id === item.id,
        );
        if (existing === -1) turn.items.push(item);
        else turn.items[existing] = item;
      }
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = object(params.turn);
      if (
        typeof turn.id !== "string" ||
        typeof turn.status !== "string" ||
        !Array.isArray(turn.items)
      )
        return;
      const previous = this.thread?.turns.at(-1);
      if (method === "turn/started" || previous?.id !== turn.id)
        this.willRetry = undefined;
      this.thread = {
        id: this.sessionref,
        status: this.thread?.status ?? { type: "active" },
        turns: [
          {
            id: turn.id,
            status: turn.status,
            error: turn.error,
            items: turn.items.length
              ? turn.items.map(object)
              : previous?.id === turn.id
                ? previous.items
                : [],
          },
        ],
      };
    }
    if (method === "error" && params.turnId === this.thread?.turns.at(-1)?.id)
      this.willRetry =
        typeof params.willRetry === "boolean" ? params.willRetry : undefined;
    this.invalidate();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.available = false;
    this.initialized = false;
    this.invalidate();
    this.client.notifications.delete(this.notification);
    this.client.disconnections.delete(this.connectionLost);
    this.changes.clear();
  }
}
