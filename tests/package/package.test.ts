import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

await test("imports the packed runtime without Core, then checks declarations against the development artifact", async (t) => {
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
    ],
    scratch,
  );
  const installed = JSON.parse(
    await readFile(join(scratch, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, unknown> };
  assert.ok(
    !Object.keys(installed.packages).some((name) => name.includes("herdr")),
  );
  assert.equal(installed.packages["node_modules/issue-runner-core"], undefined);
  const manifest = JSON.parse(
    await readFile(
      join(scratch, "node_modules/issue-runner-agent-codex/package.json"),
      "utf8",
    ),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: unknown;
    peerDependenciesMeta?: unknown;
  };
  assert.equal(manifest.dependencies?.["issue-runner-core"], undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.peerDependenciesMeta, undefined);
  await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import assert from "node:assert/strict";',
        'import { registerHooks } from "node:module";',
        // Prevent the parent checkout's dev dependency from masking a runtime import.
        'registerHooks({ resolve(specifier, context, next) { if (specifier === "issue-runner-core" || specifier.startsWith("issue-runner-core/")) throw new Error("Runtime must not load Core"); return next(specifier, context); } });',
        'const enhancement = await import("issue-runner-agent-codex");',
        'assert.deepEqual(Object.keys(enhancement).sort(), ["contractVersion", "createEnhancement"]);',
        "assert.equal(enhancement.contractVersion, 2);",
        'assert.equal(typeof enhancement.createEnhancement, "function");',
      ].join("\n"),
    ],
    { cwd: scratch },
  );
  await runNpm(
    [
      "install",
      "--save-dev",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve("issue-runner-core-contract.1.tgz"),
    ],
    scratch,
  );
  await writeFile(
    join(scratch, "consumer.mts"),
    [
      'import type { EnhancementModule } from "issue-runner-core/terminal";',
      'import * as enhancement from "issue-runner-agent-codex";',
      "const contract: EnhancementModule = enhancement;",
      'if (contract.contractVersion !== 2) throw new Error("Wrong contract");',
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
      'import { enhancementContractVersion } from "issue-runner-core/terminal"; import { contractVersion } from "issue-runner-agent-codex"; if (enhancementContractVersion !== 2 || contractVersion !== enhancementContractVersion) throw new Error("Wrong Core artifact");',
    ],
    { cwd: scratch },
  );
  const declarationPath = "node_modules/issue-runner-core/dist/terminal.d.ts";
  assert.equal(
    await readFile(join(root, declarationPath), "utf8"),
    await readFile(join(scratch, declarationPath), "utf8"),
  );
  const core = await readFile(resolve("issue-runner-core-contract.1.tgz"));
  assert.equal(
    createHash("sha256").update(core).digest("hex"),
    "e11ddcc6900158b3f4ab3f91acc461dbd2c7f99ceb295c50c46ddced9310a65a",
  );
  const lock = JSON.parse(
    await readFile(resolve("package-lock.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      { version?: string; integrity?: string; resolved?: string; dev?: boolean }
    >;
  };
  assert.equal(
    lock.packages["node_modules/issue-runner-core"]?.resolved,
    "file:issue-runner-core-contract.1.tgz",
  );
  assert.equal(lock.packages["node_modules/issue-runner-core"]?.dev, true);
  assert.equal(
    lock.packages["node_modules/issue-runner-core"]?.version,
    "0.0.0-contract.1",
  );
  assert.equal(
    lock.packages["node_modules/issue-runner-core"]?.integrity,
    `sha512-${createHash("sha512").update(core).digest("base64")}`,
  );
});
