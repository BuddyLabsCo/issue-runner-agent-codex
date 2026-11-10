import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, nativeFixture } from "../fixtures/native.ts";

const execute = promisify(execFile);
const spawnGit = childProcess.spawn;

for (const checkout of ["ordinary", "linked"] as const) {
  await test(`factory resolves an actual ${checkout} Git checkout to its primary checkout`, async (t) => {
    const scratch = await mkdtemp(join(process.cwd(), "checkout-test-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const primary = join(scratch, "primary repo.dots");
    await execute("git", ["init", primary]);
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(scratch, "no-hooks")}`,
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: primary },
    );
    let cwd = primary;
    if (checkout === "linked") {
      await execute(
        "git",
        ["worktree", "add", "--detach", join(scratch, "unrelated checkout")],
        { cwd: primary },
      );
      cwd = join(scratch, "task worktree");
      await execute("git", ["worktree", "add", "--detach", cwd], {
        cwd: primary,
      });
    }
    cwd = join(cwd, "task subdirectory");
    await mkdir(cwd);
    const native = await nativeFixture(t, spawnGit);
    native.configuration.projects = {};
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { enhancementPause: boundCapabilities().enhancementPause, cwd, env: {} },
      {},
    );
    try {
      assert.deepEqual(native.configuration.projects, {
        [await realpath(primary)]: { trust_level: "trusted" },
      });
    } finally {
      await instance.stop();
    }
  });
}
