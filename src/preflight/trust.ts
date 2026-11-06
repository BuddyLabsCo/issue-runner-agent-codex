import type { EnhancementContext } from "issue-runner-core/terminal";
import { resolve } from "node:path";
import { object, type NativeClient } from "../codex/client.ts";
import { primaryCheckout } from "../codex/checkout.ts";
import { readConfiguration, upsertConfiguration } from "../codex/config.ts";
import { trustHooks } from "./hooks.ts";

function trusted(response: Record<string, unknown>, primary: string): boolean {
  const config = object(response.config);
  const projects = object(config.projects ?? {});
  const project = projects[primary];
  return project !== undefined && object(project).trust_level === "trusted";
}

function projectLayers(response: Record<string, unknown>) {
  if (!Array.isArray(response.layers))
    throw new Error(
      "Invalid Codex configuration layers for trust verification",
    );
  return response.layers
    .map(object)
    .filter((layer) => object(layer.name).type === "project");
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
  for (const layer of projectLayers(response)) {
    if (layer.disabledReason != null)
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
  let effective = initial;
  if (!trusted(initial, primary)) {
    await upsertConfiguration(client, "projects", {
      [primary]: { trust_level: "trusted" },
    });
    effective = await readConfiguration(client, context.cwd);
    if (!trusted(effective, primary))
      throw new Error("Codex primary checkout trust was not established");
  }
  verifyWorkingTrust(effective, context.cwd, worktree);
  await trustHooks(client, context.cwd);
}
