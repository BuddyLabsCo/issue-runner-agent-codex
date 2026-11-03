import { randomUUID } from "node:crypto";
import type {
  Enhancement,
  EnhancementHost,
  EnhancementContext,
} from "issue-runner-core/terminal";
import { connectNative, type NativeClient } from "./codex/client.ts";
import { parseOptions, type Options } from "./config.ts";
import { Observation } from "./monitor/state.ts";
import { Readiness } from "./session/ready.ts";
import { ErrorRecovery } from "./recovery/error.ts";
import { preflight } from "./preflight/trust.ts";

function assemble(
  host: EnhancementHost,
  client: NativeClient,
  options: Options,
  cwd: string,
): Enhancement {
  const observation = new Observation(client);
  const readiness = new Readiness(
    host,
    client,
    observation,
    randomUUID(),
    options.readyTimeout,
  );
  const recovery = new ErrorRecovery(host, observation, options, cwd);
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
    onAssignment(expectedFile) {
      active();
      observation.assign(expectedFile);
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      recovery.stop();
      readiness.stop();
      observation.stop();
      stopping = client.close().then(() => recovery.finish());
      return stopping;
    },
  };
}

export async function createEnhancement(
  host: EnhancementHost,
  context: EnhancementContext,
  config: unknown,
): Promise<Enhancement> {
  const options = parseOptions(config);
  const client = await connectNative(context);
  try {
    await preflight(client, context);
    return assemble(host, client, options, context.cwd);
  } catch (error) {
    await client.close();
    throw error;
  }
}
