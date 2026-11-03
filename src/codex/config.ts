import { object, type NativeClient } from "./client.ts";

export async function readConfiguration(client: NativeClient, cwd: string) {
  return object(
    await client.request("config/read", { cwd, includeLayers: true }),
  );
}

export async function upsertConfiguration(
  client: NativeClient,
  keyPath: string,
  value: Record<string, unknown>,
) {
  return object(
    await client.request("config/value/write", {
      keyPath,
      value,
      mergeStrategy: "upsert",
    }),
  );
}
