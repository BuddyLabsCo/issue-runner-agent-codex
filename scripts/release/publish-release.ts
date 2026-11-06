// Publishes the npm tarball of a human-merged release pull request and records
// the matching tag and GitHub Release.
//
//   GITHUB_REPOSITORY=<owner/repo> PR_NUMBER=<n> PR_MERGED=true \
//   PR_HEAD_REF=auto-release PR_BASE_REF=main \
//   PR_HEAD_REPOSITORY=<owner/repo> MERGE_SHA=<squash commit> \
//   TARBALL=<packed tarball> \
//     node scripts/release/publish-release.ts
//
// Requires git, gh, and npm in a clean checkout of MERGE_SHA. The tarball must
// have been packed from that same commit after the required checks passed.
// Publication requires GitHub Actions OIDC and the package's trusted publisher.
// Tests: node --test "tests/release/publish-release*.test.ts"
//
// Only a merged pull request from this repository's release branch into the
// target branch may publish, and the merged commit must be a squash or rebase
// result contained in the target branch. Every registry, tag and Release write
// is preceded by read-only validation, and a re-run reuses stages that already
// match the release identity instead of republishing them.
//
// npm exchanges the workflow's OIDC identity at publication. Publication receives
// no stored npm credentials and uses isolated npm configuration.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  LOCKFILE_FILE,
  MANIFEST_FILE,
  PACKAGE_NAME,
  RELEASE_BRANCH,
  REPOSITORY,
  TARGET_BRANCH,
  execute,
  gh,
  git,
  lockfileVersions,
  manifestVersion,
  readJsonText,
  readManifest,
  readTextAt,
  tagName,
  withoutNpmToken,
} from "./release-lib.ts";
import { inspectPackageArtifact } from "./package-artifact.ts";

const completed: string[] = [];

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function isAncestor(commit: string): boolean {
  return (
    execute(
      "git",
      ["merge-base", "--is-ancestor", commit, `origin/${TARGET_BRANCH}`],
      {
        env: withoutNpmToken(),
      },
    ).status === 0
  );
}

// The workflow filters on the release branch; this is the authority that
// rejects every other input before a registry, tag or Release write.
function validateMergedPullRequest(): string {
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  if (repository !== REPOSITORY)
    throw new Error(`Release repository must be ${REPOSITORY}`);
  if (requireEnvironment("PR_MERGED") !== "true") {
    throw new Error("Only a merged pull request can publish a release");
  }
  if (requireEnvironment("PR_HEAD_REF") !== RELEASE_BRANCH) {
    throw new Error(
      `A release must be published from the ${RELEASE_BRANCH} branch`,
    );
  }
  if (requireEnvironment("PR_BASE_REF") !== TARGET_BRANCH) {
    throw new Error(`A release must be merged into ${TARGET_BRANCH}`);
  }
  if (requireEnvironment("PR_HEAD_REPOSITORY") !== repository) {
    throw new Error(
      `A release must come from ${repository}, not ${String(process.env.PR_HEAD_REPOSITORY)}`,
    );
  }
  if (!/^[1-9]\d*$/.test(requireEnvironment("PR_NUMBER")))
    throw new Error("PR_NUMBER must be a positive integer");
  const merge = requireEnvironment("MERGE_SHA");
  if (!/^[a-f0-9]{40}$/.test(merge)) {
    throw new Error(`MERGE_SHA must be a commit SHA, found ${merge}`);
  }
  git(
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${TARGET_BRANCH}:refs/remotes/origin/${TARGET_BRANCH}`,
  );
  const head = git("rev-parse", "HEAD");
  if (head !== merge) {
    throw new Error(
      `Check out the merged release commit ${merge}; the checkout is at ${head}`,
    );
  }
  const [commit, ...parents] = git("rev-list", "--parents", "-n", "1", merge)
    .trim()
    .split(" ");
  if (commit !== merge) {
    throw new Error(`Merge commit ${merge} is not in this checkout`);
  }
  if (parents.length !== 1) {
    throw new Error(
      `Release pull requests must be squashed or rebased into ${TARGET_BRANCH}, not merged with a merge commit`,
    );
  }
  if (!isAncestor(merge)) {
    throw new Error(
      `Merge commit ${merge} is not contained in origin/${TARGET_BRANCH}`,
    );
  }
  return merge;
}

interface Release {
  version: string;
  tag: string;
}

function validateReleaseCommit(merge: string): Release {
  const manifestText = readTextAt(merge, MANIFEST_FILE);
  if (manifestText === null)
    throw new Error(`The release commit does not contain ${MANIFEST_FILE}`);
  const manifest = readManifest(manifestText, "release");
  const version = manifestVersion(manifest, "release");
  if (version === null) {
    throw new Error(`The release ${MANIFEST_FILE} must declare a version`);
  }
  const lockfileText = readTextAt(merge, LOCKFILE_FILE);
  if (lockfileText === null) {
    throw new Error(`The release commit does not contain ${LOCKFILE_FILE}`);
  }
  const locked = lockfileVersions(
    readJsonText(lockfileText, LOCKFILE_FILE),
    "release",
  );
  const mismatched = [
    locked.root === version
      ? null
      : `packages[""] version ${String(locked.root ?? "missing")}`,
    locked.top === version
      ? null
      : `top-level version ${String(locked.top ?? "missing")}`,
  ].filter((problem): problem is string => problem !== null);
  if (mismatched.length > 0) {
    throw new Error(
      `${LOCKFILE_FILE} ${mismatched.join(" and ")} do not match ${MANIFEST_FILE} version ${version}`,
    );
  }
  return { version, tag: tagName(version) };
}

// Publication stays disabled until packaging makes the manifest and the tarball
// publishable; every problem is reported together.
function validateReadiness(
  manifest: Record<string, unknown>,
  committedManifestText: string,
  artifact: ReturnType<typeof inspectPackageArtifact>,
  release: Release,
): void {
  const problems: string[] = [];
  if (manifest.private === true)
    problems.push(`${MANIFEST_FILE} must not be private`);
  if (manifest.name !== PACKAGE_NAME) {
    problems.push(
      `${MANIFEST_FILE} must name ${PACKAGE_NAME}, found ${String(manifest.name)}`,
    );
  }
  const repository = manifest.repository as { url?: unknown } | undefined;
  if (repository?.url !== `git+https://github.com/${REPOSITORY}.git`) {
    problems.push(
      `${MANIFEST_FILE} repository.url must identify ${REPOSITORY}`,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push(`${MANIFEST_FILE} must declare a files allowlist`);
  }
  const engines = manifest.engines;
  if (
    typeof engines !== "object" ||
    engines === null ||
    Array.isArray(engines) ||
    typeof (engines as Record<string, unknown>).node !== "string"
  ) {
    problems.push(`${MANIFEST_FILE} must declare the supported Node engines`);
  }
  if ("bin" in manifest)
    problems.push(
      `${MANIFEST_FILE} must not declare an enhancement executable`,
    );
  for (const file of ["dist/index.js", "dist/index.d.ts", "README.md"]) {
    if (!artifact.files.includes(file))
      problems.push(`the tarball must contain ${file}`);
  }
  if (artifact.files.some((file) => /^(src|tests|scripts)\//.test(file)))
    problems.push(
      "the tarball must not contain source, tests or release scripts",
    );
  if (
    artifact.manifest.name !== PACKAGE_NAME ||
    artifact.manifest.version !== release.version
  ) {
    problems.push(
      `the tarball is ${String(artifact.manifest.name)}@${String(artifact.manifest.version)}, not ${PACKAGE_NAME}@${release.version}`,
    );
  } else if (artifact.manifestText !== committedManifestText) {
    problems.push(
      "the tarball package.json does not match the release commit; pack from the validated commit",
    );
  }
  const scripts = manifest.scripts;
  const acceptance =
    typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)["release:accept"]
      : undefined;
  if (typeof acceptance !== "string" || acceptance.trim().length === 0) {
    problems.push(
      `${MANIFEST_FILE} must declare a release:accept check for the packed artifact`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${PACKAGE_NAME} ${release.version} is not publication-ready:\n- ${problems.join("\n- ")}`,
    );
  }
}

// The package owns installed exports, declarations and runtime-isolation checks.
function acceptCandidate(tarball: string): void {
  const accepted = execute("npm", ["run", "release:accept", "--silent"], {
    env: { ...withoutNpmToken(), RELEASE_TARBALL: resolve(tarball) },
  });
  if (accepted.status !== 0) {
    throw new Error(
      `The packaged acceptance check failed: ${accepted.stderr.trim() || accepted.stdout.trim() || `exit ${String(accepted.status)}`}`,
    );
  }
  console.log("The packaged acceptance check passed.");
}

function viewField(args: string[], label: string): string | null {
  const result = execute("npm", args, { env: withoutNpmToken() });
  if (result.status === 0) return result.stdout.trim();
  const detail = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found/.test(detail)) return null;
  throw new Error(
    `npm ${args.join(" ")} failed (${label}): ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

// The registry is the authority for immutable versions. Any failure other than
// a real 404 is an authentication or network problem, never an absence.
function publishedIntegrity(version: string): string | null {
  const value = viewField(
    ["view", `${PACKAGE_NAME}@${version}`, "dist.integrity", "--json"],
    "published integrity",
  );
  return value === null ? null : (JSON.parse(value) as string);
}

function latestDistTag(): string | null {
  const value = viewField(
    ["view", PACKAGE_NAME, "dist-tags.latest", "--json"],
    "latest dist tag",
  );
  return value === null ? null : (JSON.parse(value) as string);
}

function remoteTagCommit(tag: string): string | null {
  const peeled = git("ls-remote", "origin", `refs/tags/${tag}^{}`).trim();
  const reference =
    peeled.length > 0
      ? peeled
      : git("ls-remote", "origin", `refs/tags/${tag}`).trim();
  return reference.length > 0 ? (reference.split(/\s+/)[0] ?? null) : null;
}

function releaseState(
  tag: string,
): { tagName: string; isDraft: boolean } | null {
  const result = execute(
    "gh",
    ["release", "view", tag, "--json", "tagName,isDraft"],
    {
      env: withoutNpmToken(),
    },
  );
  if (result.status !== 0) {
    if (/not found|HTTP 404|release not found/i.test(result.stderr))
      return null;
    throw new Error(`gh release view ${tag} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as { tagName: string; isDraft: boolean };
}

function publishToRegistry(tarball: string, version: string): void {
  if (
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error(
      "npm Trusted Publishing requires GitHub Actions OIDC identity; grant id-token: write to the publication job on a GitHub-hosted runner. No npm token fallback is supported.",
    );
  }
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? process.cwd(), "release-npm-"),
  );
  try {
    const userConfig = join(directory, "npmrc");
    const globalConfig = join(directory, "global-npmrc");
    writeFileSync(userConfig, "registry=https://registry.npmjs.org/\n");
    writeFileSync(globalConfig, "");
    const environment = withoutNpmToken();
    // npm can fall back to environment credentials even with isolated npmrc files.
    for (const name of Object.keys(environment)) {
      if (/^npm_config_/i.test(name)) delete environment[name];
    }
    const result = execute(
      "npm",
      [
        "publish",
        resolve(tarball),
        "--tag",
        "latest",
        "--access",
        "public",
        "--userconfig",
        userConfig,
        "--globalconfig",
        globalConfig,
      ],
      { env: environment, cwd: directory },
    );
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (
        /E401|E403|E404|ENEEDAUTH|authenticate|permission|oidc/i.test(detail)
      ) {
        throw new Error(
          `npm publish was rejected by the registry: ${detail}\nCheck the issue-runner-agent-codex Trusted Publisher for BuddyLabsCo/issue-runner-agent-codex, workflow publish-release.yml and its environment; verify direct publishing permission, the two-day first-publication window, matching repository.url, Node >=22.14.0 and npm >=11.5.1. No npm token fallback is supported.`,
        );
      }
      throw new Error(
        `npm publish ${PACKAGE_NAME}@${version} failed: ${detail}`,
      );
    }
    completed.push("npm");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function localTagCommit(tag: string): string | null {
  const result = execute(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    { env: withoutNpmToken() },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

// Tags are immutable. Both the remote tag and a local tag left by an earlier
// failed push must identify this release before anything is published.
function validateTag(tag: string, merge: string): void {
  const remote = remoteTagCommit(tag);
  if (remote !== null && remote !== merge) {
    throw new Error(`Tag ${tag} already points at ${remote}, not ${merge}`);
  }
  const local = localTagCommit(tag);
  if (local !== null && local !== merge) {
    throw new Error(`Local tag ${tag} points at ${local}, not ${merge}`);
  }
}

function ensureTag(tag: string, merge: string): void {
  if (remoteTagCommit(tag) === merge) {
    console.log(`Tag ${tag} already points at ${merge}.`);
    return;
  }
  // A previous run may have created the local tag and failed to push it.
  const local = localTagCommit(tag);
  if (local === null) git("tag", tag, merge);
  git("push", "origin", `refs/tags/${tag}`);
  completed.push("tag");
  console.log(
    local === null
      ? `Created tag ${tag} at ${merge}.`
      : `Pushed the existing local tag ${tag} at ${merge}.`,
  );
}

function publishRelease(tag: string, notes: string): void {
  const state = releaseState(tag);
  if (state !== null && !state.isDraft) {
    console.log(`GitHub Release ${tag} is already published.`);
    return;
  }
  if (state === null) {
    gh(
      "release",
      "create",
      tag,
      "--title",
      tag,
      "--notes",
      notes,
      "--verify-tag",
    );
    completed.push("release");
    console.log(`Created GitHub Release ${tag}.`);
    return;
  }
  gh("release", "edit", tag, "--draft=false");
  completed.push("release");
  console.log(`Published the draft GitHub Release ${tag}.`);
}

function main(): void {
  const merge = validateMergedPullRequest();
  const release = validateReleaseCommit(merge);
  const tarball = requireEnvironment("TARBALL");
  const artifact = inspectPackageArtifact(tarball);
  const manifestText = readTextAt(merge, MANIFEST_FILE);
  if (manifestText === null)
    throw new Error(`The release commit does not contain ${MANIFEST_FILE}`);
  validateReadiness(
    readManifest(manifestText, "release"),
    manifestText,
    artifact,
    release,
  );
  acceptCandidate(tarball);

  const published = publishedIntegrity(release.version);
  const latest = latestDistTag();
  if (published !== null) {
    if (published !== artifact.integrity) {
      throw new Error(
        `${PACKAGE_NAME}@${release.version} is already published with different contents (${published}); corrections use a new version`,
      );
    }
    if (latest !== release.version) {
      throw new Error(
        `npm latest points at ${String(latest)}, not ${release.version}; refusing to re-publish a different release`,
      );
    }
    console.log(
      `${PACKAGE_NAME}@${release.version} is already published with the candidate contents.`,
    );
  }

  validateTag(release.tag, merge);
  const state = releaseState(release.tag);
  if (state !== null && state.tagName !== release.tag)
    throw new Error(`GitHub Release identity does not match ${release.tag}`);

  const handoff = {
    package: PACKAGE_NAME,
    version: release.version,
    commit: merge,
    workflowRun: process.env.GITHUB_RUN_ID
      ? `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    artifactName: "verified-codex-release",
    artifact: resolve(tarball),
    integrity: artifact.integrity,
    trustedPublisher: {
      owner: "BuddyLabsCo",
      repository: "issue-runner-agent-codex",
      workflow: "publish-release.yml",
      environment: null,
    },
  };
  writeFileSync(`${tarball}.json`, `${JSON.stringify(handoff, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `verified_tarball=${resolve(tarball)}\n`,
    );
  const summary = `Verified ${PACKAGE_NAME}@${release.version} from ${merge}.\n\nWorkflow: ${handoff.workflowRun ?? "local"}\n\nRetained artifact: ${handoff.artifactName}\n\nCandidate: ${handoff.artifact}\n\nIntegrity: ${artifact.integrity}\n\nTrusted Publisher: BuddyLabsCo / issue-runner-agent-codex / publish-release.yml; no environment.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (
    published === null &&
    viewField(["view", PACKAGE_NAME, "name", "--json"], "package existence") ===
      null
  ) {
    throw new Error(
      "Package is missing: manual bootstrap required. Download the verified-codex-release artifact from this workflow run, publish that exact substantive tarball using npm login and 2FA, configure its Trusted Publisher, then rerun this workflow. Do not rebuild or publish a placeholder.",
    );
  }

  // The exit status of `npm publish` owns the publication stage. A registry can
  // keep reporting the previous `latest` while the new version propagates, so
  // re-reading it here would fail a release whose bytes were published; retries
  // still compare `latest` before reusing an already published version.
  if (published === null) publishToRegistry(tarball, release.version);
  ensureTag(release.tag, merge);
  const notes = gh(
    "pr",
    "view",
    requireEnvironment("PR_NUMBER"),
    "--json",
    "body",
    "--jq",
    ".body",
  );
  publishRelease(release.tag, notes);
  console.log(
    completed.length === 0
      ? `Release ${release.tag} was already complete for ${merge}.`
      : `Published ${release.tag} from ${merge}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    completed.length === 0
      ? "No publication stages completed."
      : `Completed stages: ${completed.join(", ")}. A re-run resumes the missing stages.`,
  );
  process.exitCode = 1;
}
