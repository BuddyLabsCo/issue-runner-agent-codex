import type { EnhancementContext } from "issue-runner-core/terminal";
import { object, type NativeClient } from "../codex/client.ts";
import { primaryCheckout } from "../codex/checkout.ts";
import { readConfiguration, writeProjectTrust } from "../codex/config.ts";

function trusted(response: Record<string, unknown>, primary: string): boolean {
  const config = object(response.config);
  const projects = config.projects === undefined ? {} : object(config.projects);
  const project = projects[primary];
  return project !== undefined && object(project).trust_level === "trusted";
}

export async function preflight(
  client: NativeClient,
  context: EnhancementContext,
): Promise<void> {
  const primary = await primaryCheckout(context);
  const initial = await readConfiguration(client, context.cwd);
  if (client.hasConfigurationWarnings)
    throw new Error(
      "Codex configuration warnings prevent primary checkout trust verification",
    );
  if (trusted(initial, primary)) return;
  const written = await writeProjectTrust(client, primary);
  if (written.status !== "ok" || written.overriddenMetadata != null)
    throw new Error(
      "Codex primary checkout trust write was overridden or rejected",
    );
  const effective = await readConfiguration(client, context.cwd);
  if (client.hasConfigurationWarnings || !trusted(effective, primary))
    throw new Error("Codex primary checkout trust was not established");
}
