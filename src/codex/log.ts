import fs from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { diagnostic } from "../diagnostics.ts";

export interface LogContext {
  sessionref?: string | undefined;
  assignmentId?: string | undefined;
  turnId?: string | undefined;
}

export type LogLevel = "info" | "error";
export type ScheduledLog = (
  outcome: "started" | "cancelled" | "timed out",
) => void;

const limit = 2_097_152;
const runId = randomUUID();
let sink: { directory: string; path: string; bytes: number } | undefined;
let lastTimestamp = 0;

function rotate(directory: string): void {
  let timestamp = Math.max(Date.now(), lastTimestamp + 1);
  for (;;) {
    const name = `agent-codex-log-${new Date(timestamp).toISOString().replaceAll(":", "-")}.jsonl`;
    const path = join(directory, name);
    try {
      fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      sink = { directory, path, bytes: 0 };
      lastTimestamp = timestamp;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      timestamp++;
    }
  }
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, value: unknown): unknown => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value instanceof Error
        ? Object.fromEntries(
            Object.getOwnPropertyNames(value).map((key) => [
              key,
              Reflect.get(value, key) as unknown,
            ]),
          )
        : value;
    }) + "\n"
  );
}

interface Instance {
  id: string;
  level: LogLevel;
  context: (turnId?: string) => LogContext;
  storage: AsyncLocalStorage<LogContext>;
}

export class Log {
  private readonly cwd: string;
  private readonly instance: Instance;
  private readonly origin: LogContext | undefined;

  constructor(cwd: string, instance: Instance, origin?: LogContext) {
    this.cwd = cwd;
    this.instance = instance;
    this.origin = origin;
  }

  set level(level: LogLevel) {
    this.instance.level = level;
  }

  set context(context: (turnId?: string) => LogContext) {
    this.instance.context = context;
  }

  current(turnId?: string): LogContext {
    return { ...this.instance.context(turnId) };
  }

  private snapshot(): LogContext {
    return {
      ...(this.origin ??
        this.instance.storage.getStore() ??
        this.instance.context()),
    };
  }

  capture(context: LogContext = {}): Log {
    return new Log(this.cwd, this.instance, { ...this.snapshot(), ...context });
  }

  run<T>(action: () => T): T {
    return this.instance.storage.run(this.snapshot(), action);
  }

  error(event: string, detail?: unknown): void {
    this.write("error", event, detail);
  }

  info(event: string, detail?: unknown): void {
    if (this.instance.level === "info") this.write("info", event, detail);
  }

  schedule(event: string, delayMs: number, reason: string): ScheduledLog {
    const log = this.capture();
    const detail = {
      reason,
      delayMs,
      scheduledFor: new Date(Date.now() + delayMs).toISOString(),
    };
    log.info(`${event} scheduled`, detail);
    let finished = false;
    return (outcome) => {
      if (finished) return;
      finished = true;
      log.info(`${event} ${outcome}`, detail);
    };
  }

  private write(level: LogLevel, event: string, detail: unknown): void {
    if (!sink) return;
    try {
      const record = serialize({
        time: new Date().toISOString(),
        level,
        event,
        runId,
        instanceId: this.instance.id,
        cwd: this.cwd,
        ...this.snapshot(),
        detail,
      });
      const bytes = Buffer.byteLength(record, "utf8");
      if (sink.bytes > 0 && sink.bytes + bytes > limit) rotate(sink.directory);
      fs.appendFileSync(sink.path, record);
      sink.bytes += bytes;
    } catch {
      diagnostic(undefined, "log write failed");
    }
  }
}

export function createLog(cwd: string): Log {
  const log = new Log(cwd, {
    id: randomUUID(),
    level: "error",
    context: () => ({}),
    storage: new AsyncLocalStorage<LogContext>(),
  });
  if (!sink) {
    try {
      const directory = resolve(cwd, "..", "..", "..", "logs");
      fs.mkdirSync(directory, { recursive: true });
      rotate(directory);
    } catch {
      diagnostic(undefined, "log creation failed");
    }
  }
  return log;
}
