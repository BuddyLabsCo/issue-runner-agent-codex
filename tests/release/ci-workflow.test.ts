import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileFunction } from "node:vm";

const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const script = / {10}script: \|\n((?: {12}.*\n)+)/.exec(workflow)?.[1];
assert.ok(
  script,
  "CI must classify release merges before running the test matrix",
);
const classify = compileFunction(`return (async () => { ${script} })()`, [
  "github",
  "context",
]) as (github: unknown, context: unknown) => Promise<boolean>;
const context = {
  repo: { owner: "BuddyLabsCo", repo: "issue-runner-agent-codex" },
  sha: "merged-commit",
};
const release = {
  merged_at: "2026-11-06T00:00:00Z",
  merge_commit_sha: context.sha,
  base: {
    ref: "main",
    repo: { full_name: "BuddyLabsCo/issue-runner-agent-codex" },
  },
  head: {
    ref: "auto-release",
    repo: { full_name: "BuddyLabsCo/issue-runner-agent-codex" },
  },
};

for (const [name, pulls, skip] of [
  ["a release merge", [release], true],
  ["a direct push", [], false],
  ["an unmerged release PR", [{ ...release, merged_at: null }], false],
  ["a later push", [{ ...release, merge_commit_sha: "older-commit" }], false],
  ["another target branch", [{ ...release, base: { ref: "other" } }], false],
  [
    "another target repository",
    [
      {
        ...release,
        base: { ...release.base, repo: { full_name: "other/repository" } },
      },
    ],
    false,
  ],
  [
    "an ordinary PR",
    [{ ...release, head: { ...release.head, ref: "feature" } }],
    false,
  ],
  [
    "a fork's auto-release branch",
    [
      {
        ...release,
        head: { ...release.head, repo: { full_name: "fork/core" } },
      },
    ],
    false,
  ],
  [
    "a deleted source repository",
    [{ ...release, head: { ...release.head, repo: null } }],
    false,
  ],
] as const) {
  await test(`main CI classification: ${name}`, async () => {
    const endpoint = {};
    const github = {
      rest: { repos: { listPullRequestsAssociatedWithCommit: endpoint } },
      paginate: (method: unknown, args: unknown) => {
        assert.equal(method, endpoint);
        assert.deepEqual(args, { ...context.repo, commit_sha: context.sha });
        return Promise.resolve(pulls);
      },
    };
    assert.equal(await classify(github, context), skip);
  });
}

await test("release PRs keep pre-merge CI and publication only verifies the candidate", () => {
  assert.match(workflow, /pull_request:/);
  assert.match(
    workflow,
    /github.event_name == 'pull_request' \|\| needs.release-merge.outputs.skip == 'false'/,
  );
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  const publish = readFileSync(
    new URL("../../.github/workflows/publish-release.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    publish,
    /npm test|npm run check|workflow_call|workflow_run|workflow.*CI/,
  );
  assert.match(publish, /release:publish/);
});
