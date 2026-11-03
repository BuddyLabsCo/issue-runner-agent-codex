import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

await test("packs JavaScript and declarations for a Core-contract consumer without a terminal plugin", async (t) => {
  const root = process.cwd();
  const scratch = await mkdtemp(join(root, "package-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath;
  assert.ok(
    npmCli,
    "Run this check through npm so its portable CLI entry is available",
  );
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const npmConfig = join(scratch, "npmrc");
  await writeFile(npmConfig, "");
  const runNpm = (args: string[], cwd: string) =>
    execute(process.execPath, [npmCli, `--userconfig=${npmConfig}`, ...args], {
      cwd,
      env,
    });
  const packed = await runNpm(
    ["pack", "--json", "--pack-destination", scratch],
    root,
  );
  const metadata = JSON.parse(packed.stdout) as {
    filename: string;
    files: { path: string }[];
  }[];
  const artifact = metadata[0]!;
  assert.ok(artifact.files.some(({ path }) => path === "dist/index.js"));
  assert.ok(artifact.files.some(({ path }) => path === "dist/index.d.ts"));
  assert.ok(
    artifact.files.every(
      ({ path }) => !path.startsWith("tests/") && !path.startsWith("src/"),
    ),
  );
  await writeFile(
    join(scratch, "package.json"),
    JSON.stringify({
      name: "contract-consumer",
      private: true,
      type: "module",
    }),
  );
  await runNpm(
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(scratch, artifact.filename),
      resolve("issue-runner-core-contract.1.tgz"),
    ],
    scratch,
  );
  const installed = JSON.parse(
    await readFile(join(scratch, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, unknown> };
  assert.ok(
    !Object.keys(installed.packages).some((name) => name.includes("herdr")),
  );
  await writeFile(
    join(scratch, "consumer.mts"),
    [
      'import type { EnhancementModule } from "issue-runner-core/terminal";',
      'import * as enhancement from "issue-runner-agent-codex";',
      "const contract: EnhancementModule = enhancement;",
      'if (contract.contractVersion !== 1) throw new Error("Wrong contract");',
    ].join("\n"),
  );
  await execute(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "consumer.mts",
    ],
    { cwd: scratch },
  );
  await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { contractVersion, createEnhancement } from "issue-runner-agent-codex"; if (contractVersion !== 1 || typeof createEnhancement !== "function") throw new Error("Invalid exports");',
    ],
    { cwd: scratch },
  );
  const core = await readFile(resolve("issue-runner-core-contract.1.tgz"));
  assert.equal(
    createHash("sha256").update(core).digest("hex"),
    "89faaac1a8b49c12210834cd641def37fc724833862ef35b48e922470ebb5f96",
  );
  const lock = JSON.parse(
    await readFile(resolve("package-lock.json"), "utf8"),
  ) as { packages: Record<string, { version?: string; integrity?: string }> };
  assert.equal(
    lock.packages["node_modules/issue-runner-core"]?.version,
    "0.0.0-contract.1",
  );
  assert.equal(
    lock.packages["node_modules/issue-runner-core"]?.integrity,
    `sha512-${createHash("sha512").update(core).digest("base64")}`,
  );
});
