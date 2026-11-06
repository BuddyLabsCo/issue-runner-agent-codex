import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execute, withoutNpmToken } from "./release-lib.ts";

const temporary = process.env.RUNNER_TEMP;
const output = process.env.GITHUB_OUTPUT;
if (!temporary || !output)
  throw new Error("RUNNER_TEMP and GITHUB_OUTPUT must be set");
const directory = mkdtempSync(join(temporary, "release-"));
const result = execute(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", directory],
  { env: withoutNpmToken() },
);
if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
if (archives.length !== 1)
  throw new Error("Expected exactly one candidate tarball");
appendFileSync(output, `tarball=${join(directory, archives[0]!)}\n`);
