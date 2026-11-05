import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

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
    const bound = bootstrapCapabilities(native, "retry");
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
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
      assert.equal(
        new Set(bound.inputs.filter((text) => text.startsWith("!"))).size,
        1,
      );
    } finally {
      await instance.stop();
    }
  }
});

await test("GUID detection stops rounds while delayed binding and its current-state read finish", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native, "found");
  let resume!: (value: unknown) => void;
  let current!: (value: unknown) => void;
  let reads = 0;
  const snapshot = () => ({
    thread: thread("found", [
      {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]?.slice(1),
      },
    ]),
  });
  const resuming = new Promise<void>((received) => {
    native.handler = (request) => {
      if (request.method === "thread/loaded/list") return { data: ["found"] };
      if (request.method === "thread/resume")
        return new Promise((resolve) => {
          resume = resolve;
          received();
        });
      if (request.method !== "thread/read") return {};
      if (++reads === 1) return snapshot();
      return new Promise((resolve) => {
        current = resolve;
      });
    };
  });
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let ready = false;
    const waiting = instance.waitUntilReady();
    void waiting.then(
      () => {
        ready = true;
      },
      () => undefined,
    );
    await resuming;
    t.mock.timers.tick(2_100);
    await flush();
    assert.equal(bound.inputs.length, 1);
    native.notify("item/completed", {
      threadId: "found",
      item: {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]?.slice(1),
      },
    });
    await flush();
    assert.equal(ready, false);
    assert.equal(reads, 1);
    resume({});
    await flush();
    assert.equal(reads, 2);
    assert.equal(ready, false);
    current(snapshot());
    assert.equal(await waiting, "found");
  } finally {
    await instance.stop();
  }
});

await test("a discovered conversation retries failed binding through the same readiness lifecycle", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native, "retry-binding");
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
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    await assert.rejects(instance.waitUntilReady(), /RPC request failed/);
    assert.equal(await instance.waitUntilReady(), "retry-binding");
    assert.equal(
      new Set(bound.inputs.filter((text) => text.startsWith("!"))).size,
      1,
    );
    assert.equal(
      native.requests.filter(({ method }) => method === "thread/loaded/list")
        .length,
      1,
    );
  } finally {
    await instance.stop();
  }
});

await test("matching notifications cannot hide a failed subscription or initial current-state read", async (t) => {
  const native = await nativeFixture(t);
  for (const failingMethod of ["thread/resume", "thread/read"]) {
    const bound = bootstrapCapabilities(native, "found");
    const snapshot = () => ({
      thread: thread("found", [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]?.slice(1),
        },
      ]),
    });
    let fail!: () => void;
    let reads = 0;
    const pending = new Promise<void>((received) => {
      native.handler = (request) => {
        if (request.method === "thread/loaded/list") return { data: ["found"] };
        if (request.method === "thread/read" && ++reads === 1)
          return snapshot();
        if (request.method === failingMethod)
          return new Promise((_resolve, reject) => {
            fail = () => reject(new Error("binding failed"));
            received();
          });
        return {};
      };
    });
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    try {
      await instance.startMonitoring();
      let ready = false;
      const waiting = instance.waitUntilReady();
      void waiting.then(
        () => {
          ready = true;
        },
        () => undefined,
      );
      await pending;
      native.notify("item/completed", {
        threadId: "found",
        item: {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]?.slice(1),
        },
      });
      await flush();
      assert.equal(ready, false);
      fail();
      await assert.rejects(waiting, /RPC request failed/);
      native.handler = () => snapshot();
      assert.equal(await instance.waitUntilReady(), "found");
      assert.equal(bound.inputs.length, 2);
    } finally {
      await instance.stop();
    }
  }
});
