import { object, type NativeClient } from "./client.ts";

export async function readConfiguration(client: NativeClient, cwd: string) {
  try {
    const response = object(
      await client.request("config/read", { cwd, includeLayers: true }),
    );
    object(response.config);
    return response;
  } catch {
    throw new Error("Codex config/read failed");
  }
}

export async function upsertConfiguration(
  client: NativeClient,
  keyPath: string,
  value: Record<string, unknown>,
) {
  try {
    const written = object(
      await client.request("config/value/write", {
        keyPath,
        value,
        mergeStrategy: "upsert",
      }),
    );
    if (written.status !== "ok" && written.status !== "okOverridden")
      throw new Error("Invalid Codex configuration write status");
    return written;
  } catch {
    throw new Error(`Codex config/value/write failed for ${keyPath}`);
  }
}
