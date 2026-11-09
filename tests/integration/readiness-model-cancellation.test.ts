import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  completeShellTurn,
  flush,
  nativeFixture,
} from "../fixtures/native.ts";

await test("stop cancels a pending bootstrap wait and awaits issued input without accepting late events", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let release!: () => void;
  const input = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submit = bound.io.submitText.bind(bound.io);
  bound.io.submitText = async (text) => {
    await submit(text);
    if (!text.startsWith("!")) await input;
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  await flush();
  assert.equal(bound.inputs.length, 2);
  let stopped = false;
  const stopping = instance.stop().then(() => {
    stopped = true;
  });
  await waiting;
  await flush();
  assert.equal(stopped, false);
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "late",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: bound.inputs[1] }],
        },
      ],
    },
  });
  release();
  await stopping;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(bound.inputs.length, 2);
  await assert.rejects(instance.waitUntilReady(), /stopped/);
  assert.equal(bound.recoveries, 0);
});

await test("overlapping readiness waits share one bootstrap and preserve the remaining wait's deadline", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const timeout = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  await flush();
  t.mock.timers.tick(1_000);
  const second = instance.waitUntilReady();
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(2_000);
  await timeout;
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "bootstrap",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: bound.inputs[1] }],
        },
      ],
    },
  });
  assert.equal(await second, "known");
  assert.equal(bound.inputs.length, 2);
});

await test("bootstrap input rejection propagates unchanged and the same instance can retry", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const failure = new Error("terminal input failed");
  let fails = true;
  const submit = bound.io.submitText.bind(bound.io);
  bound.io.submitText = async (text) => {
    await submit(text);
    if (text.startsWith("!")) return;
    if (fails) throw failure;
    native.notify("turn/started", {
      threadId: "known",
      turn: {
        id: "retry",
        status: "inProgress",
        items: [{ type: "userMessage", content: [{ type: "text", text }] }],
      },
    });
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const waiting = assert.rejects(
    instance.waitUntilReady(),
    (error) => error === failure,
  );
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  await waiting;
  fails = false;
  assert.equal(await instance.waitUntilReady(), "known");
  assert.equal(bound.inputs.length, 3);
  assert.notEqual(bound.inputs[1], bound.inputs[2]);
});
