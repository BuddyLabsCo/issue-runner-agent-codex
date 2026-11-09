import fs from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, nativeFixture, thread } from "./native.ts";

export function failedThread(error: unknown = null) {
  const snapshot = thread();
  return {
    ...snapshot,
    turns: [{ ...snapshot.turns[0]!, id: "failed-1", status: "failed", error }],
  };
}

export async function recoveryFixture(t: TestContext, config: unknown = {}) {
  const cwd = process.cwd();
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    if (value.startsWith("[codex] ")) stderr.push(value);
    return true;
  });
  const state = { snapshot: failedThread() };
  const files = new Set<string>();
  const fileReads: string[] = [];
  t.mock.method(fs, "access", (path: string) => {
    fileReads.push(path);
    return files.has(path)
      ? Promise.resolve()
      : Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
  });
  native.handler = (request) =>
    request.method.startsWith("thread/") ? { thread: state.snapshot } : {};
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd, env: {} },
    config,
  );
  t.after(() => instance.stop());
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const expectedFile = join(cwd, "handoff.json");
  instance.onAssignment({ id: "assignment-1", expectedFile });
  return {
    native,
    bound,
    instance,
    state,
    stderr,
    expectedFile,
    cwd,
    files,
    fileReads,
  };
}
