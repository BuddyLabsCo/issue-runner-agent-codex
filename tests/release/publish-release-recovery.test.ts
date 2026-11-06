import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { test } from "node:test";
import {
  createPublishFixture,
  mergedRelease,
  publishEnvironment,
} from "./support/publish-support.ts";

function integrityOf(tarball: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

// Regression: a run that created the local tag but failed to push it must not
// block every later retry on the existing tag object.
await test("a matching local tag is pushed instead of failing on retry", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.git("tag", "v0.1.1", merge);

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.remoteTag("v0.1.1"), merge);
  assert.deepEqual(fixture.state().release, { tag: "v0.1.1", draft: false });
});

// Regression: a local tag for another commit must not be pushed as this release.
await test("a local tag for another commit is rejected", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.git("tag", "v0.1.1", fixture.git("rev-parse", "HEAD~1"));

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /Local tag v0\.1\.1 points at/);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
});

// Regression: a failed Release write after a successful registry publication
// must report the partial state and a retry must not republish the version.
await test("npm success followed by a GitHub failure resumes without republishing", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureGitHub({ fail: "release create" });

  const failed = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(failed.stderr, /simulated gh release create failure/);
  assert.match(failed.stderr, /Completed stages: npm, tag\./);
  assert.equal(fixture.remoteTag("v0.1.1"), merge);
  assert.equal(fixture.state().release, null);

  fixture.configureGitHub({ fail: "" });
  const retry = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    1,
  );
  assert.equal((fixture.state().release as { draft: boolean }).draft, false);
});

// Regression: a retry after a completed release must reuse the registry
// version, the tag and the Release instead of mutating them again.
await test("a completed release is reused without any further mutation", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  assert.equal(
    fixture.run("publish-release", publishEnvironment(merge, tarball)).status,
    0,
  );
  const githubCalls = fixture.calls("gh").length;

  const retry = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /already complete/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    1,
  );
  const mutations = fixture
    .calls("gh")
    .slice(githubCalls)
    .filter(({ args }) => args[0] === "release" && args[1] !== "view");
  assert.deepEqual(mutations, []);
});

// Regression: the registry already holds the version with identical bytes, so
// the missing tag and Release are completed without a second publication.
await test("a matching registry version is reused and the remaining stages complete", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureNpm({
    registry: { "0.1.1": integrityOf(tarball) },
    latest: "0.1.1",
  });

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), merge);
  assert.deepEqual(fixture.state().release, { tag: "v0.1.1", draft: false });
});

// Regression: registry contents are immutable. Different bytes for the same
// version must stop the release before the tag or Release is written.
await test("a conflicting registry version is rejected without a tag or Release", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureNpm({
    registry: { "0.1.1": "sha512-conflicting" },
    latest: "0.1.1",
  });

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /already published with different contents/);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
});

// Regression: an invalid OIDC publisher must be reported as an actionable
// authorization failure, not as a successful or absent release.
for (const code of ["E401", "E403", "E404"]) {
  await test(`an invalid OIDC publisher (${code}) stops the release without token fallback`, (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureNpm({
      fail: "publish",
      message: `npm error code ${code}\nnpm error publication rejected`,
    });

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball, {
        NODE_AUTH_TOKEN: "test-npm-token",
        NPM_TOKEN: "test-legacy-token",
      }),
    );

    assert.match(result.stderr, /rejected by the registry/);
    assert.match(result.stderr, /Trusted Publisher.*publish-release\.yml/);
    assert.match(result.stderr, /direct publishing.*two-day/);
    assert.match(result.stderr, /No npm token fallback/);
    assert.match(result.stderr, /No publication stages completed\./);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.state().release, null);
    assert.equal(fixture.npmState().latest, "");
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      1,
    );
    assert.ok(fixture.calls("npm").every(({ token }) => !token));
  });
}

for (const prefix of ["npm_config_", "NPM_CONFIG_"]) {
  await test(`failed OIDC cannot fall back to a ${prefix}scoped token`, (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureNpm({ oidcFailure: true });

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball, {
        [`${prefix}//registry.npmjs.org/:_authToken`]: "test-scoped-token",
      }),
    );

    assert.match(result.stderr, /OIDC authorization failed/);
    assert.match(result.stderr, /No publication stages completed/);
    assert.equal(fixture.npmState().latest, "");
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.state().release, null);
    const publish = fixture
      .calls("npm")
      .filter(({ args }) => args[0] === "publish");
    assert.equal(publish.length, 1);
    assert.equal(publish[0]?.token, false);
    assert.ok(!result.stdout.includes("test-scoped-token"));
    assert.ok(!result.stderr.includes("test-scoped-token"));
  });
}

// Regression: the exit status of `npm publish` is the authority for the
// publication stage. Any nonzero exit, not only an authorization rejection,
// must stop before the tag and Release are written.
await test("a failing npm publish stops before the tag and Release", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureNpm({
    fail: "publish",
    message: "npm error code E500\nnpm error the registry rejected the upload",
  });

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(
    result.stderr,
    /npm publish issue-runner-agent-codex@0\.1\.1 failed/,
  );
  assert.match(result.stderr, /registry rejected the upload/);
  assert.match(result.stderr, /No publication stages completed\./);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});

// Regression: a network failure while reading the registry must never be
// mistaken for an unpublished version.
await test("a registry network failure is not treated as an absence", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureNpm({
    fail: "view",
    message:
      "npm error code EAI_AGAIN\nnpm error network request to registry.npmjs.org failed",
  });

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /npm view .* failed \(published integrity\)/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});

// Regression: an interrupted Release publication leaves a draft that a retry
// publishes instead of creating a second Release.
await test("a draft Release is published instead of recreated", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureGitHub({ release: { tag: "v0.1.1", draft: true } });

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  const edits = fixture
    .calls("gh")
    .filter(({ args }) => args[0] === "release" && args[1] === "edit");
  assert.equal(edits.length, 1);
  assert.ok(edits[0]?.args.includes("--draft=false"));
  assert.equal(
    fixture
      .calls("gh")
      .filter(({ args }) => args[0] === "release" && args[1] === "create")
      .length,
    0,
  );
  assert.deepEqual(fixture.state().release, { tag: "v0.1.1", draft: false });
});
