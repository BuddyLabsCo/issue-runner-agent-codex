import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("fresh discovery starts a bootstrap model turn before returning the exact ref", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  native.handler = (request) =>
    request.method === "thread/loaded/list"
      ? { data: ["fresh"] }
      : {
          thread: thread("fresh", [
            {
              type: "commandExecution",
              source: "userShell",
              command: bound.inputs[0]?.slice(1),
            },
          ]),
        };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  let ready = false;
  const waiting = instance.waitUntilReady();
  void waiting.then(() => {
    ready = true;
  });
  await flush();
  await flush();
  assert.equal(ready, false);
  assert.equal(bound.inputs.length, 2);
  assert.match(bound.inputs[1]!, /Reply exactly READY/);
  native.notify("turn/started", {
    threadId: "fresh",
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
  assert.equal(await waiting, "fresh");
  assert.equal(bound.recoveries, 0);
  assert.ok(native.requests.every(({ method }) => method !== "turn/interrupt"));
});

await test("a supplied GUID-only ref correlates an early start and later user input during submission", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let release!: () => void;
  const pendingInput = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submit = bound.io.submitText.bind(bound.io);
  bound.io.submitText = async (text) => {
    await submit(text);
    if (text.startsWith("!")) return;
    native.notify("turn/started", {
      threadId: "known",
      turn: { id: "bootstrap", status: "inProgress", items: [] },
    });
    native.notify("item/started", {
      threadId: "known",
      turnId: "bootstrap",
      item: { type: "userMessage", content: [{ type: "text", text }] },
    });
    await pendingInput;
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  t.after(async () => {
    release();
    await instance.stop();
  });
  await instance.startMonitoring("known");
  const waiting = instance.waitUntilReady();
  await flush();
  native.notify("item/completed", {
    threadId: "known",
    turnId: "shell",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  assert.equal(await waiting, "known");
  assert.equal(bound.inputs.length, 2);
  assert.equal(await instance.waitUntilReady(), "known");
  assert.equal(bound.recoveries, 0);
});

await test("shell turns, stale starts and unrelated sessions or turn IDs cannot satisfy bootstrap", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  let ready = false;
  const waiting = instance.waitUntilReady();
  void waiting.then(() => {
    ready = true;
  });
  await flush();
  native.notify("turn/started", {
    threadId: "known",
    turn: { id: "shell", status: "inProgress", items: [] },
  });
  native.notify("item/completed", {
    threadId: "known",
    turnId: "shell",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  await flush();
  const message = {
    type: "userMessage",
    content: [{ type: "text", text: bound.inputs[1] }],
  };
  native.notify("turn/started", {
    threadId: "other",
    turn: { id: "foreign", status: "inProgress", items: [message] },
  });
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "stale",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: "old prompt" }],
        },
      ],
    },
  });
  native.notify("item/completed", {
    threadId: "known",
    turnId: "message-without-start",
    item: message,
  });
  await flush();
  assert.equal(ready, false);
  native.notify("turn/started", {
    threadId: "known",
    turn: { id: "message-without-start", status: "inProgress", items: [] },
  });
  assert.equal(await waiting, "known");
});

for (const status of ["failed", "interrupted"]) {
  await test(`bootstrap ${status} after start does not fail readiness or recover without an Assignment`, async (t) => {
    const native = await nativeFixture(t);
    const bound = boundCapabilities();
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      { retryDelay: [0], handoffRecoveryDelaySeconds: 0 },
    );
    t.after(() => instance.stop());
    await instance.startMonitoring("known");
    const waiting = instance.waitUntilReady();
    await flush();
    native.notify("item/completed", {
      threadId: "known",
      item: {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]!.slice(1),
      },
    });
    await flush();
    const turn = {
      id: "bootstrap",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: bound.inputs[1] }],
        },
      ],
    };
    native.notify("turn/started", { threadId: "known", turn });
    native.notify("turn/completed", {
      threadId: "known",
      turn: { ...turn, status, error: { message: "generation failed" } },
    });
    native.notify("thread/status/changed", {
      threadId: "known",
      status: { type: "idle" },
    });
    assert.equal(await waiting, "known");
    await flush();
    assert.equal(await instance.waitUntilReady(), "known");
    assert.equal(bound.inputs.length, 2);
    assert.equal(bound.recoveries, 0);
    assert.ok(
      native.requests.every(
        ({ method }) => !["turn/start", "turn/interrupt"].includes(method),
      ),
    );
  });
}

await test("missing model start times out, retries with a new token and rejects the old attempt's events", async (t) => {
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
  native.notify("item/completed", {
    threadId: "known",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(3_000);
  await timeout;
  let ready = false;
  const retry = instance.waitUntilReady();
  void retry.then(() => {
    ready = true;
  });
  await flush();
  assert.equal(bound.inputs.length, 3);
  assert.notEqual(bound.inputs[1], bound.inputs[2]);
  for (const [index, id] of [
    [1, "old"],
    [2, "retry"],
  ] as const) {
    native.notify("turn/started", {
      threadId: "known",
      turn: {
        id,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            content: [{ type: "text", text: bound.inputs[index] }],
          },
        ],
      },
    });
    await flush();
    assert.equal(ready, index === 2);
  }
  assert.equal(await retry, "known");
});

await test("stop cancels bootstrap input queued after GUID detection", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await flush();
  native.notify("item/completed", {
    threadId: "known",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  const stopping = instance.stop();
  await stopping;
  await waiting;
  await flush();
  assert.equal(bound.inputs.length, 1);
  await assert.rejects(instance.waitUntilReady(), /stopped/);
});
