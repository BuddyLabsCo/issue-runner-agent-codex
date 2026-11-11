import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  completeShellTurn,
  discoverShellSession,
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
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
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
  assert.equal(
    bound.inputs[1],
    "Reply exactly READY. Do not use tools, modify files, or perform other work.",
  );
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

await test("resume validates its UUID during an active ordinary turn without bootstrap", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const waiting = instance.waitUntilReady();
  await flush();
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "ordinary",
      status: "inProgress",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "a0fc58" }] },
      ],
    },
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
  assert.equal(bound.inputs.length, 1);
  assert.equal(await waiting, "known");
  assert.equal(await instance.waitUntilReady(), "known");
  assert.equal(bound.recoveries, 0);
});

await test("shell activity, displayed text and foreign sessions or turn IDs cannot satisfy fresh readiness", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  discoverShellSession(native, bound.inputs);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
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
  const message = {
    type: "userMessage",
    content: [{ type: "text", text: "a0fc58" }],
  };
  native.notify("turn/started", {
    threadId: "other",
    turn: { id: "foreign", status: "inProgress", items: [message] },
  });
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "shell",
      status: "inProgress",
      items: [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]!.slice(1),
        },
        {
          type: "agentMessage",
          text: "<user_shell_command>command not found</user_shell_command>",
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
    turn: { id: "different-turn", status: "inProgress", items: [] },
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
    discoverShellSession(native, bound.inputs);
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
      { retryDelay: [0], handoffRecoveryDelaySeconds: 0 },
    );
    t.after(() => instance.stop());
    await instance.startMonitoring();
    const waiting = instance.waitUntilReady();
    await flush();
    completeShellTurn(native, bound.inputs[0]!.slice(1));
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

await test("retry accepts a model start from an earlier attempt using the same fixed bootstrap", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  discoverShellSession(native, bound.inputs);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const timeout = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(3_000);
  await timeout;
  const retry = instance.waitUntilReady();
  await flush();
  assert.equal(bound.inputs.length, 3);
  assert.equal(bound.inputs[1], bound.inputs[2]);
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "earlier-attempt",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: bound.inputs[1] }],
        },
      ],
    },
  });
  assert.equal(await retry, "known");
});

await test("stop cancels bootstrap input queued after GUID detection", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  discoverShellSession(native, bound.inputs);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring();
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await Promise.resolve();
  const stopping = instance.stop();
  await stopping;
  await waiting;
  await flush();
  assert.equal(bound.inputs.length, 1);
  await assert.rejects(instance.waitUntilReady(), /stopped/);
});

await test("fresh readiness credits anomalous ordinary model input from before binding", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  native.handler = (request) => {
    if (request.method === "thread/loaded/list") return { data: ["fresh"] };
    const snapshot = thread("fresh", [
      {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]?.slice(1),
      },
    ]);
    snapshot.turns.push({
      id: "ordinary",
      status: "inProgress",
      error: null,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "a0fc58" }] },
      ],
    });
    return { thread: snapshot };
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  assert.equal(await instance.waitUntilReady(), "fresh");
  assert.equal(bound.inputs.length, 1);
});

await test("retry refreshes bound history and credits ordinary input completed during Operator Pause", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let progressed = false;
  let notified = false;
  native.handler = async (request) => {
    if (request.method === "thread/loaded/list") return { data: ["fresh"] };
    const snapshot = thread("fresh", [
      {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]?.slice(1),
      },
    ]);
    if (progressed)
      snapshot.turns.push({
        id: "ordinary-during-pause",
        status: "completed",
        error: null,
        items: [
          { type: "userMessage", content: [{ type: "text", text: "a0fc58" }] },
        ],
      });
    if (progressed && !notified) {
      notified = true;
      native.notify("turn/started", {
        threadId: "fresh",
        turn: { id: "ordinary-during-pause", status: "inProgress", items: [] },
      });
      await flush();
    }
    return { thread: snapshot };
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const timeout = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(3_000);
  await timeout;
  const reads = native.requests.filter(
    ({ method }) => method === "thread/read",
  ).length;
  progressed = true;
  assert.equal(await instance.waitUntilReady(), "fresh");
  assert.ok(
    native.requests.filter(({ method }) => method === "thread/read").length >
      reads,
  );
  assert.equal(bound.inputs.length, 2);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/resume").length,
    1,
  );
});

await test("model notifications without a verified session cannot establish fresh readiness", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let loaded = false;
  native.handler = (request) =>
    request.method === "thread/loaded/list"
      ? { data: loaded ? ["fresh"] : [] }
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
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring();
  let ready = false;
  const waiting = instance.waitUntilReady();
  void waiting.then(
    () => {
      ready = true;
    },
    () => undefined,
  );
  await flush();
  native.notify("turn/started", {
    turn: {
      id: "no-session",
      status: "inProgress",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "a0fc58" }] },
      ],
    },
  });
  await flush();
  loaded = true;
  native.notify("thread/started", { threadId: "fresh" });
  await flush();
  await flush();
  assert.equal(ready, false);
  assert.equal(bound.inputs.length, 2);
  native.notify("turn/started", {
    threadId: "fresh",
    turn: {
      id: "real-model",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: "ordinary input" }],
        },
      ],
    },
  });
  assert.equal(await waiting, "fresh");
});
