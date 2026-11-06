import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectPackageArtifact } from "../../scripts/release/package-artifact.ts";

await test("workflow packing retains the built candidate without rebuilding it", (t) => {
  const directory = mkdtempSync(join(process.cwd(), "release-pack-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "issue-runner-agent-codex",
      version: "0.1.0",
      scripts: { prepack: 'node -e "process.exit(99)"' },
    }),
  );
  writeFileSync(join(directory, "README.md"), "Already built candidate\n");
  const output = join(directory, "output");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: output,
  };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/release/pack-candidate.ts", import.meta.url),
      ),
    ],
    { cwd: directory, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const tarball = readFileSync(output, "utf8").trim().slice("tarball=".length);
  const artifact = inspectPackageArtifact(tarball);
  assert.equal(artifact.manifest.version, "0.1.0");
  assert.ok(artifact.files.includes("README.md"));
});
