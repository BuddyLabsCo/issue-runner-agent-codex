import type { EnhancementHost } from "issue-runner-core/terminal";
import { resolve } from "node:path";
import { expectedFileExists } from "../codex/files.ts";
import type { Options } from "../config.ts";
import { diagnostic } from "../diagnostics.ts";
import type { Observation } from "../monitor/state.ts";

const excludedErrors = new Set([
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "unauthorized",
  "modelNotFound",
  "contextWindowExceeded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
]);

function excludedError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return;
  if ("codexErrorInfo" in error && typeof error.codexErrorInfo === "string") {
    if (excludedErrors.has(error.codexErrorInfo)) return error.codexErrorInfo;
  }
}

interface Pending {
  turn: string;
  timer?: ReturnType<typeof setTimeout>;
  work?: Promise<void>;
}

export class ErrorRecovery {
  private readonly host: EnhancementHost;
  private readonly observation: Observation;
  private readonly options: Options;
  private readonly cwd: string;
  private attempts = 0;
  private assignment = 0;
  private pending: Pending | undefined;
  private submission: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private stopped = false;
  private reported: string | undefined;
  private readonly changed = () => this.evaluate();

  constructor(
    host: EnhancementHost,
    observation: Observation,
    options: Options,
    cwd: string,
  ) {
    this.host = host;
    this.observation = observation;
    this.options = options;
    this.cwd = cwd;
    observation.changes.add(this.changed);
  }

  check(): void {
    if (this.failure) throw this.failure.error;
  }

  private eligible(): string | undefined {
    const observation = this.observation;
    const turn = observation.thread?.turns.at(-1);
    const status = observation.thread?.status.type;
    if (
      observation.available &&
      observation.initialized &&
      observation.sessionref &&
      observation.expectedFile &&
      turn?.status === "failed" &&
      (status === "idle" || status === "systemError") &&
      observation.willRetry !== true
    )
      return turn.id;
  }

  private cancel(): void {
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
  }

  private evaluate(): void {
    const observation = this.observation;
    if (this.assignment !== observation.assignmentVersion) {
      this.assignment = observation.assignmentVersion;
      this.attempts = 0;
      this.cancel();
    }
    const status = observation.thread?.turns.at(-1)?.status;
    if (status === "completed" || status === "interrupted") {
      this.attempts = 0;
      this.reported = undefined;
    }
    let turn = this.eligible();
    const excluded = turn
      ? excludedError(observation.thread?.turns.at(-1)?.error)
      : undefined;
    if (excluded) {
      const report = `${this.assignment}:${turn}:${excluded}`;
      if (this.reported !== report) {
        this.reported = report;
        diagnostic(
          observation.sessionref,
          `recovery=error excluded=${excluded}`,
        );
      }
      turn = undefined;
    }
    if (!turn || this.pending?.turn !== turn) this.cancel();
    if (turn && this.attempts >= this.options.retryLimit) {
      const report = `${this.assignment}:${turn}:exhausted`;
      if (this.reported !== report) {
        this.reported = report;
        diagnostic(
          observation.sessionref,
          `recovery=error exhausted=${this.attempts}/${this.options.retryLimit}`,
        );
      }
      return;
    }
    if (
      this.stopped ||
      this.failure ||
      !turn ||
      this.pending ||
      this.submission
    )
      return;
    this.schedule(turn);
  }

  private schedule(turn: string): void {
    const pending: Pending = { turn };
    this.pending = pending;
    let remaining =
      this.options.retryDelay[
        Math.min(this.attempts, this.options.retryDelay.length - 1)
      ]!;
    const schedule = () => {
      // Node clamps overflowing timer delays to one millisecond.
      const seconds = Math.min(remaining, 2_147_483.647);
      pending.timer = setTimeout(() => {
        remaining -= seconds;
        if (remaining > 0) {
          schedule();
          return;
        }
        let reevaluate = false;
        const work = this.submit(pending)
          .then((retry) => {
            reevaluate = retry;
          })
          .catch((error: unknown) => {
            this.failure = { error };
          })
          .finally(() => {
            if (this.submission === work) this.submission = undefined;
            if (reevaluate) this.evaluate();
          });
        pending.work = work;
      }, seconds * 1_000);
    };
    schedule();
  }

  private async submit(pending: Pending): Promise<boolean> {
    const version = this.observation.version;
    let present: boolean;
    try {
      await this.observation.refresh();
      if (this.pending !== pending) return true;
      const expectedFile = this.observation.expectedFile!;
      present = await expectedFileExists(resolve(this.cwd, expectedFile));
    } catch (error) {
      if (this.pending !== pending) return true;
      throw error;
    }
    if (this.pending !== pending) return true;
    this.cancel();
    if (
      version !== this.observation.version ||
      this.eligible() !== pending.turn ||
      excludedError(this.observation.thread?.turns.at(-1)?.error) !== undefined
    )
      return true;
    if (present) return false;
    this.submission = pending.work;
    this.attempts++;
    diagnostic(
      this.observation.sessionref,
      `recovery=error attempt=${this.attempts}/${this.options.retryLimit}`,
    );
    await this.host.requestRecovery();
    // A submission need not immediately produce a native turn notification.
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    this.observation.changes.delete(this.changed);
  }

  async finish(): Promise<void> {
    await this.submission;
    this.check();
  }
}
