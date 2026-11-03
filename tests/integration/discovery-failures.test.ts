import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, nativeFixture, thread } from "../fixtures/native.ts";

await test("invalid loaded-thread pages reject readiness without guessing and allow retry", async (t) => {
  const native = await nativeFixture(t);
  for (const page of [
    {},
    { data: [42] },
    { data: [""] },
    { data: [], nextCursor: 42 },
    { data: [], nextCursor: "loop" },
  ]) {
    native.handler = () => page;
    const bound = boundHost();
    const instance = await createEnhancement(
      bound.host,
      { cwd: process.cwd(), env: {} },
      {},
    );
    try {
      await instance.startMonitoring();
      await assert.rejects(
        instance.waitUntilReady(),
        /Invalid Codex loaded threads/,
      );
      native.handler = (request) =>
        request.method === "thread/loaded/list"
          ? { data: ["retry"] }
          : {
              thread: thread("retry", [
                {
                  type: "commandExecution",
                  source: "userShell",
                  command: bound.inputs[0]?.slice(1),
                },
              ]),
            };
      assert.equal(await instance.waitUntilReady(), "retry");
      assert.equal(new Set(bound.inputs).size, 1);
    } finally {
      await instance.stop();
    }
  }
});

await test("a discovered conversation retries failed binding through the same readiness lifecycle", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundHost();
  let failBinding = true;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      return { data: ["retry-binding"] };
    if (request.method === "thread/resume" && failBinding) {
      failBinding = false;
      throw new Error("subscription failed");
    }
    return {
      thread: thread("retry-binding", [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]?.slice(1),
        },
      ]),
    };
  };
  const instance = await createEnhancement(
    bound.host,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    await assert.rejects(instance.waitUntilReady(), /RPC request failed/);
    assert.equal(await instance.waitUntilReady(), "retry-binding");
    assert.equal(new Set(bound.inputs).size, 1);
    assert.equal(
      native.requests.filter(({ method }) => method === "thread/loaded/list")
        .length,
      1,
    );
  } finally {
    await instance.stop();
  }
});
