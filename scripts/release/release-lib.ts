import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const REPOSITORY = "BuddyLabsCo/issue-runner-agent-codex";
export const RELEASE_BRANCH = "auto-release";
export const TARGET_BRANCH = "main";
export const PACKAGE_NAME = "issue-runner-agent-codex";
export const MANIFEST_FILE = "package.json";
export const LOCKFILE_FILE = "package-lock.json";
export const CHANGELOG_FILE = "CHANGELOG.md";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

// Routine releases use OIDC; never pass legacy npm publication tokens to tools.
export function withoutNpmToken(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...environment };
  delete copy.NODE_AUTH_TOKEN;
  delete copy.NPM_TOKEN;
  return copy;
}

export function execute(
  command: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult {
  if (command === "npm") {
    const cli = process.env.npm_execpath;
    if (!cli)
      throw new Error(
        "Run release scripts through npm so its portable CLI entry is available",
      );
    args = [cli, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: 300_000,
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} could not start: ${result.error.message}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function run(command: string, args: string[]): string {
  const result = execute(command, args, { env: withoutNpmToken() });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export const git = (...args: string[]): string => run("git", args);
export const gh = (...args: string[]): string => run("gh", args);

export function requireVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(
      `${label} must be a three-part release version, found ${String(value)}`,
    );
  }
  return value;
}

export function compareVersions(left: string, right: string): number {
  const a = requireVersion(left, "left version").split(".").map(BigInt);
  const b = requireVersion(right, "right version").split(".").map(BigInt);
  for (let part = 0; part < 3; part += 1) {
    const difference = (a[part] ?? 0n) - (b[part] ?? 0n);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

export function incrementPatch(version: string): string {
  const [major, minor, patch] = requireVersion(version, "version").split(".");
  return `${major}.${minor}.${BigInt(patch ?? "0") + 1n}`;
}

export function tagName(version: string): string {
  return `v${version}`;
}

export function readJsonText(
  text: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function readManifest(
  text: string,
  label: string,
): Record<string, unknown> {
  return readJsonText(text, `${label} ${MANIFEST_FILE}`);
}

export function manifestVersion(
  manifest: Record<string, unknown>,
  label: string,
): string | null {
  if (!("version" in manifest)) return null;
  return requireVersion(manifest.version, `${label} ${MANIFEST_FILE} version`);
}

export interface LockfileVersions {
  root: string | null;
  top: string | null;
}

// `npm install` mirrors the root package version into both lockfile locations,
// so a release must agree with both of them.
export function lockfileVersions(
  lockfile: Record<string, unknown>,
  label: string,
): LockfileVersions {
  let rootVersion: string | null = null;
  const packages = lockfile.packages;
  if (
    typeof packages === "object" &&
    packages !== null &&
    !Array.isArray(packages)
  ) {
    const root = (packages as Record<string, unknown>)[""];
    if (typeof root === "object" && root !== null && !Array.isArray(root)) {
      const candidate = root as Record<string, unknown>;
      if ("version" in candidate) {
        rootVersion = requireVersion(
          candidate.version,
          `${label} ${LOCKFILE_FILE} packages version`,
        );
      }
    }
  }
  const topVersion =
    "version" in lockfile
      ? requireVersion(lockfile.version, `${label} ${LOCKFILE_FILE} version`)
      : null;
  return { root: rootVersion, top: topVersion };
}

export function writeManifestVersion(version: string): void {
  const manifest = readManifest(readFileSync(MANIFEST_FILE, "utf8"), "current");
  manifest.version = version;
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function writeLockfileVersion(version: string): void {
  const lockfile = readJsonText(
    readFileSync(LOCKFILE_FILE, "utf8"),
    LOCKFILE_FILE,
  );
  lockfile.version = version;
  const packages = lockfile.packages;
  if (
    typeof packages === "object" &&
    packages !== null &&
    !Array.isArray(packages)
  ) {
    const root = (packages as Record<string, unknown>)[""];
    if (typeof root === "object" && root !== null && !Array.isArray(root)) {
      (root as Record<string, unknown>).version = version;
    }
  }
  writeFileSync(LOCKFILE_FILE, `${JSON.stringify(lockfile, null, 2)}\n`);
}

export function latestReleasedVersion(): string | null {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .filter(Boolean);
  let latest: string | null = null;
  for (const tag of tags) {
    const version = tag.slice(1);
    if (!versionPattern.test(version)) continue;
    if (latest === null || compareVersions(version, latest) > 0)
      latest = version;
  }
  return latest;
}

export function readTextAt(ref: string | null, file: string): string | null {
  if (ref !== null) {
    // `git show` output is the blob exactly; trimming would break byte identity.
    const result = execute("git", ["show", `${ref}:${file}`], {
      env: withoutNpmToken(),
    });
    if (result.status !== 0) {
      throw new Error(
        `git show ${ref}:${file} failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  }
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// A release proposal owns one version section per proposed version; earlier
// sections stay exactly as the merged history recorded them.
export function renderChangelog(
  existing: string | null,
  version: string,
  entries: string[],
): string {
  const lines = (existing ?? "# Changelog\n").trimEnd().split("\n");
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const preamble = (firstSection === -1 ? lines : lines.slice(0, firstSection))
    .join("\n")
    .trimEnd();
  const sections =
    firstSection === -1
      ? []
      : lines
          .slice(firstSection)
          .join("\n")
          .trimEnd()
          .split(/\n(?=## )/);
  const proposedSection = new RegExp(
    `^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`,
  );
  const kept = sections.filter((section) => !proposedSection.test(section));
  const body = entries.map((entry) => `- ${entry}`).join("\n");
  return `${[preamble, `## ${version}`, body, ...kept]
    .filter((part) => part.length > 0)
    .join("\n\n")}\n`;
}
