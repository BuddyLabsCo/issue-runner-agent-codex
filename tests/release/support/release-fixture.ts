import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseScripts = fileURLToPath(
  new URL("../../../scripts/release", import.meta.url),
);
export interface CommandCall {
  command: string;
  args: string[];
  body: string | null;
  authConfig?: string | null;
  token: boolean;
}

function readState(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed as Record<string, unknown>;
}

export interface ReleaseFixture {
  cwd: string;
  artifacts: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (path: string, content: string, title: string) => string;
  head: () => string;
  propose: (version: string) => void;
  squashMerge: (message?: string) => string;
  mergeCommit: () => string;
  tag: (tag: string) => void;
  run: (
    script: "auto-release-pr" | "publish-release",
    env?: Record<string, string>,
  ) => { status: number | null; stdout: string; stderr: string };
  runExpectingFailure: (
    script: "auto-release-pr" | "publish-release",
    env?: Record<string, string>,
  ) => { status: number | null; stdout: string; stderr: string };
  calls: (command: "gh" | "npm") => CommandCall[];
  configureGitHub: (patch: Record<string, unknown>) => void;
  configureNpm: (patch: Record<string, unknown>) => void;
  state: () => Record<string, unknown>;
  npmState: () => Record<string, unknown>;
  pack: (directory: string) => string;
  remoteTag: (tag: string) => string;
  remoteHeads: (branch: string) => string;
}

const githubCLI = String.raw`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.RELEASE_GH_STATE;
const logPath = process.env.RELEASE_COMMAND_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const bodyFile = args.includes("--body-file") ? flag("--body-file") : null;
const body = bodyFile ? fs.readFileSync(bodyFile, "utf8") : null;
fs.appendFileSync(logPath, JSON.stringify({ command: "gh", args, body,
  token: Boolean(process.env.GH_TOKEN) }) + "\n");
if (state.fail === args[0] + " " + args[1]) {
  console.error("simulated gh " + state.fail + " failure");
  process.exit(42);
}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === "pr" && args[1] === "list") {
  if (flag("--base") !== "main" || flag("--head") !== "auto-release") process.exit(91);
  if (flag("--state") === "merged") {
    console.log(state.mergedPullRequest
      ? state.mergedPullRequest.mergeCommit.oid : "");
  } else if (flag("--state") === "open") {
    console.log(state.pullRequest ? state.pullRequest.number : "");
  } else process.exit(91);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  if (flag("--json") !== "body") process.exit(92);
  console.log(state.pullRequest.body);
  process.exit(0);
}
if (args[0] === "pr" && (args[1] === "create" || args[1] === "edit")) {
  if (body === null || !flag("--title")) process.exit(93);
  if (args[1] === "create") {
    if (state.pullRequest) process.exit(94);
    state.pullRequest = { number: "17", title: flag("--title"), body };
  } else {
    if (!state.pullRequest || args[2] !== state.pullRequest.number) process.exit(95);
    state.pullRequest.title = flag("--title");
    state.pullRequest.body = body;
  }
  save();
  console.log("https://github.com/BuddyLabsCo/issue-runner-agent-codex/pull/" +
    (args[1] === "create" ? "17" : args[2]));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "view") {
  if (!state.release) { console.error("release not found"); process.exit(1); }
  console.log(JSON.stringify({ tagName: state.release.tag, isDraft: state.release.draft }));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "create") {
  if (state.release || !args.includes("--verify-tag") || !flag("--notes")) process.exit(96);
  state.release = { tag: args[2], draft: args.includes("--draft") };
  save();
  process.exit(0);
}
if (args[0] === "release" && args[1] === "edit") {
  if (!state.release || !args.includes("--draft=false")) process.exit(97);
  state.release.draft = false;
  save();
  process.exit(0);
}
process.exit(90);
`;

const npmCLI = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const statePath = process.env.RELEASE_NPM_STATE;
const logPath = process.env.RELEASE_COMMAND_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const userConfig = args.includes("--userconfig") ? flag("--userconfig") : null;
const authConfig = userConfig && fs.existsSync(userConfig)
  ? fs.readFileSync(userConfig, "utf8") : null;
const scopedToken = process.env["npm_config_//registry.npmjs.org/:_authToken"] ||
  process.env["NPM_CONFIG_//registry.npmjs.org/:_authToken"];
fs.appendFileSync(logPath, JSON.stringify({ command: "npm", args,
  body: null, authConfig, token: Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || scopedToken) }) + "\n");
if (state.fail === args[0] + " " + args[1] || state.fail === args[0]) {
  console.error(state.message || "simulated npm " + state.fail + " failure");
  process.exit(42);
}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === "run") {
  const name = args[1];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const command = manifest.scripts && manifest.scripts[name];
  if (!command) {
    console.error('Missing script: "' + name + '"');
    process.exit(1);
  }
  try {
    if (command !== "node scripts/release-accept.mjs") throw new Error("Unexpected acceptance script");
    execFileSync(process.execPath, ["scripts/release-accept.mjs"], { stdio: "inherit", env: process.env, cwd: process.cwd() });
  } catch (error) {
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
  process.exit(0);
}
if (args[0] === "view") {
  const spec = args[1], field = args[2];
  const separator = spec.lastIndexOf("@");
  const name = separator > 0 ? spec.slice(0, separator) : spec;
  const version = separator > 0 ? spec.slice(separator + 1) : null;
  if (name !== "issue-runner-agent-codex") {
    console.error("npm error code E404\nnpm error 404 Not Found - GET " +
      "https://registry.npmjs.org/" + encodeURIComponent(name));
    process.exit(1);
  }
  if (field === "name") {
    if (state.missingPackage) { console.error("npm error code E404\nnpm error 404 Not Found"); process.exit(1); }
    console.log(JSON.stringify(name));
  } else if (field === "dist-tags.latest") {
    if (!state.latest) {
      console.error("npm error code E404\nnpm error 404 Not Found");
      process.exit(1);
    }
    console.log(JSON.stringify(state.latest));
  } else if (field === "version" || field === "dist.integrity") {
    const published = state.registry[version];
    if (!published) {
      console.error("npm error code E404\nnpm error 404 Not Found - GET " +
        "https://registry.npmjs.org/issue-runner-agent-codex/" + version);
      process.exit(1);
    }
    console.log(JSON.stringify(field === "version" ? version : published));
  } else process.exit(91);
  process.exit(0);
}
if (args[0] === "publish") {
  // npm can fall back to existing registry credentials after OIDC fails.
  if (state.oidcFailure && !scopedToken) {
    console.error("npm error code ENEEDAUTH\nnpm error OIDC authorization failed");
    process.exit(1);
  }
  if (!args.includes("--tag") || args[args.indexOf("--tag") + 1] !== "latest") process.exit(92);
  const tarball = args[1], version = tarball.split("-").at(-1).replace(/\.tgz$/, "");
  if (state.registry[version]) {
    console.error("npm error code E403\nnpm error 403 You cannot publish over the previously published versions");
    process.exit(1);
  }
  state.registry[version] = "sha512-" +
    crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
  // A real registry can keep answering with the previous latest tag for a
  // while after a successful upload; only the exit status is authoritative.
  if (!state.staleLatest) state.latest = version;
  save();
  console.log("+ issue-runner-agent-codex@" + version);
  process.exit(0);
}
process.exit(90);
`;

export interface FixtureOptions {
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}

function defaultManifest(options: FixtureOptions): Record<string, unknown> {
  return (
    options.manifest ?? {
      name: "issue-runner-agent-codex",
      private: true,
      type: "module",
    }
  );
}

export function createReleaseFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = {},
): ReleaseFixture {
  const root = mkdtempSync(path.join(process.cwd(), "release-script-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const bin = path.join(root, "bin");
  const githubState = path.join(root, "gh-state.json");
  const npmState = path.join(root, "npm-state.json");
  const log = path.join(root, "commands.jsonl");
  mkdirSync(cwd);
  mkdirSync(bin);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: "test-token",
    RELEASE_GH_STATE: githubState,
    RELEASE_NPM_STATE: npmState,
    RELEASE_COMMAND_LOG: log,
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }

  writeFileSync(
    githubState,
    JSON.stringify({
      pullRequest: null,
      mergedPullRequest: null,
      release: null,
      fail: "",
    }),
  );
  writeFileSync(
    npmState,
    JSON.stringify({
      registry: {},
      latest: "",
      staleLatest: false,
      fail: "",
      message: "",
    }),
  );
  writeFileSync(log, "");
  writeFileSync(path.join(root, "gitconfig"), "");
  mkdirSync(path.join(root, "hooks"));
  writeFileSync(path.join(bin, "gh.cjs"), githubCLI);
  writeFileSync(path.join(bin, "npm.cjs"), npmCLI);
  const hook = path.join(root, "command-hook.mjs");
  writeFileSync(
    hook,
    [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { join } from "node:path";',
      "const original = childProcess.spawnSync;",
      "childProcess.spawnSync = (command, args, options) => {",
      '  if (command === process.execPath && args[0] === process.env.npm_execpath) { command = "npm"; args = args.slice(1); }',
      '  if (command === "gh" || command === "npm")',
      `    return original(process.execPath, [join(${JSON.stringify(bin)}, command + ".cjs"), ...args], options);`,
      "  return original(command, args, options);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"),
  );

  const exec = (command: string, args: string[]) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  const git = (...args: string[]): string => {
    const result = exec("git", args);
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")}: ${result.stderr || result.error}`,
    );
    return result.stdout.trim();
  };
  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };

  git("init", "--bare", "-b", "main", origin);
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(root, "hooks"));
  git("remote", "add", "origin", origin);

  const manifest = defaultManifest(options);
  const version = manifest.version;
  const lockfile: Record<string, unknown> = {
    name: manifest.name,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        ...(typeof version === "string" ? { version } : {}),
      },
    },
  };
  write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write("package-lock.json", `${JSON.stringify(lockfile, null, 2)}\n`);
  for (const [file, content] of Object.entries(options.files ?? {})) {
    write(file, content);
  }
  git("add", ".");
  git("commit", "-m", "Initial implementation");
  git("push", "-u", "origin", "main");

  const commit = (file: string, content: string, title: string): string => {
    const before = git("rev-parse", "HEAD");
    write(file, content);
    git("add", ".");
    git("commit", "-m", title);
    return before;
  };

  const pack = (directory: string): string => {
    mkdirSync(directory, { recursive: true });
    assert.ok(process.env.npm_execpath, "Run release tests through npm");
    const result = spawnSync(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--pack-destination",
        directory,
        "--ignore-scripts",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...env },
      },
    );
    assert.equal(result.status, 0, `npm pack: ${result.stderr}`);
    return path.join(directory, result.stdout.trim().split("\n").at(-1) ?? "");
  };

  const bumpVersion = (version: string): void => {
    const manifest = JSON.parse(
      readFileSync(path.join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.version = version;
    write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    const lockfile = JSON.parse(
      readFileSync(path.join(cwd, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, Record<string, unknown>> };
    lockfile.packages[""] = { ...lockfile.packages[""], version };
    write(
      "package-lock.json",
      `${JSON.stringify({ ...lockfile, version }, null, 2)}\n`,
    );
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    const changelog = existsSync(changelogPath)
      ? readFileSync(changelogPath, "utf8")
      : "# Changelog\n";
    write(
      "CHANGELOG.md",
      `${changelog.trimEnd()}\n\n## ${version}\n\n- chore: release ${version}\n`,
    );
  };

  const run = (
    script: "auto-release-pr" | "publish-release",
    overrides: Record<string, string> = {},
  ) => {
    const result: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(hook).href,
        path.join(releaseScripts, `${script}.ts`),
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...env, ...overrides },
      },
    );
    assert.equal(
      result.error,
      undefined,
      "The script must finish without a spawn error",
    );
    return result;
  };

  return {
    cwd,
    artifacts: path.join(root, "artifacts"),
    git,
    write,
    commit,
    head: () => git("rev-parse", "HEAD"),
    propose: (version) => {
      git("checkout", "-b", "auto-release");
      bumpVersion(version);
      git("add", ".");
      git("commit", "-m", `chore: propose release v${version}`);
      git("push", "origin", "auto-release");
      git("checkout", "main");
    },
    squashMerge: (message = "chore: propose release") => {
      git("merge", "--squash", "auto-release");
      git("commit", "-m", message);
      git("push", "origin", "main");
      return git("rev-parse", "HEAD");
    },
    mergeCommit: () => {
      git("merge", "--no-ff", "auto-release", "-m", "chore: propose release");
      git("push", "origin", "main");
      return git("rev-parse", "HEAD");
    },
    tag: (tag) => {
      git("tag", tag);
      git("push", "origin", tag);
    },
    run,
    runExpectingFailure: (script, overrides = {}) => {
      const result = run(script, overrides);
      assert.notEqual(result.status, 0, "The release script must fail closed");
      return result;
    },
    calls: (command) =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CommandCall)
        .filter((call) => call.command === command),
    configureGitHub: (patch) => {
      const current = JSON.parse(readFileSync(githubState, "utf8")) as object;
      writeFileSync(githubState, JSON.stringify({ ...current, ...patch }));
    },
    configureNpm: (patch) => {
      const current = JSON.parse(readFileSync(npmState, "utf8")) as object;
      writeFileSync(npmState, JSON.stringify({ ...current, ...patch }));
    },
    state: () => readState(githubState),
    npmState: () => readState(npmState),
    pack,
    remoteTag: (tag) =>
      git("ls-remote", "origin", `refs/tags/${tag}`).split(/\s+/)[0] ?? "",
    remoteHeads: (branch) =>
      git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0] ?? "",
  };
}
