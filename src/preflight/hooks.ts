import type { NativeClient } from "../codex/client.ts";
import { listHooks } from "../codex/hooks.ts";
import { upsertConfiguration } from "../codex/config.ts";

export async function trustHooks(
  client: NativeClient,
  cwd: string,
): Promise<void> {
  const hooks = await listHooks(client, cwd);
  const pending = hooks.filter(
    (hook) =>
      hook.trustStatus === "untrusted" || hook.trustStatus === "modified",
  );
  if (pending.length !== 0) {
    const written = await upsertConfiguration(
      client,
      "hooks.state",
      Object.fromEntries(
        pending.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]),
      ),
    );
    if (written.status !== "ok" || written.overriddenMetadata != null)
      throw new Error("Codex hook trust write was overridden or rejected");
  }
  const verified = await listHooks(client, cwd);
  const byKey = new Map(verified.map((hook) => [hook.key, hook]));
  if (
    verified.length !== hooks.length ||
    hooks.some((hook) => {
      const current = byKey.get(hook.key);
      return (
        current?.currentHash !== hook.currentHash ||
        current.enabled !== hook.enabled ||
        current.isManaged !== hook.isManaged ||
        current.trustStatus !== (hook.isManaged ? "managed" : "trusted")
      );
    })
  )
    throw new Error("Codex hook trust could not be verified");
}
