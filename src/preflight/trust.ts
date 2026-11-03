import type { EnhancementContext } from "issue-runner-core/terminal";
import { resolve } from "node:path";
import { object, type NativeClient } from "../codex/client.ts";
import { primaryCheckout } from "../codex/checkout.ts";
import { readConfiguration, writeProjectTrust } from "../codex/config.ts";

function trusted(response: Record<string, unknown>, primary: string): boolean {
  const config = object(response.config);
  const projects = object(config.projects ?? {});
  const project = projects[primary];
  return project !== undefined && object(project).trust_level === "trusted";
}

function verifyWorkingTrust(
  response: Record<string, unknown>,
  cwd: string,
  worktree: string,
): void {
  const projects = object(object(response.config).projects ?? {});
  for (const path of [resolve(cwd), worktree]) {
    const project = projects[path];
    if (project !== undefined && object(project).trust_level === "untrusted")
      throw new Error("Codex task checkout is explicitly untrusted");
  }
  if (!Array.isArray(response.layers))
    throw new Error(
      "Invalid Codex configuration layers for trust verification",
    );
  for (const value of response.layers) {
    const layer = object(value);
    if (object(layer.name).type === "project" && layer.disabledReason != null)
      throw new Error(
        "Codex project layer remains disabled; task trust was not established",
      );
  }
}

export async function preflight(
  client: NativeClient,
  context: EnhancementContext,
): Promise<void> {
  const { primary, worktree } = await primaryCheckout(context);
  const initial = await readConfiguration(client, context.cwd);
  if (trusted(initial, primary)) {
    verifyWorkingTrust(initial, context.cwd, worktree);
    if (client.hasConfigurationWarnings)
      throw new Error(
        "Codex configuration warnings prevent primary checkout trust verification",
      );
    return;
  }
  // Initial warnings can describe project layers that this trust write enables.
  client.hasConfigurationWarnings = false;
  const written = await writeProjectTrust(client, primary);
  if (written.status !== "ok" || written.overriddenMetadata != null)
    throw new Error(
      "Codex primary checkout trust write was overridden or rejected",
    );
  const effective = await readConfiguration(client, context.cwd);
  if (client.hasConfigurationWarnings || !trusted(effective, primary))
    throw new Error("Codex primary checkout trust was not established");
  verifyWorkingTrust(effective, context.cwd, worktree);
}
