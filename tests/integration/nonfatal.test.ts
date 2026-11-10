import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  completeShellTurn,
  flush,
  nativeFixture,
} from "../fixtures/native.ts";
import { failedThread } from "../fixtures/recovery.ts";

await test("after readiness monitoring and cleanup failures leave contract calls safe", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const ready = instance.waitUntilReady();
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await ready, "known");
  await instance.startMonitoring("different");
  instance.onAssignment({ id: "next", expectedFile: "handoff.json" });
  assert.equal(await instance.waitUntilReady(), "known");
  const proxy = native.proxies[0]!;
  const kill = proxy.kill.bind(proxy);
  const release = t.mock.method(proxy, "kill", kill);
  release.mock.mockImplementationOnce(() => {
    throw new Error("original cleanup failure");
  });
  const stopping = instance.stop();
  assert.equal(stopping, instance.stop());
  await stopping;
  await instance.stop();
  assert.equal(release.mock.callCount(), 2);
  await instance.startMonitoring("known");
  instance.onAssignment({ id: "after stop", expectedFile: "handoff.json" });
});

for (const source of ["file", "read"]) {
  await test(`failed ${source} check skips input and fresh evidence recovers after readiness`, async (t) => {
    const native = await nativeFixture(t);
    const bound = bootstrapCapabilities(native);
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
      { retryDelay: [1] },
    );
    t.after(() => instance.stop());
    await instance.startMonitoring("known");
    const ready = instance.waitUntilReady();
    await flush();
    completeShellTurn(native, bound.inputs[0]!.slice(1));
    assert.equal(await ready, "known");
    const snapshot = failedThread();
    native.handler = () => ({ thread: snapshot });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const access = t.mock.method(fs, "access", () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    );
    if (source === "read")
      native.handler = () => {
        throw new Error("read failed");
      };
    instance.onAssignment({ id: "first", expectedFile: "handoff.json" });
    native.notify("turn/completed", {
      threadId: "known",
      turn: snapshot.turns[0],
    });
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(1_000);
      await flush();
    }
    assert.equal(bound.recoveries, 0);
    assert.equal(await instance.waitUntilReady(), "known");
    access.mock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
    );
    native.handler = () => ({ thread: snapshot });
    native.notify("thread/status/changed", {
      threadId: "known",
      status: { type: "idle" },
    });
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(bound.recoveryIds, ["first"]);
    instance.onAssignment({ id: "second", expectedFile: "next.json" });
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(bound.recoveryIds, ["first", "second"]);
  });
}

await test("stop stays bounded after readiness while a recovery callback is still pending", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  let rejectInput!: () => void;
  const input = new Promise<void>((_resolve, reject) => {
    rejectInput = () => reject(new Error("late recovery input failure"));
  });
  const request = bound.recovery.request;
  bound.recovery.request = async (id) => {
    await request(id);
    await input;
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { retryDelay: [1] },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const ready = instance.waitUntilReady();
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await ready, "known");
  t.mock.method(fs, "access", () =>
    Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
  );
  const snapshot = failedThread();
  native.handler = () => ({ thread: snapshot });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  instance.onAssignment({ id: "first", expectedFile: "handoff.json" });
  native.notify("turn/completed", {
    threadId: "known",
    turn: snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["first"]);
  let stopped = false;
  const stopping = instance.stop().then(() => {
    stopped = true;
  });
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(stopped, false);
  t.mock.timers.tick(1);
  await stopping;
  rejectInput();
  await flush();
  await instance.stop();
  assert.deepEqual(bound.recoveryIds, ["first"]);
});

await test("recovery-prompt delivery failure still propagates after readiness", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const failure = new Error("original input failure");
  bound.recovery.request = () => Promise.reject(failure);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { retryDelay: [1] },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const ready = instance.waitUntilReady();
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await ready, "known");
  t.mock.method(fs, "access", () =>
    Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
  );
  const snapshot = failedThread();
  native.handler = () => ({ thread: snapshot });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  instance.onAssignment({ id: "first", expectedFile: "handoff.json" });
  native.notify("turn/completed", {
    threadId: "known",
    turn: snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  await assert.rejects(instance.waitUntilReady(), (error) => error === failure);
  assert.throws(
    () => instance.onAssignment({ id: "next", expectedFile: "next.json" }),
    (error) => error === failure,
  );
});

await test("empty hook inventory requires only one query", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  assert.equal(
    native.requests.filter(({ method }) => method === "hooks/list").length,
    1,
  );
  await instance.stop();
});
