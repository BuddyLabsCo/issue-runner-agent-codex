import { NativeClient, object, type Notification } from "../codex/client.ts";
import { disconnected } from "../diagnostics.ts";

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

function threadState(value: unknown, ref: string): ThreadState {
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
  willRetry: boolean | undefined;
  expectedFile: string | undefined;
  assignmentVersion = 0;
  version = 0;
  private snapshotVersion = 0;
  private latestStatus: Record<string, unknown> | undefined;
  private binding: Promise<void> | undefined;
  private stopped = false;
  private readonly notification;
  private readonly connectionLost;
  private readonly markerItems: Record<string, unknown>[] = [];

  private readonly client: NativeClient;

  constructor(client: NativeClient) {
    this.client = client;
    this.notification = (notification: Notification) =>
      this.observe(notification);
    this.connectionLost = () => {
      this.available = false;
      this.willRetry = undefined;
      this.invalidate();
      disconnected(this.sessionref);
    };
    client.notifications.add(this.notification);
    client.disconnections.add(this.connectionLost);
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

  async bind(ref: string): Promise<void> {
    if (this.sessionref !== undefined && this.sessionref !== ref)
      throw new Error("Codex session is already bound");
    if (this.binding) return this.binding;
    this.sessionref = ref;
    // Native resume attaches this connection's listener without sending a business turn.
    this.binding = this.client
      .request("thread/resume", { threadId: ref, excludeTurns: true })
      .then(() => this.refresh());
    try {
      await this.binding;
    } catch (error) {
      this.binding = undefined;
      throw error;
    }
  }

  async refresh(): Promise<void> {
    const ref = this.sessionref;
    if (!ref || this.stopped || !this.available) return;
    const version = this.snapshotVersion;
    const status = this.latestStatus;
    const result = threadState(
      await this.client.request("thread/read", {
        threadId: ref,
        includeTurns: true,
      }),
      ref,
    );
    if (this.stopped || !this.available || version !== this.snapshotVersion)
      return;
    if (this.latestStatus && status !== this.latestStatus)
      result.status = this.latestStatus;
    if (this.thread?.turns.at(-1)?.id !== result.turns.at(-1)?.id)
      this.willRetry = undefined;
    this.thread = result;
    for (const listener of this.changes) listener();
  }

  hasMarker(guid: string): boolean {
    return [
      ...this.markerItems,
      ...(this.thread?.turns.flatMap((turn) => turn.items) ?? []),
    ].some(
      (item) =>
        item.type === "commandExecution" &&
        item.source === "userShell" &&
        typeof item.command === "string" &&
        item.command.includes(guid),
    );
  }

  private observe({ method, params }: Notification): void {
    if (
      this.stopped ||
      !this.available ||
      !this.sessionref ||
      params.threadId !== this.sessionref
    )
      return;
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
    this.available = false;
    this.invalidate();
    this.client.notifications.delete(this.notification);
    this.client.disconnections.delete(this.connectionLost);
    this.changes.clear();
  }
}
