import fs from "node:fs/promises";

import type { Log } from "./log.ts";

export async function expectedFileExists(
  path: string,
  log: Log,
): Promise<boolean> {
  log.info("expected-file check", { path });
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}
