import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublishFixture,
  mergedRelease,
  publishEnvironment,
  readyPackage,
} from "./support/publish-support.ts";

await test("a matching event from another repository cannot publish Codex enhancement", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball, {
      GITHUB_REPOSITORY: "attacker/core",
      PR_HEAD_REPOSITORY: "attacker/core",
    }),
  );
  assert.match(
    result.stderr,
    /Release repository must be BuddyLabsCo\/issue-runner-agent-codex/,
  );
  assert.deepEqual(fixture.calls("npm"), []);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
});

await test("candidate repository metadata must identify Codex enhancement", (t) => {
  const fixture = createPublishFixture(t, {
    ...readyPackage,
    manifest: {
      ...readyPackage.manifest,
      repository: {
        type: "git",
        url: "git+https://github.com/attacker/core.git",
      },
    },
  });
  const { merge, tarball } = mergedRelease(fixture);
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.match(
    result.stderr,
    /repository.url must identify BuddyLabsCo\/issue-runner-agent-codex/,
  );
  assert.equal(
    fixture.calls("npm").some(({ args }) => args[0] === "publish"),
    false,
  );
});

await test("a rebased same-repository release publishes the actual main commit", (t) => {
  const fixture = createPublishFixture(t);
  fixture.propose("0.1.1");
  fixture.commit(
    "README.md",
    "# Codex enhancement\n\nMain advanced.\n",
    "docs: update main",
  );
  fixture.git("checkout", "auto-release");
  fixture.git("rebase", "main");
  fixture.git("checkout", "main");
  fixture.git("merge", "--ff-only", "auto-release");
  fixture.git("push", "origin", "main");
  fixture.configureGitHub({
    pullRequest: { number: "18", body: "Codex enhancement release" },
  });
  const merge = fixture.head();
  const tarball = fixture.pack(fixture.artifacts);
  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.remoteTag("v0.1.1"), merge);
});

await test("a GitHub Release with another identity is rejected before publishing", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureGitHub({ release: { tag: "v9.0.0", draft: true } });
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.match(result.stderr, /GitHub Release identity does not match v0.1.1/);
  assert.equal(
    fixture.calls("npm").some(({ args }) => args[0] === "publish"),
    false,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
});

await test("recovery rejects matching registry bytes with a different latest version", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  assert.equal(
    fixture.run("publish-release", publishEnvironment(merge, tarball)).status,
    0,
  );
  fixture.configureNpm({ latest: "0.2.0" });
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.match(result.stderr, /npm latest points at 0.2.0, not 0.1.1/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    1,
  );
});
