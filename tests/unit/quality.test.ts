import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

await test("rejects imports across architecture boundaries", async () => {
  const cases: [string, string][] = [
    ["src/codex/client.mjs", "../enhancement.mjs"],
    ["src/codex/nested/client.mjs", "../../monitor/state.mjs"],
    ["src/codex/client.mjs", "../preflight/trust.mjs"],
    ["src/codex/client.mjs", "../session/ready.mjs"],
    ["src/codex/client.mjs", "../recovery/policy.mjs"],
    ["src/recovery/policy.mjs", "../../tests/fixtures/server.mjs"],
    ["src/codex/client.mjs", "../../tests/fixtures/server.mjs"],
    ["src/index.mjs", "../tests/fixtures/server.mjs"],
    ["src/enhancement.mjs", "node:net"],
    ["src/preflight/trust.mjs", "child_process"],
    ["src/session/ready.mjs", "node:net"],
    ["src/monitor/state.mjs", "node:fs/promises"],
    ["src/recovery/policy.mjs", "fs"],
    ["src/config.mjs", "./session/ready.mjs"],
    ["src/diagnostics.mjs", "./recovery/policy.mjs"],
    ["src/config.mjs", "./codex/client.mjs"],
    ["src/diagnostics.mjs", "./enhancement.mjs"],
    ["src/config.mjs", "node:fs/promises"],
    ["src/index.mjs", "issue-runner-core/dist/terminal.js"],
    ["src/index.mjs", "issue-runner-herdr"],
    ["src/codex/client.mjs", "herdr"],
  ];
  for (const [filePath, source] of cases) {
    const [result] = await eslint.lintText(`export * from "${source}";`, {
      filePath,
    });
    assert.ok(
      result?.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
      `${filePath} must reject ${source}`,
    );
  }
});

await test("allows dependencies in the intended direction", async () => {
  const cases: [string, string][] = [
    ["src/index.mjs", 'export * from "./enhancement.mjs";'],
    ["src/enhancement.mjs", 'export * from "./config.mjs";'],
    ["src/enhancement.mjs", 'export * from "./preflight/trust.mjs";'],
    ["src/enhancement.mjs", 'export * from "./session/ready.mjs";'],
    ["src/enhancement.mjs", 'export * from "./monitor/state.mjs";'],
    ["src/enhancement.mjs", 'export * from "./recovery/policy.mjs";'],
    ["src/preflight/trust.mjs", 'export * from "../codex/config.mjs";'],
    ["src/session/ready.mjs", 'export * from "../codex/client.mjs";'],
    ["src/monitor/state.mjs", 'export * from "../codex/client.mjs";'],
    ["src/recovery/policy.mjs", 'export * from "../codex/files.mjs";'],
    ["src/session/ready.mjs", 'export { join, resolve } from "node:path";'],
    ["src/monitor/state.mjs", 'export * from "../diagnostics.mjs";'],
    ["src/codex/client.mjs", 'export * from "../config.mjs";'],
    ["src/codex/client.mjs", 'export * from "../diagnostics.mjs";'],
    ["src/codex/config.mjs", 'export * from "./index.mjs";'],
    ["src/codex/client.mjs", 'export * from "node:net";'],
    ["src/codex/client.mjs", 'export * from "node:fs/promises";'],
    ["src/index.mjs", 'export * from "issue-runner-core/terminal";'],
    [
      "tests/integration/enhancement.mjs",
      'export * from "../../src/index.mjs";',
    ],
  ];
  for (const [filePath, code] of cases) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.deepEqual(result?.messages, [], `${filePath} must allow ${code}`);
  }
});

await test("caps files at 500 code lines, excluding blanks and comments", async () => {
  for (const lines of [500, 501]) {
    const [result] = await eslint.lintText(
      "// Not counted.\n\n" + "export {};\n".repeat(lines),
      { filePath: "src/recovery/large.mjs" },
    );
    assert.equal(
      result?.messages.some((message) => message.ruleId === "max-lines"),
      lines > 500,
    );
  }
});

await test("keeps typed Promise checks enabled in TypeScript tests", async () => {
  const [result] = await eslint.lintText(
    "export async function example() { return 1; }\nexample();",
    { filePath: "tests/unit/quality.test.ts" },
  );
  const ruleIds = result?.messages.map((message) => message.ruleId);
  assert.ok(ruleIds?.includes("@typescript-eslint/no-floating-promises"));
  assert.ok(ruleIds?.includes("@typescript-eslint/require-await"));
});

await test("rejects OS-bound code in implementation, tests and fixtures", async () => {
  const cases: [string, string][] = [
    ['import "node:os";', "no-restricted-imports"],
    ['import "os";', "no-restricted-imports"],
    ['export { win32 } from "node:path";', "no-restricted-imports"],
    ['export { posix } from "path";', "no-restricted-imports"],
    ['export { platform } from "node:process";', "no-restricted-imports"],
    ['export { exec } from "node:child_process";', "no-restricted-imports"],
    ["export const value = process.platform;", "no-restricted-properties"],
    ['export const value = process["platform"];', "no-restricted-properties"],
    ["export const { platform } = process;", "no-restricted-properties"],
    ['export { default } from "node:os";', "no-restricted-imports"],
    ["export const options = { shell: true };", "no-restricted-syntax"],
  ];
  for (const filePath of [
    "src/codex/client.mjs",
    "src/enhancement.mjs",
    "src/preflight/trust.mjs",
    "src/session/ready.mjs",
    "src/monitor/state.mjs",
    "src/recovery/policy.mjs",
    "src/config.mjs",
    "src/diagnostics.mjs",
    "tests/unit/example.mjs",
    "tests/fixtures/server.mjs",
  ]) {
    for (const [code, ruleId] of cases) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.ok(
        result?.messages.some((message) => message.ruleId === ruleId),
        `${filePath} must reject ${code}`,
      );
    }
  }
});
