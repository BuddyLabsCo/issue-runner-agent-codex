import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

await test("imports the packed runtime without Core, then checks declarations against registry Core", async (t) => {
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
  const sourceManifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { version: string; keywords?: string[] };
  const keywords = [
    "issue-runner",
    "codex",
    "openai-codex",
    "agent-enhancement",
    "ai-agent",
    "coding-agent",
    "github-issues",
    "workflow-automation",
  ];
  for (const keyword of keywords)
    assert.ok(
      sourceManifest.keywords?.includes(keyword),
      `Missing source keyword: ${keyword}`,
    );
  const artifacts = join(scratch, "artifacts");
  let tarball = process.env.RELEASE_TARBALL;
  if (tarball) {
    tarball = resolve(tarball);
  } else {
    await mkdir(artifacts);
    await runNpm(["pack", "--pack-destination", artifacts], root);
    const archives = (await readdir(artifacts)).filter((name) =>
      name.endsWith(".tgz"),
    );
    assert.equal(archives.length, 1, "Expected exactly one packed archive");
    tarball = join(artifacts, archives[0]!);
  }
  const candidateIntegrity = createHash("sha512")
    .update(await readFile(tarball))
    .digest("hex");
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
      tarball,
    ],
    scratch,
  );
  const installedPackage = join(
    scratch,
    "node_modules/issue-runner-agent-codex",
  );
  assert.ok((await stat(join(installedPackage, "dist/index.js"))).isFile());
  assert.ok((await stat(join(installedPackage, "dist/index.d.ts"))).isFile());
  const installedFiles = await readdir(installedPackage);
  assert.ok(!installedFiles.includes("src"));
  assert.ok(!installedFiles.includes("tests"));
  const installed = JSON.parse(
    await readFile(join(scratch, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, unknown> };
  assert.ok(
    !Object.keys(installed.packages).some((name) => name.includes("herdr")),
  );
  assert.equal(installed.packages["node_modules/issue-runner-core"], undefined);
  const manifest = JSON.parse(
    await readFile(join(installedPackage, "package.json"), "utf8"),
  ) as {
    version: string;
    keywords?: string[];
    repository?: { type: string; url: string };
    exports?: unknown;
    devDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
    optionalDependencies?: unknown;
    bundledDependencies?: unknown;
    bundleDependencies?: unknown;
    bin?: unknown;
    peerDependencies?: unknown;
    peerDependenciesMeta?: unknown;
  };
  assert.equal(manifest.version, sourceManifest.version);
  for (const keyword of keywords)
    assert.ok(
      manifest.keywords?.includes(keyword),
      `Missing packed keyword: ${keyword}`,
    );
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/BuddyLabsCo/issue-runner-agent-codex.git",
  });
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  });
  assert.equal(manifest.devDependencies["issue-runner-core"], "0.1.0");
  assert.equal(manifest.dependencies?.["issue-runner-core"], undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);
  assert.equal(manifest.bin, undefined);
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
      "--save-exact",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "issue-runner-core@0.1.0",
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
  const lock = JSON.parse(
    await readFile(resolve("package-lock.json"), "utf8"),
  ) as {
    version: string;
    packages: Record<
      string,
      {
        version?: string;
        integrity?: string;
        resolved?: string;
        dev?: boolean;
        devDependencies?: Record<string, string>;
      }
    >;
  };
  assert.equal(lock.version, sourceManifest.version);
  assert.equal(lock.packages[""]?.version, sourceManifest.version);
  assert.equal(
    lock.packages[""]?.devDependencies?.["issue-runner-core"],
    "0.1.0",
  );
  const core = lock.packages["node_modules/issue-runner-core"]!;
  assert.equal(
    core.resolved,
    "https://registry.npmjs.org/issue-runner-core/-/issue-runner-core-0.1.0.tgz",
  );
  assert.equal(core.dev, true);
  assert.equal(core.version, "0.1.0");
  assert.match(core.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const consumerLock = JSON.parse(
    await readFile(join(scratch, "package-lock.json"), "utf8"),
  ) as typeof lock;
  assert.equal(
    consumerLock.packages[""]?.devDependencies?.["issue-runner-core"],
    "0.1.0",
  );
  const installedCore =
    consumerLock.packages["node_modules/issue-runner-core"]!;
  assert.equal(installedCore.version, core.version);
  assert.equal(installedCore.resolved, core.resolved);
  assert.equal(installedCore.integrity, core.integrity);
  assert.equal(installedCore.dev, true);
  assert.equal(
    createHash("sha512")
      .update(await readFile(tarball))
      .digest("hex"),
    candidateIntegrity,
    "Package verification must preserve the candidate bytes",
  );
});
