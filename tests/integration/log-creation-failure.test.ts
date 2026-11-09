import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, nativeFixture } from "../fixtures/native.ts";

await test("log creation failure preserves workflow and diagnostic even without stderr", async (t) => {
  await nativeFixture(t);
  const messages: string[] = [];
  const stderr = t.mock.method(process.stderr, "write", (value: string) => {
    messages.push(value);
    return true;
  });
  t.mock.method(fs, "writeFileSync", () => {
    throw new Error("private disk failure");
  });
  const bound = boundCapabilities();
  for (const unavailableStderr of [false, true]) {
    if (unavailableStderr)
      stderr.mock.mockImplementation(() => {
        throw new Error("stderr unavailable");
      });
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      { logLevel: "info" },
    );
    await instance.stop();
  }
  assert.deepEqual(messages, [
    "[codex] sessionref=unbound log creation failed\n",
  ]);
});
