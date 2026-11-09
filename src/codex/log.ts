import fs from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnostic } from "../diagnostics.ts";

export type ErrorLog = (event: string, detail: unknown) => void;

export function createLog(cwd: string): ErrorLog {
  let path: string;
  try {
    const directory = resolve(cwd, "..", "..", "..", "logs");
    fs.mkdirSync(directory, { recursive: true });
    path = join(
      directory,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`,
    );
    fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    process.stderr.write(`[codex]: logfile: ${path}\n`);
  } catch {
    diagnostic(undefined, "log creation failed");
    return () => undefined;
  }
  return (event, detail) => {
    try {
      const seen = new WeakSet<object>();
      const record = JSON.stringify(
        { time: new Date().toISOString(), event, detail },
        (_key, value: unknown): unknown => {
          if (typeof value === "bigint") return value.toString();
          if (typeof value !== "object" || value === null) return value;
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
          return value instanceof Error
            ? Object.fromEntries(
                Object.getOwnPropertyNames(value).map((key) => [
                  key,
                  Reflect.get(value, key) as unknown,
                ]),
              )
            : value;
        },
      );
      fs.appendFileSync(path, `${record}\n`);
    } catch {
      diagnostic(undefined, "log write failed");
    }
  };
}
