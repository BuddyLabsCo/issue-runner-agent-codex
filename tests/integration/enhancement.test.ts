import { boundCapabilities } from "../fixtures/native.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  completeShellTurn,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("observes only the supplied conversation and accepts a failed concatenated userShell marker", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    {
      enhancementPause: bound.enhancementPause,
      cwd: process.cwd(),
      env: { CODEX_HOME: "injected-home" },
    },
    { unrelatedOption: true },
  );

  await instance.startMonitoring("known");
  const ready = instance.waitUntilReady();
  await flush();
  assert.match(bound.inputs[0] ?? "", /^![0-9a-f-]{36}$/);
  const marker = bound.inputs[0]!.slice(1);
  let resolved = false;
  void ready.then(() => {
    resolved = true;
  });
  native.notify("item/completed", {
    threadId: "other",
    item: { type: "commandExecution", source: "userShell", command: marker },
  });
  await flush();
  assert.equal(resolved, false);
  native.notify("turn/completed", {
    threadId: "known",
    turn: {
      id: "shell",
      status: "completed",
      items: [
        {
          type: "commandExecution",
          source: "userShell",
          command: `prefix\n${marker}suffix`,
          status: "failed",
          exitCode: 127,
        },
      ],
    },
  });
  assert.equal(await ready, "known");
  assert.deepEqual(bound.keys, []);
  assert.equal(bound.recoveries, 0);
  assert.ok(
    native.requests.every(
      (request) =>
        !request.method.startsWith("thread/") ||
        request.params.threadId === "known",
    ),
  );
  assert.deepEqual(
    native.launches.map(({ command, args }) => [command, args]),
    [
      ["codex", ["app-server", "daemon", "start"]],
      ["codex", ["app-server", "proxy"]],
    ],
  );
  assert.ok(
    native.launches.every(
      ({ options }) =>
        options.cwd === process.cwd() &&
        options.env?.CODEX_HOME === "injected-home",
    ),
  );
  assert.deepEqual(
    native.requests.map(({ method }) => method),
    [
      "initialize",
      "initialized",
      "config/read",
      "hooks/list",
      "thread/resume",
      "thread/read",
      "thread/read",
    ],
  );
  await instance.stop();
});

await test("each wait has a deadline and retries on the same instance use its GUID every two seconds", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 5 },
  );
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  assert.equal(bound.inputs.length, 1);
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.inputs.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(bound.inputs.length, 3);
  t.mock.timers.tick(1_000);
  await first;
  const retry = instance.waitUntilReady();
  await flush();
  assert.equal(bound.inputs.length, 4);
  assert.equal(new Set(bound.inputs).size, 1);
  native.notify("turn/completed", {
    threadId: "known",
    turn: {
      id: "shell",
      status: "completed",
      items: [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]!.slice(1),
          exitCode: 1,
        },
      ],
    },
  });
  assert.equal(await retry, "known");
  assert.equal(await instance.waitUntilReady(), "known");
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(bound.inputs.length, 4);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/read").length,
    3,
  );
  await instance.stop();
});

await test("resume returns before issued probe input settles while formal input retains queue order", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let complete!: () => void;
  const inputRound = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const submit = bound.io.submitText.bind(bound.io);
  let queue = Promise.resolve();
  bound.io.submitText = (text) => {
    queue = queue.then(async () => {
      await submit(text);
      if (text.startsWith("!")) await inputRound;
    });
    return queue;
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  t.after(async () => {
    complete();
    await instance.stop();
  });
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const timeout = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  t.mock.timers.tick(3_000);
  await timeout;
  const ready = instance.waitUntilReady();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await ready, "known");
  const business = bound.io.submitText("formal task");
  await flush();
  assert.equal(bound.inputs.length, 1);
  complete();
  await business;
  assert.deepEqual(bound.inputs, [bound.inputs[0], "formal task"]);
});

await test("unbound instances never adopt notification-only evidence and stop invalidates readiness repeatably", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await flush();
  native.notify("item/completed", {
    threadId: "other",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  await flush();
  await instance.stop();
  await instance.stop();
  await waiting;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(bound.inputs.length, 1);
  assert.equal(
    native.requests.filter((request) =>
      ["thread/resume", "thread/read"].includes(request.method),
    ).length,
    0,
  );
  await assert.rejects(instance.waitUntilReady(), /stopped/);
});

await test("disconnect rejects pending readiness, is redacted on stderr, and stop cancels reconnection", async (t) => {
  const native = await nativeFixture(t);
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    if (value.startsWith("[codex] ")) stderr.push(value);
    return true;
  });
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  instance.onAssignment({ id: "handoff.json", expectedFile: "handoff.json" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = assert.rejects(instance.waitUntilReady(), /unavailable/);
  await flush();
  native.sockets[0]!.close(
    1011,
    "credentials and RPC payload must not be logged",
  );
  await waiting;
  await instance.stop();
  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(stderr, [
    "[codex] sessionref=known observation disconnected\n",
  ]);
  assert.equal(native.launches.length, 2);
  assert.equal(bound.recoveries, 0);
  await instance.stop();
});

await test("Host input errors propagate and a retry can use the same observation", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const failure = new Error("Host failed");
  const submit = bound.io.submitText.bind(bound.io);
  bound.io.submitText = () => {
    throw failure;
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  await assert.rejects(instance.waitUntilReady(), (error) => error === failure);
  bound.io.submitText = submit;
  const waiting = instance.waitUntilReady();
  await flush();
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await waiting, "known");
  await instance.stop();
});

await test("two Hosts keep distinct GUIDs and exact conversation bindings", async (t) => {
  const native = await nativeFixture(t);
  native.handler = (request) =>
    request.method.startsWith("thread/")
      ? {
          thread: {
            id: request.params.threadId,
            status: { type: "idle" },
            turns: [],
          },
        }
      : {};
  const first = bootstrapCapabilities(native, "first");
  const second = bootstrapCapabilities(native, "second");
  const a = await createEnhancement(
    first.io,
    first.requestRecovery,
    {
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    },
    {},
  );
  const b = await createEnhancement(
    second.io,
    second.requestRecovery,
    {
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    },
    {},
  );
  await a.startMonitoring("first");
  await b.startMonitoring("second");
  const ar = a.waitUntilReady();
  const br = b.waitUntilReady();
  await flush();
  assert.notEqual(first.inputs[0], second.inputs[0]);
  let secondReady = false;
  void br.then(() => {
    secondReady = true;
  });
  completeShellTurn(native, first.inputs[0]!.slice(1), "first");
  assert.equal(await ar, "first");
  assert.equal(secondReady, false);
  await a.stop();
  completeShellTurn(native, second.inputs[0]!.slice(1), "second");
  assert.equal(await br, "second");
  await b.stop();
});

await test("assignment replacement and bound turn start invalidate pending snapshots; continuation retains them", async (t) => {
  const native = await nativeFixture(t);
  for (const change of ["continuation", "replacement", "turn-start"] as const) {
    let release!: (value: unknown) => void;
    let reads = 0;
    const received = new Promise<void>((received) => {
      native.handler = (request) => {
        if (request.method !== "thread/read") return {};
        if (++reads > 1) return { thread: thread("known") };
        return new Promise((resolve) => {
          release = resolve;
          received();
        });
      };
    });
    const bound = bootstrapCapabilities(native);
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
      {},
    );
    instance.onAssignment({
      id: "exact/../assignment.json",
      expectedFile: "exact/../assignment.json",
    });
    const starting = instance.startMonitoring("known");
    await received;
    const ready = instance.waitUntilReady();
    await flush();
    const marker = bound.inputs[0]!.slice(1);
    if (change === "turn-start")
      native.notify("turn/started", {
        threadId: "known",
        turn: { id: "new-turn", status: "inProgress", items: [] },
      });
    else
      instance.onAssignment({
        id:
          change === "continuation"
            ? "exact/../assignment.json"
            : "replacement",
        expectedFile: "exact/../assignment.json",
      });
    await flush();
    let resolved = false;
    void ready.then(() => {
      resolved = true;
    });
    release({
      thread: {
        id: "known",
        status: { type: "idle" },
        turns: [
          {
            id: "old-turn",
            status: "completed",
            items: [
              {
                type: "commandExecution",
                source: "userShell",
                command: marker,
                exitCode: 1,
              },
            ],
          },
        ],
      },
    });
    await starting;
    await flush();
    assert.equal(resolved, change === "continuation");
    completeShellTurn(native, marker);
    assert.equal(await ready, "known");
    await instance.stop();
  }
});

await test("marker-like model output, other commands and unrelated turns never establish readiness", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await flush();
  const marker = bound.inputs[0]!.slice(1);
  for (const item of [
    { type: "agentMessage", text: marker },
    { type: "commandExecution", source: "agent", command: marker },
    {
      type: "commandExecution",
      source: "userShell",
      command: "a different command",
    },
  ])
    native.notify("item/completed", { threadId: "known", item });
  native.notify("turn/started", {
    threadId: "other",
    turn: { id: "other-turn", status: "inProgress", items: [] },
  });
  await flush();
  await instance.stop();
  await waiting;
});

await test("stop before input dispatch cancels the queued marker round", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await instance.stop();
  await waiting;
  assert.deepEqual(bound.inputs, []);
});

await test("overlapping waits retain separate deadlines while sharing marker input rounds", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  t.mock.timers.tick(1_000);
  let secondFinished = false;
  const second = instance.waitUntilReady();
  void second.then(
    () => {
      secondFinished = true;
    },
    () => {
      secondFinished = true;
    },
  );
  await flush();
  assert.equal(bound.inputs.length, 1);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(bound.inputs.length, 2);
  t.mock.timers.tick(1_000);
  await first;
  await flush();
  assert.equal(secondFinished, false);
  completeShellTurn(native, bound.inputs[0]!.slice(1));
  assert.equal(await second, "known");
  await instance.stop();
});
