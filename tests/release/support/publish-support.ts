import {
  createReleaseFixture,
  type FixtureOptions,
  type ReleaseFixture,
} from "./release-fixture.ts";

export const releaseRepository = "BuddyLabsCo/issue-runner-agent-codex";

export const readyPackage = {
  manifest: {
    name: "issue-runner-agent-codex",
    repository: {
      type: "git",
      url: "git+https://github.com/BuddyLabsCo/issue-runner-agent-codex.git",
    },
    version: "0.1.0",
    description: "Ticket-driven delivery runner",
    license: "MIT",
    type: "module",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    },
    files: ["dist", "README.md"],
    keywords: [
      "issue-runner",
      "codex",
      "openai-codex",
      "agent-enhancement",
      "ai-agent",
      "coding-agent",
      "github-issues",
      "workflow-automation",
    ],
    engines: { node: ">=22.18.0" },
    scripts: { "release:accept": "node scripts/release-accept.mjs" },
  },
  files: {
    "dist/index.js":
      "export const contractVersion = 3; export function createEnhancement() {}\n",
    "dist/index.d.ts": "export declare const contractVersion = 3;\n",
    // This substitute verifies packed runtime bytes; the real package test also checks declarations.
    "scripts/release-accept.mjs": [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { gunzipSync } from "node:zlib";',
      "const bytes = gunzipSync(readFileSync(process.env.RELEASE_TARBALL));",
      "let source;",
      "for (let offset = 0; offset + 512 <= bytes.length;) {",
      "  const header = bytes.subarray(offset, offset + 512);",
      '  const name = header.subarray(0, 100).toString().replace(/\\0[\\s\\S]*$/, "");',
      '  const size = parseInt(header.subarray(124, 136).toString().trim() || "0", 8);',
      '  if (name === "package/dist/index.js") source = bytes.subarray(offset + 512, offset + 512 + size).toString();',
      "  offset += 512 + Math.ceil(size / 512) * 512;",
      "}",
      'assert.ok(source, "Missing packed runtime");',
      'const enhancement = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));',
      "assert.equal(enhancement.contractVersion, 3);",
      'assert.equal(typeof enhancement.createEnhancement, "function");',
      "",
    ].join("\n"),
    "README.md": "# issue-runner-agent-codex\n",
    "CHANGELOG.md": "# Changelog\n",
  },
};

export const releaseBody =
  "## Proposed release 0.1.1\n\n### Changelog\n\n- fix: [issue-7] repair publication\n";

export function createPublishFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = readyPackage,
): ReleaseFixture {
  return createReleaseFixture(t, options);
}

export function publishEnvironment(
  mergeSha: string,
  tarball: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    GITHUB_REPOSITORY: releaseRepository,
    PR_NUMBER: "18",
    PR_MERGED: "true",
    PR_HEAD_REF: "auto-release",
    PR_BASE_REF: "main",
    PR_HEAD_REPOSITORY: releaseRepository,
    MERGE_SHA: mergeSha,
    TARBALL: tarball,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-request-token",
    ...overrides,
  };
}

// A merged release pull request for 0.1.1 and the tarball packed from the
// merged commit, exactly as the publication job provides them.
export function mergedRelease(fixture: ReleaseFixture): {
  merge: string;
  tarball: string;
} {
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();
  fixture.configureGitHub({
    pullRequest: {
      number: "18",
      title: "chore: propose release v0.1.1",
      body: releaseBody,
    },
  });
  return { merge, tarball: fixture.pack(fixture.artifacts) };
}
