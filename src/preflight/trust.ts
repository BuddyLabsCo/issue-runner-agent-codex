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

function resolvedTrustWarning(
  warning: Record<string, unknown>,
  effective: Record<string, unknown>,
): boolean {
  if (
    typeof warning.summary !== "string" ||
    warning.details != null ||
    warning.path != null ||
    warning.range != null
  )
    return false;
  // shortcut: Codex 0.166.0 has no warning code; update this format check when native metadata changes.
  const prefix =
    "Project-local config, hooks, and exec policies are disabled in the following folders " +
    "until the project is trusted, but skills still load.\n";
  if (!warning.summary.startsWith(prefix)) return false;
  const details = warning.summary.slice(prefix.length);
  const entries = [
    ...details.matchAll(/^ {4}([1-9]\d*)\. ([^\n]+)\n {7}([^\n]+)\n/gm),
  ];
  const layers = projectLayers(effective);
  return (
    entries.length !== 0 &&
    entries.map((entry) => entry[0]).join("") === details &&
    entries.every(
      (entry, index) =>
        entry[1] === String(index + 1) &&
        layers.some(
          (layer) =>
            object(layer.name).dotCodexFolder === entry[2] &&
            layer.disabledReason == null,
        ),
    )
  );
}

function verifyWarnings(
  client: NativeClient,
  effective: Record<string, unknown>,
  initialWarningCount: number,
): void {
  if (
    client.configurationWarnings.some(
      (warning, index) =>
        index >= initialWarningCount ||
        !resolvedTrustWarning(warning, effective),
    )
  )
    throw new Error(
      "Codex configuration warnings prevent primary checkout trust verification",
    );
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
  const initialWarningCount = client.configurationWarnings.length;
  let effective = initial;
  if (!trusted(initial, primary)) {
    const written = await upsertConfiguration(client, "projects", {
      [primary]: { trust_level: "trusted" },
    });
    if (written.status !== "ok" || written.overriddenMetadata != null)
      throw new Error(
        "Codex primary checkout trust write was overridden or rejected",
      );
    effective = await readConfiguration(client, context.cwd);
    if (!trusted(effective, primary))
      throw new Error("Codex primary checkout trust was not established");
  }
  verifyWorkingTrust(effective, context.cwd, worktree);
  verifyWarnings(client, effective, initialWarningCount);
  await trustHooks(client, context.cwd);
  verifyWarnings(client, effective, initialWarningCount);
}
