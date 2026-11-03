import type { EnhancementHost } from "issue-runner-core/terminal";
import { Observation, threadState } from "../monitor/state.ts";
import { NativeClient, object } from "../codex/client.ts";

function containsMarker(
  items: Record<string, unknown>[],
  guid: string,
): boolean {
  return items.some(
    (item) =>
      item.type === "commandExecution" &&
      item.source === "userShell" &&
      typeof item.command === "string" &&
      item.command.includes(guid),
  );
}

export class Readiness {
  private round: Promise<void> | undefined;
  private discovery: Promise<void> | undefined;
  private readonly cancellations = new Set<() => void>();
  private nextRoundAt = 0;

  private readonly host: EnhancementHost;
  private readonly client: NativeClient;
  private readonly observation: Observation;
  private readonly guid: string;
  private readonly timeout: number;

  constructor(
    host: EnhancementHost,
    client: NativeClient,
    observation: Observation,
    guid: string,
    timeout: number,
  ) {
    this.host = host;
    this.client = client;
    this.observation = observation;
    this.guid = guid;
    this.timeout = timeout;
  }

  wait(): Promise<string> {
    if (this.cancellations.size === 0 && !this.round) this.nextRoundAt = 0;
    return this.run();
  }

  private run(): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let detected = false;
      let next: ReturnType<typeof setTimeout> | undefined;
      const finish = (...errors: [] | [unknown]) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(next);
        this.observation.changes.delete(changed);
        this.cancellations.delete(cancel);
        if (errors.length) {
          // Host rejection values propagate unchanged across this boundary.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(errors[0]);
        } else resolve(this.observation.sessionref!);
      };
      const changed = () => {
        if (!this.observation.available) {
          finish(new Error("Codex observation unavailable"));
          return;
        }
        if (!this.observation.sessionref) {
          void this.discover().catch(finish);
          return;
        }
        if (containsMarker(this.observation.items, this.guid)) {
          detected = true;
          clearTimeout(next);
          if (this.observation.initialized && !this.round) finish();
        }
      };
      const submit = () => {
        if (settled) return;
        if (!this.round && !detected) {
          const delay = this.nextRoundAt - Date.now();
          if (delay > 0) {
            next = setTimeout(submit, delay);
            return;
          }
          this.round = Promise.resolve().then(() => {
            if (this.cancellations.size)
              return this.host.submitText(`!${this.guid}`);
          });
        }
        const round = this.round;
        if (!round) return;
        void round.then(
          () => {
            if (this.round === round) {
              this.round = undefined;
              this.nextRoundAt = Date.now() + 2_000;
            }
            if (settled) return;
            changed();
            if (!settled && !detected) next = setTimeout(submit, 2_000);
          },
          (error: unknown) => {
            if (this.round === round) this.round = undefined;
            finish(error);
          },
        );
      };
      let deadline: ReturnType<typeof setTimeout>;
      let remaining = this.timeout;
      const scheduleDeadline = () => {
        // Node clamps overflowing timer delays to one millisecond.
        const seconds = Math.min(remaining, 2_147_483.647);
        deadline = setTimeout(() => {
          remaining -= seconds;
          if (remaining > 0) scheduleDeadline();
          else finish(new Error("Codex readiness timed out"));
        }, seconds * 1_000);
      };
      scheduleDeadline();
      const cancel = () => finish(new Error("Codex enhancement stopped"));
      this.cancellations.add(cancel);
      this.observation.changes.add(changed);
      if (this.observation.sessionref)
        void this.observation.bind(this.observation.sessionref).catch(finish);
      changed();
      if (!settled) submit();
    });
  }

  private discover(): Promise<void> {
    const version = this.observation.version;
    this.discovery ??= this.scanLoaded().finally(() => {
      this.discovery = undefined;
      // Recheck events received while the loaded-thread snapshot was in flight.
      if (version !== this.observation.version && !this.observation.sessionref)
        for (const listener of this.observation.changes) listener();
    });
    return this.discovery;
  }

  private async scanLoaded(): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = object(
        await this.client.request(
          "thread/loaded/list",
          cursor ? { cursor } : {},
        ),
      );
      if (
        this.cancellations.size === 0 ||
        !this.observation.available ||
        this.observation.sessionref
      )
        return;
      if (
        !Array.isArray(page.data) ||
        page.data.some((ref: unknown) => typeof ref !== "string" || !ref.trim())
      )
        throw new Error("Invalid Codex loaded threads response");
      for (const ref of page.data as string[]) {
        const snapshot = threadState(
          await this.client.request("thread/read", {
            threadId: ref,
            includeTurns: true,
          }),
          ref,
        );
        if (
          this.cancellations.size === 0 ||
          !this.observation.available ||
          this.observation.sessionref
        )
          return;
        const items = snapshot.turns.flatMap((turn) => turn.items);
        if (!containsMarker(items, this.guid)) continue;
        await this.observation.bind(ref, items);
        return;
      }
      if (
        page.nextCursor !== undefined &&
        page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          !page.nextCursor ||
          cursors.has(page.nextCursor))
      )
        throw new Error("Invalid Codex loaded threads cursor");
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  stop(): void {
    for (const cancel of this.cancellations) cancel();
  }
}
