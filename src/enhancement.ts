import { randomUUID } from "node:crypto";
import type {
  Enhancement,
  TerminalIO,
  RequestRecovery,
  EnhancementContext,
} from "issue-runner-core/terminal";
import { connectNative, type NativeClient } from "./codex/client.ts";
import { parseOptions, type Options } from "./config.ts";
import { Observation } from "./monitor/state.ts";
import { Readiness } from "./session/ready.ts";
import { ErrorRecovery } from "./recovery/error.ts";
import { preflight } from "./preflight/trust.ts";
import { createLog, type ScheduledLog } from "./codex/log.ts";
import { diagnostic } from "./diagnostics.ts";

function assemble(
  io: TerminalIO,
  requestRecovery: RequestRecovery,
  client: NativeClient,
  options: Options,
  cwd: string,
): Enhancement {
  const observation = new Observation(client);
  const readiness = new Readiness(
    io,
    client,
    observation,
    randomUUID(),
    options.readyTimeout,
  );
  const recovery = new ErrorRecovery(
    requestRecovery,
    observation,
    options,
    cwd,
  );
  let sessionid: string | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const active = () => {
    if (stopped) {
      if (sessionid) return false;
      throw new Error("Codex enhancement stopped");
    }
    recovery.check();
    return true;
  };
  const failed = (event: string, error: unknown) => {
    client.log.error(event, error);
    diagnostic(observation.sessionref, event);
  };
  return {
    async startMonitoring(sessionref) {
      if (!active()) return;
      const log = client.log.capture({
        sessionref: sessionref ?? observation.sessionref,
      });
      try {
        if (sessionref !== undefined) {
          if (!sessionref.trim())
            throw new TypeError("Codex sessionref must not be empty");
          await observation.bind(sessionref);
        }
      } catch (error) {
        log.error("monitoring operation failed", error);
        diagnostic(observation.sessionref, "monitoring operation failed");
        if (!sessionid) throw error;
      }
    },
    async waitUntilReady() {
      active();
      if (sessionid) return sessionid;
      const log = client.log.capture();
      try {
        sessionid = await readiness.wait();
        return sessionid;
      } catch (error) {
        log.error("readiness failed", error);
        throw error;
      }
    },
    onAssignment(assignment) {
      if (!active()) return;
      try {
        observation.assign(assignment);
      } catch (error) {
        failed("assignment operation failed", error);
        if (!sessionid) throw error;
      }
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      recovery.stop();
      readiness.stop();
      observation.stop();
      const input = Promise.all([readiness.finish(), recovery.finish()]);
      const closing = client.close().finally(() => input);
      const cleanupLog = client.log.capture();
      let deadline: ScheduledLog | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = sessionid
        ? Promise.race([
            closing,
            new Promise<never>((_resolve, reject) => {
              deadline = cleanupLog.schedule(
                "cleanup deadline",
                10_000,
                "bounded cleanup after readiness",
              );
              timer = setTimeout(() => {
                deadline?.("timed out");
                reject(new Error("Codex cleanup timed out"));
              }, 10_000);
            }),
          ])
        : closing;
      stopping = bounded
        .catch((error: unknown) => {
          stopping = undefined;
          cleanupLog.error("cleanup operation failed", error);
          diagnostic(observation.sessionref, "cleanup operation failed");
          if (!sessionid) throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          deadline?.("cancelled");
        });
      return stopping;
    },
  };
}

export async function createEnhancement(
  io: TerminalIO,
  requestRecovery: RequestRecovery,
  context: EnhancementContext,
  config: unknown,
): Promise<Enhancement> {
  const log = createLog(context.cwd);
  let options: Options;
  try {
    options = parseOptions(config);
    log.level = options.logLevel;
  } catch (error) {
    log.error("configuration validation failed", error);
    throw error;
  }
  const client = await connectNative(context, log);
  try {
    await preflight(client, context);
    return assemble(io, requestRecovery, client, options, context.cwd);
  } catch (error) {
    client.log.error("preflight failed", error);
    await client.close().catch((error: unknown) => {
      client.log.error("initialization cleanup failed", error);
      diagnostic(undefined, "initialization cleanup failed");
    });
    throw error;
  }
}
