import { resolve } from "node:path";
import { object, type NativeClient } from "./client.ts";

export async function listHooks(client: NativeClient, cwd: string) {
  const response = await client
    .request("hooks/list", { cwds: [cwd] })
    .then(object)
    .catch(() => {
      throw new Error("Codex hooks/list failed");
    });
  if (!Array.isArray(response.data) || response.data.length !== 1)
    throw new Error("Invalid Codex hook inventory");
  const entry = object(response.data[0]);
  if (
    typeof entry.cwd !== "string" ||
    resolve(entry.cwd) !== resolve(cwd) ||
    !Array.isArray(entry.errors) ||
    entry.errors.length !== 0 ||
    !Array.isArray(entry.hooks)
  )
    throw new Error("Codex hook inventory has errors or invalid data");
  const keys = new Set<string>();
  return entry.hooks.map((value: unknown) => {
    const hook = object(value);
    if (
      typeof hook.key !== "string" ||
      !hook.key ||
      typeof hook.currentHash !== "string" ||
      !hook.currentHash ||
      typeof hook.enabled !== "boolean" ||
      typeof hook.isManaged !== "boolean" ||
      typeof hook.trustStatus !== "string" ||
      !["untrusted", "modified", "trusted", "managed"].includes(
        hook.trustStatus,
      ) ||
      hook.isManaged !== (hook.trustStatus === "managed") ||
      keys.has(hook.key)
    )
      throw new Error("Invalid Codex hook metadata");
    keys.add(hook.key);
    return {
      key: hook.key,
      currentHash: hook.currentHash,
      enabled: hook.enabled,
      isManaged: hook.isManaged,
      trustStatus: hook.trustStatus,
    };
  });
}
