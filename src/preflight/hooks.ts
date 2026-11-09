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
  if (pending.length === 0) return;
  await upsertConfiguration(
    client,
    "hooks.state",
    Object.fromEntries(
      pending.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]),
    ),
  );
  const verified = await listHooks(client, cwd);
  if (
    verified.some(
      (hook) =>
        hook.trustStatus !== "trusted" && hook.trustStatus !== "managed",
    )
  )
    throw new Error("Codex hook trust could not be verified");
}
