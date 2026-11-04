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
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const active = () => {
    if (stopped) throw new Error("Codex enhancement stopped");
    recovery.check();
  };
  return {
    async startMonitoring(sessionref) {
      active();
      if (sessionref !== undefined) {
        if (!sessionref.trim())
          throw new TypeError("Codex sessionref must not be empty");
        await observation.bind(sessionref);
      }
    },
    async waitUntilReady() {
      active();
      return await readiness.wait();
    },
    onAssignment(assignment) {
      active();
      observation.assign(assignment);
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      recovery.stop();
      readiness.stop();
      observation.stop();
      const input = Promise.all([readiness.finish(), recovery.finish()]);
      stopping = client
        .close()
        .finally(() => input)
        .catch((error: unknown) => {
          stopping = undefined;
          throw error;
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
  const options = parseOptions(config);
  const client = await connectNative(context);
  try {
    await preflight(client, context);
    return assemble(io, requestRecovery, client, options, context.cwd);
  } catch (error) {
    await client.close().catch(() => {
      diagnostic(undefined, "initialization cleanup failed");
    });
    throw error;
  }
}
