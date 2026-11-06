// Opens or refreshes the single release pull request for release-eligible
// pushes to the target branch.
//
//   PUSH_BEFORE=<push event before SHA> GH_TOKEN=<token> \
//     node scripts/release/auto-release-pr.ts
//
// Requires git and an authenticated `gh` in a clean checkout of the target
// branch with full history and tags. Tests:
//   node --test tests/release/auto-release-pr.test.ts
//
// The script owns release eligibility, the proposed version, the changelog and
// the pull request contents. The workflow only supplies the event and the
// GitHub App token, so the same entry point runs outside Actions.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHANGELOG_FILE,
  LOCKFILE_FILE,
  MANIFEST_FILE,
  PACKAGE_NAME,
  RELEASE_BRANCH,
  REPOSITORY,
  TARGET_BRANCH,
  compareVersions,
  gh,
  git,
  incrementPatch,
  latestReleasedVersion,
  manifestVersion,
  readManifest,
  readTextAt,
  renderChangelog,
  requireVersion,
  tagName,
  writeLockfileVersion,
  writeManifestVersion,
} from "./release-lib.ts";

const releasePaths = new Set([MANIFEST_FILE, LOCKFILE_FILE, CHANGELOG_FILE]);

// The proposal's own commit subject. A squash merge keeps the pull request
// title and a rebase keeps the commit message, so the release merge can be
// recognized even when the first proposal does not change the seeded version.
const releaseSubject = /^chore: propose release v\d+\.\d+\.\d+(?: \(#\d+\))?$/;

// Release commits are authored by the automation identity, not by whatever the
// runner happens to have configured.
const botIdentity = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

function changedPaths(before: string): string[] {
  const output = /^0+$/.test(before)
    ? git("ls-tree", "-r", "--name-only", "-z", "HEAD")
    : git("diff", "--no-renames", "--name-only", "-z", before, "HEAD");
  return output.split("\0").filter(Boolean);
}

// The merged release pull request identifies the release merge even when a
// human edited the squash title or a rebase left a later maintainer commit at
// the tip of the branch.
function mergedReleaseCommit(): string | null {
  const commit = gh(
    "pr",
    "list",
    "--base",
    TARGET_BRANCH,
    "--head",
    RELEASE_BRANCH,
    "--state",
    "merged",
    "--limit",
    "1",
    "--json",
    "mergeCommit",
    "--jq",
    ".[0].mergeCommit.oid // empty",
  );
  return commit.length > 0 ? commit : null;
}

// A push that only lands a release proposal is the release merge itself and
// must not propose the next version. Ordinary dependency-only changes to the
// manifest and lockfile stay release content.
function isReleaseEligible(
  paths: string[],
  head: string,
  headSubject: string,
): boolean {
  if (!paths.some((path) => !path.startsWith(".github/"))) return false;
  if (!paths.every((path) => releasePaths.has(path))) return true;
  return head !== mergedReleaseCommit() && !releaseSubject.test(headSubject);
}

function nextVersion(latest: string | null, current: string | null): string {
  if (latest === null) {
    return current !== null && compareVersions(current, "0.1.0") > 0
      ? current
      : "0.1.0";
  }
  // A manifest version ahead of the latest release is a maintainer decision;
  // increment only when the manifest matches what is already released.
  if (current !== null && compareVersions(current, latest) > 0) return current;
  return incrementPatch(latest);
}

function currentVersion(): string | null {
  const text = readTextAt(null, MANIFEST_FILE);
  if (text === null) throw new Error(`current ${MANIFEST_FILE} is missing`);
  return manifestVersion(readManifest(text, "current"), "current");
}

function proposedVersion(): string {
  git(
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`,
  );
  const manifest = readManifest(
    git("show", `origin/${RELEASE_BRANCH}:${MANIFEST_FILE}`),
    "proposed",
  );
  return requireVersion(manifest.version, `proposed ${MANIFEST_FILE} version`);
}

function releaseBody(
  version: string,
  entries: string[],
  base: string | null,
): string {
  return [
    `## Proposed release ${version}`,
    "",
    `Changelog base: ${base ?? "the repository root"}.`,
    "",
    "### Changelog",
    "",
    entries.join("\n"),
    "",
    "---",
    "",
    `This pull request is created for release-eligible pushes to \`${TARGET_BRANCH}\` and refreshed for every push while it stays open.`,
    `Merging it publishes the tested \`${PACKAGE_NAME}\` tarball, creates the \`${tagName(version)}\` tag and the matching GitHub Release.`,
    "The release merge never creates the next proposal, and a maintainer-proposed version is preserved.",
    "Squash or rebase this pull request: publication rejects a merge commit, and only this branch publishes.",
  ].join("\n");
}

function main(): void {
  if (
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_REPOSITORY !== REPOSITORY
  )
    throw new Error(`Release repository must be ${REPOSITORY}`);
  if (git("branch", "--show-current") !== TARGET_BRANCH)
    throw new Error(`Release proposals require ${TARGET_BRANCH}`);
  const before = process.env.PUSH_BEFORE;
  if (!before || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(before)) {
    throw new Error("PUSH_BEFORE must be the push event before commit SHA");
  }
  if (git("status", "--porcelain", "--untracked-files=no").length > 0) {
    throw new Error(
      "The checkout must be clean before preparing a release proposal",
    );
  }

  const paths = changedPaths(before);
  const current = currentVersion();
  const head = git("rev-parse", "HEAD");
  const eligible = isReleaseEligible(
    paths,
    head,
    git("log", "-1", "--pretty=%s", "HEAD"),
  );
  const openPullRequest = gh(
    "pr",
    "list",
    "--base",
    TARGET_BRANCH,
    "--head",
    RELEASE_BRANCH,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  );

  // Ignored paths prevent a new proposal; they never stop refreshing an open one.
  if (!eligible && openPullRequest.length === 0) {
    console.log("No release-eligible changes; skipping release preparation.");
    return;
  }

  const latest = latestReleasedVersion();
  const version = openPullRequest
    ? proposedVersion()
    : nextVersion(latest, current);
  const base = latest === null ? null : tagName(latest);
  const entries = git(
    "log",
    "--no-merges",
    "--pretty=format:- %s",
    base === null ? "HEAD" : `${base}..HEAD`,
  )
    .split("\n")
    .filter(Boolean);
  const body = releaseBody(version, entries, base);
  const title = `chore: propose release ${tagName(version)}`;

  if (eligible) {
    git("checkout", "-B", RELEASE_BRANCH);
    writeManifestVersion(version);
    writeLockfileVersion(version);
    writeFileSync(
      CHANGELOG_FILE,
      renderChangelog(readTextAt(null, CHANGELOG_FILE), version, entries),
    );
    git("add", MANIFEST_FILE, LOCKFILE_FILE, CHANGELOG_FILE);
    if (git("diff", "--cached", "--name-only").length > 0) {
      git(
        "-c",
        `user.name=${botIdentity.name}`,
        "-c",
        `user.email=${botIdentity.email}`,
        "commit",
        "-m",
        title,
      );
      git("push", "--force", "origin", RELEASE_BRANCH);
    }
  }

  const temporary = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? process.cwd(), "release-proposal-"),
  );
  try {
    const bodyFile = join(temporary, "body.md");
    writeFileSync(bodyFile, body);
    if (openPullRequest.length > 0) {
      gh(
        "pr",
        "edit",
        openPullRequest,
        "--title",
        title,
        "--body-file",
        bodyFile,
      );
    } else {
      gh(
        "pr",
        "create",
        "--base",
        TARGET_BRANCH,
        "--head",
        RELEASE_BRANCH,
        "--title",
        title,
        "--body-file",
        bodyFile,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
