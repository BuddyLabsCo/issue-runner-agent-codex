import type { RequestRecovery } from "issue-runner-core/terminal";
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

type Category = "error" | "missing-handoff";

interface Candidate {
  assignment: NonNullable<Observation["assignment"]>;
  turn: string;
  category: Category;
}

interface Pending extends Candidate {
  timer?: ReturnType<typeof setTimeout>;
  work?: Promise<void>;
}

export class ErrorRecovery {
  private readonly requestRecovery: RequestRecovery;
  private readonly observation: Observation;
  private readonly options: Options;
  private readonly cwd: string;
  private readonly attempts = { error: 0, "missing-handoff": 0 };
  private assignment = 0;
  private pending: Pending | undefined;
  private submission: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private stopped = false;
  private reported: string | undefined;
  private readonly changed = () => this.evaluate();

  constructor(
    requestRecovery: RequestRecovery,
    observation: Observation,
    options: Options,
    cwd: string,
  ) {
    this.requestRecovery = requestRecovery;
    this.observation = observation;
    this.options = options;
    this.cwd = cwd;
    observation.changes.add(this.changed);
  }

  check(): void {
    if (this.failure) throw this.failure.error;
  }

  private eligible(): Candidate | undefined {
    const observation = this.observation;
    const turn = observation.thread?.turns.at(-1);
    const status = observation.thread?.status.type;
    if (
      observation.available &&
      observation.initialized &&
      observation.sessionref &&
      observation.assignment &&
      turn
    ) {
      if (
        turn.status === "failed" &&
        (status === "idle" || status === "systemError") &&
        observation.willRetry !== true
      )
        return {
          assignment: observation.assignment,
          turn: turn.id,
          category: "error",
        };
      if (
        (turn.status === "completed" || turn.status === "interrupted") &&
        status === "idle"
      )
        return {
          assignment: observation.assignment,
          turn: turn.id,
          category: "missing-handoff",
        };
    }
  }

  private cancel(): void {
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
  }

  private actionRequired(): boolean {
    const reply = this.observation.thread?.turns
      .at(-1)
      ?.items.filter(
        (item) =>
          item.type === "agentMessage" &&
          (item.phase == null || item.phase === "final_answer"),
      )
      .at(-1);
    return (
      typeof reply?.text === "string" &&
      reply.text.trimStart().startsWith("[action required]")
    );
  }

  private report(candidate: Candidate, message: string): void {
    const report = `${candidate.category}:${this.assignment}:${candidate.turn}:${message}`;
    if (this.reported === report) return;
    this.reported = report;
    diagnostic(this.observation.sessionref, message);
  }

  private evaluate(): void {
    if (this.stopped) return;
    const observation = this.observation;
    if (this.assignment !== observation.assignmentVersion) {
      this.assignment = observation.assignmentVersion;
      this.attempts.error = 0;
      this.attempts["missing-handoff"] = 0;
      this.cancel();
    }
    const status = observation.thread?.turns.at(-1)?.status;
    if (status === "completed" || status === "interrupted") {
      this.attempts.error = 0;
      if (this.reported?.startsWith("error:")) this.reported = undefined;
    }
    let candidate = this.eligible();
    const excluded =
      candidate?.category === "error"
        ? excludedError(observation.thread?.turns.at(-1)?.error)
        : undefined;
    if (excluded && candidate) {
      this.report(candidate, `recovery=error excluded=${excluded}`);
      candidate = undefined;
    }
    if (
      !candidate ||
      this.pending?.turn !== candidate.turn ||
      this.pending.category !== candidate.category
    )
      this.cancel();
    if (candidate?.category === "missing-handoff") {
      void this.inspectHandoff(candidate);
      return;
    }
    if (candidate) this.consider(candidate);
  }

  private async inspectHandoff(candidate: Candidate): Promise<void> {
    const observation = this.observation;
    const version = observation.version;
    const thread = observation.thread;
    const current = () =>
      !this.stopped &&
      version === observation.version &&
      thread === observation.thread;
    const actionRequired = this.actionRequired();
    if (actionRequired) {
      this.report(candidate, "ACTION REQUIRED!!!");
      this.cancel();
    }
    try {
      const present = await expectedFileExists(
        resolve(this.cwd, candidate.assignment.expectedFile),
      );
      if (!current()) return;
      if (present) {
        this.attempts["missing-handoff"] = 0;
        if (!actionRequired && this.reported?.startsWith("missing-handoff:"))
          this.reported = undefined;
        this.cancel();
        return;
      }
      if (!actionRequired) this.consider(candidate);
    } catch (error) {
      if (!current()) return;
      this.observation.client.log("recovery check failed", error);
      diagnostic(this.observation.sessionref, "recovery operation failed");
      this.cancel();
    }
  }

  private consider(candidate: Candidate): void {
    if (this.attempts[candidate.category] >= this.options.retryLimit) {
      const { category } = candidate;
      this.report(
        candidate,
        `recovery=${category} exhausted=${this.attempts[category]}/${this.options.retryLimit}`,
      );
      return;
    }
    if (this.stopped || this.failure || this.pending || this.submission) return;
    this.schedule(candidate);
  }

  private schedule(candidate: Candidate): void {
    const pending: Pending = { ...candidate };
    this.pending = pending;
    let remaining =
      pending.category === "missing-handoff"
        ? this.options.handoffRecoveryDelaySeconds
        : this.options.retryDelay[
            Math.min(this.attempts.error, this.options.retryDelay.length - 1)
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
            this.observation.client.log("recovery input failed", error);
            diagnostic(
              this.observation.sessionref,
              "recovery operation failed",
            );
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
      const expectedFile = pending.assignment.expectedFile;
      present = await expectedFileExists(resolve(this.cwd, expectedFile));
    } catch (error) {
      if (this.pending !== pending) return true;
      this.cancel();
      this.observation.client.log("recovery check failed", error);
      diagnostic(this.observation.sessionref, "recovery operation failed");
      return false;
    }
    if (this.pending !== pending) return true;
    this.cancel();
    const candidate = this.eligible();
    if (
      version !== this.observation.version ||
      candidate?.assignment !== pending.assignment ||
      candidate.turn !== pending.turn ||
      candidate.category !== pending.category ||
      (pending.category === "missing-handoff" && this.actionRequired()) ||
      (pending.category === "error" &&
        excludedError(this.observation.thread?.turns.at(-1)?.error) !==
          undefined)
    )
      return true;
    if (present) {
      this.attempts["missing-handoff"] = 0;
      return false;
    }
    this.submission = pending.work;
    const attempt = ++this.attempts[pending.category];
    diagnostic(
      this.observation.sessionref,
      `recovery=${pending.category} attempt=${attempt}/${this.options.retryLimit}`,
    );
    await this.requestRecovery(pending.assignment.id);
    // Core may fulfill a stale request without submitting input.
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    this.observation.changes.delete(this.changed);
  }

  async finish(): Promise<void> {
    await this.submission;
  }
}
