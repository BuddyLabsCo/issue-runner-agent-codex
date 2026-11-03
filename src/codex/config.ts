import { object, type NativeClient } from "./client.ts";

export async function readConfiguration(client: NativeClient, cwd: string) {
  return object(
    await client.request("config/read", { cwd, includeLayers: true }),
  );
}

export async function writeProjectTrust(client: NativeClient, primary: string) {
  return object(
    await client.request("config/value/write", {
      keyPath: "projects",
      value: { [primary]: { trust_level: "trusted" } },
      mergeStrategy: "upsert",
    }),
  );
}
