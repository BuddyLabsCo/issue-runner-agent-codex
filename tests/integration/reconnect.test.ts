import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("observation retries every ten seconds without a business budget or daemon restart", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    if (value.startsWith("[codex] ")) stderr.push(value);
    return true;
  });
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    {
      enhancementPause: bound.enhancementPause,
      cwd: process.cwd(),
      env: { RECONNECT_FIXTURE: "retained" },
    },
    { retryLimit: 0, retryDelay: [0] },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  native.handler = () => {
    throw new Error("private credentials and payload");
  };
  native.sockets[0]!.close(1011, "private close reason");
  await flush();
  for (let attempt = 0; attempt < 5; attempt++) {
    t.mock.timers.tick(9_999);
    await flush();
    assert.equal(native.proxies.length, 1 + attempt);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(native.proxies.length, 2 + attempt);
    assert.equal(native.sockets.at(-1)?.readyState, 3);
  }
  assert.deepEqual(stderr, [
    "[codex] sessionref=known observation disconnected\n",
    ...Array<string>(5).fill(
      "[codex] sessionref=known observation reconnect failed\n",
    ),
  ]);
  assert.equal(
    native.launches.filter(({ args }) => args.includes("daemon")).length,
    1,
  );
  assert.ok(
    native.launches.every(
      ({ options }) =>
        options.cwd === process.cwd() &&
        options.env?.RECONNECT_FIXTURE === "retained",
    ),
  );
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(bound.inputs, []);
  await Promise.all([instance.stop(), instance.stop()]);
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(native.proxies.length, 6);
});

await test("reattachment stays unavailable until refreshed and retains the ref, GUID and notification filtering", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { retryLimit: 0 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lost = assert.rejects(instance.waitUntilReady(), /unavailable/);
  await flush();
  const marker = bound.inputs[0]!;
  native.sockets[0]!.close();
  await lost;
  let release!: (value: unknown) => void;
  const reading = new Promise<void>((received) => {
    native.handler = (request) => {
      if (request.method !== "thread/read") return {};
      received();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
  });
  t.mock.timers.tick(10_000);
  await reading;
  let unavailable: unknown;
  const duringRefresh = instance.waitUntilReady().catch((error: unknown) => {
    unavailable = error;
  });
  await flush();
  assert.match(String(unavailable), /unavailable/);
  await duringRefresh;
  release({ thread: { ...thread(), turns: [] } });
  await flush();
  const waiting = instance.waitUntilReady();
  let ready = false;
  void waiting.then(() => {
    ready = true;
  });
  await flush();
  assert.equal(bound.inputs.at(-1), marker);
  const item = {
    type: "commandExecution",
    source: "userShell",
    command: marker.slice(1),
  };
  native.notify("item/completed", { threadId: "unrelated", item });
  await flush();
  assert.equal(ready, false);
  native.notify("turn/completed", {
    threadId: "known",
    turn: thread("known", [item]).turns[0],
  });
  assert.equal(await waiting, "known");
  assert.deepEqual(
    native.requests
      .filter(({ method }) => method === "thread/resume")
      .map(({ params }) => params),
    [
      { threadId: "known", excludeTurns: true },
      { threadId: "known", excludeTurns: true },
    ],
  );
  assert.ok(
    native.requests
      .filter(({ method }) => method === "thread/read")
      .every(
        ({ params }) =>
          params.threadId === "known" && params.includeTurns === true,
      ),
  );
  assert.equal(bound.recoveries, 0);
});

await test("transport loss during reattachment prints one reconnect failure and retries the same ref", async (t) => {
  const native = await nativeFixture(t);
  const stderr: string[] = [];
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  t.mock.method(process.stderr, "write", (value: string) => {
    if (value.startsWith("[codex] ")) stderr.push(value);
    if (value.includes("reconnect failed")) failed();
    return true;
  });
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    {
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  native.sockets[0]!.close();
  await flush();
  native.handler = (request) => {
    if (request.method === "thread/resume") native.sockets.at(-1)!.close();
    return {};
  };
  t.mock.timers.tick(10_000);
  await failure;
  await flush();
  assert.deepEqual(stderr, [
    "[codex] sessionref=known observation disconnected\n",
    "[codex] sessionref=known observation reconnect failed\n",
  ]);
  native.handler = () => ({ thread: thread() });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(native.proxies.length, 3);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/read").length,
    2,
  );
});

await test("a stale refresh cannot restore observation after notifications arrive during reattachment", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { retryLimit: 0 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  native.sockets[0]!.close();
  await flush();
  let release!: (value: unknown) => void;
  let reads = 0;
  const pending = new Promise<void>((received) => {
    native.handler = (request) => {
      if (request.method !== "thread/read") return {};
      reads++;
      if (reads > 1) return { thread: thread() };
      received();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
  });
  t.mock.timers.tick(10_000);
  await pending;
  native.notify("item/completed", {
    threadId: "known",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "newer output" },
  });
  await flush();
  release({ thread: thread() });
  await instance.startMonitoring("known");
  assert.equal(reads, 2);
});

await test("failed subscription or snapshot refresh retries after ten seconds without exposing partial state", async (t) => {
  for (const stage of [
    "thread/resume",
    "thread/read",
    "invalid-snapshot",
    "timeout",
  ]) {
    await t.test(stage, async (t) => {
      const native = await nativeFixture(t);
      const stderr: string[] = [];
      let failed!: () => void;
      const failure = new Promise<void>((resolve) => {
        failed = resolve;
      });
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex] ")) stderr.push(value);
        if (value.includes("reconnect failed")) failed();
        return true;
      });
      const instance = await createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: process.cwd(),
          env: {},
        },
        { retryLimit: 0 },
      );
      t.after(() => instance.stop());
      await instance.startMonitoring("known");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      native.sockets[0]!.close();
      await flush();
      const reading = new Promise<void>((received) => {
        native.handler = (request) => {
          if (request.method === stage) {
            received();
            throw new Error("private payload");
          }
          if (request.method === "thread/read") {
            received();
            if (stage === "invalid-snapshot")
              return { thread: thread("unrelated") };
            if (stage === "timeout") return new Promise(() => undefined);
          }
          return { thread: thread() };
        };
      });
      t.mock.timers.tick(10_000);
      if (stage === "timeout") {
        await reading;
        for (let attempt = 0; attempt < 3; attempt++) {
          t.mock.timers.tick(10_000);
          await flush();
          if (attempt < 2) {
            t.mock.timers.tick(1_000);
            await flush();
          }
        }
      } else if (stage === "thread/read") {
        await reading;
        await flush();
        for (let attempt = 0; attempt < 2; attempt++) {
          t.mock.timers.tick(1_000);
          await flush();
        }
      }
      await failure;
      await assert.rejects(instance.waitUntilReady(), /unavailable/);
      assert.deepEqual(stderr, [
        "[codex] sessionref=known observation disconnected\n",
        "[codex] sessionref=known observation reconnect failed\n",
      ]);
      native.handler = () => ({ thread: thread() });
      t.mock.timers.tick(9_999);
      await flush();
      assert.equal(native.proxies.length, 2);
      assert.equal(
        native.requests.filter(({ method }) => method === "thread/resume")
          .length,
        2,
      );
      t.mock.timers.tick(1);
      await flush();
      assert.equal(native.proxies.length, 3);
    });
  }
});

await test("reconnection before GUID discovery restores availability without adopting a conversation", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { retryLimit: 0 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  native.sockets[0]!.close();
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  await flush();
  assert.equal(native.proxies.length, 2);
  assert.equal(
    native.requests.filter(({ method }) => method.startsWith("thread/")).length,
    0,
  );
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(native.proxies.length, 2);
  assert.deepEqual(bound.inputs, []);
  await instance.stop();
});
