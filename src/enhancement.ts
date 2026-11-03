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

function assemble(
  host: EnhancementHost,
  client: NativeClient,
  options: Options,
): Enhancement {
  const observation = new Observation(client);
  const readiness = new Readiness(
    host,
    observation,
    randomUUID(),
    options.readyTimeout,
  );
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const active = () => {
    if (stopped) throw new Error("Codex enhancement stopped");
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
      readiness.stop();
      observation.stop();
      stopping = client.close();
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
    return assemble(host, client, options);
  } catch (error) {
    await client.close();
    throw error;
  }
}
