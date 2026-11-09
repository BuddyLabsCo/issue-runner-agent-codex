import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  bootstrapCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

for (const rpcError of [
  { code: -32601, message: "list_turns is not supported yet" },
  { code: -32603, message: "unclassified native failure" },
]) {
  await test(`candidate history failures preserve discovery rounds: ${rpcError.code}`, async (t) => {
    const native = await nativeFixture(t);
    const bound = bootstrapCapabilities(native, "target");
    let available = false;
    native.handler = (request) => {
      if (request.method === "thread/loaded/list")
        return request.params.cursor
          ? { data: ["target"] }
          : { data: ["unreadable"], nextCursor: "next" };
      if (
        request.method === "thread/read" &&
        (request.params.threadId === "unreadable" || !available)
      ) {
        for (const socket of native.sockets)
          socket.send(JSON.stringify({ id: request.id, error: rpcError }));
        // The error above replaces the fixture's normal result response.
        return new Promise(() => undefined);
      }
      return {
        thread: thread("target", [
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
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let settled = false;
      const waiting = instance.waitUntilReady();
      void waiting.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await flush();
      for (let attempt = 0; attempt < 4; attempt++) {
        t.mock.timers.tick(1_000);
        await flush();
      }
      assert.equal(settled, false);
      assert.ok(
        native.requests.some(
          ({ method, params }) =>
            method === "thread/read" && params.threadId === "target",
        ),
      );
      const inputs = bound.inputs.length;
      available = true;
      t.mock.timers.tick(1_999);
      await flush();
      assert.equal(settled, false);
      assert.equal(bound.inputs.length, inputs);
      t.mock.timers.tick(1);
      await flush();
      for (let attempt = 0; attempt < 2; attempt++) {
        t.mock.timers.tick(1_000);
        await flush();
      }
      assert.equal(await waiting, "target");
      assert.ok(bound.inputs.length > inputs);
      assert.equal(
        new Set(bound.inputs.filter((text) => text.startsWith("!"))).size,
        1,
      );
      assert.deepEqual(
        native.requests
          .filter(({ method }) => method === "thread/resume")
          .map(({ params }) => params.threadId),
        ["target"],
      );
      assert.equal(bound.recoveries, 0);
    } finally {
      await instance.stop();
    }
  });
}

await test("persistent history failures retain a redacted timeout cause and do not leak into the next wait", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native, "target");
  let failing = true;
  let matching = false;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list") return { data: ["target"] };
    if (failing && request.method === "thread/read")
      throw new Error("secret native detail");
    return {
      thread: thread("target", [
        {
          type: "commandExecution",
          source: "userShell",
          command: matching ? bound.inputs[0]?.slice(1) : "unrelated",
        },
      ]),
    };
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  try {
    await instance.startMonitoring();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const waiting = instance.waitUntilReady();
    void waiting.catch(() => undefined);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    t.mock.timers.tick(1_000);
    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Codex readiness timed out.*candidate history read/i,
      );
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "Codex RPC request failed");
      assert.doesNotMatch(String(error) + String(error.cause), /secret/);
      return true;
    });
    assert.equal(
      native.requests.some(({ method }) => method === "thread/resume"),
      false,
    );
    failing = false;
    const retry = instance.waitUntilReady();
    void retry.catch(() => undefined);
    await flush();
    t.mock.timers.tick(3_000);
    await assert.rejects(retry, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Codex readiness timed out");
      assert.equal(error.cause, undefined);
      return true;
    });
    matching = true;
    assert.equal(await instance.waitUntilReady(), "target");
    assert.equal(
      new Set(bound.inputs.filter((text) => text.startsWith("!"))).size,
      1,
    );
  } finally {
    await instance.stop();
  }
});

await test("successful but malformed candidate history still rejects readiness", async (t) => {
  const native = await nativeFixture(t);
  for (const result of [undefined, {}, { thread: thread("wrong-thread") }]) {
    native.handler = (request) =>
      request.method === "thread/loaded/list" ? { data: ["target"] } : result;
    const bound = boundCapabilities();
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    try {
      await instance.startMonitoring();
      await assert.rejects(instance.waitUntilReady(), /Invalid Codex/);
    } finally {
      await instance.stop();
    }
  }
});

await test("loaded-thread enumeration errors still reject readiness", async (t) => {
  const native = await nativeFixture(t);
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      throw new Error("enumeration failed");
    return {};
  };
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    await assert.rejects(instance.waitUntilReady(), /Codex RPC request failed/);
  } finally {
    await instance.stop();
  }
});

await test("a late candidate read failure after stop cannot inspect another candidate", async (t) => {
  const native = await nativeFixture(t);
  let fail!: () => void;
  let received!: () => void;
  const reading = new Promise<void>((resolve) => {
    received = resolve;
  });
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      return { data: ["first", "second"] };
    if (request.method === "thread/read")
      return new Promise((_resolve, reject) => {
        fail = () => reject(new Error("late read failure"));
        received();
      });
    return {};
  };
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
    await reading;
    await instance.stop();
    await waiting;
    fail();
    await flush();
    assert.equal(
      native.requests.some(
        ({ method, params }) =>
          method === "thread/read" && params.threadId === "second",
      ),
      false,
    );
  } finally {
    await instance.stop();
  }
});
