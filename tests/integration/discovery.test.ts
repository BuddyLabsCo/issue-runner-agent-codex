import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("discovers the GUID's enclosing loaded thread across same-cwd threads and pages", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      return request.params.cursor
        ? { data: ["matching"], nextCursor: null }
        : { data: ["newest", "model-output"], nextCursor: "next-page" };
    if (request.method === "thread/read") {
      const marker = bound.inputs[0]?.slice(1) ?? "not-submitted";
      const items =
        request.params.threadId === "matching"
          ? [
              {
                type: "commandExecution",
                source: "userShell",
                command: `prefix\n${marker}suffix`,
                status: "failed",
                exitCode: 127,
              },
            ]
          : request.params.threadId === "model-output"
            ? [
                { type: "agentMessage", text: marker },
                { type: "commandExecution", source: "agent", command: marker },
              ]
            : [
                {
                  type: "commandExecution",
                  source: "userShell",
                  command: "unrelated-guid",
                },
              ];
      return {
        thread: {
          ...thread(String(request.params.threadId), items),
          cwd: process.cwd(),
        },
      };
    }
    return {};
  };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await instance.startMonitoring();
    assert.equal(
      native.requests.some(({ method }) => method.startsWith("thread/")),
      false,
    );
    const waiting = instance.waitUntilReady();
    assert.equal(await waiting, "matching");
    assert.deepEqual(
      native.requests
        .filter(({ method }) => method === "thread/resume")
        .map(({ params }) => params.threadId),
      ["matching"],
    );
    assert.equal(
      native.requests.filter(
        ({ method, params }) =>
          method === "thread/read" && params.threadId === "matching",
      ).length,
      2,
    );
    assert.equal(bound.inputs.length, 1);
    assert.equal(bound.recoveries, 0);
    assert.deepEqual(bound.keys, []);
    assert.ok(
      native.requests.every(
        ({ method }) =>
          !["thread/list", "thread/start", "turn/start"].includes(method),
      ),
    );
  } finally {
    await instance.stop();
  }
});

await test("delayed discovery keeps two-second rounds and stops enumeration after binding", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let loaded = false;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      return { data: loaded ? ["delayed"] : [] };
    return {
      thread: thread("delayed", [
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
    const waiting = instance.waitUntilReady();
    await flush();
    assert.equal(bound.inputs.length, 1);
    loaded = true;
    t.mock.timers.tick(1_999);
    await flush();
    assert.equal(bound.inputs.length, 1);
    t.mock.timers.tick(1);
    assert.equal(await waiting, "delayed");
    assert.equal(bound.inputs.length, 2);
    assert.equal(new Set(bound.inputs).size, 1);
    const requests = native.requests.length;
    native.notify("turn/started", {
      threadId: "other",
      turn: { id: "unrelated", status: "inProgress", items: [] },
    });
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(await instance.waitUntilReady(), "delayed");
    assert.equal(native.requests.length, requests);
    assert.equal(bound.inputs.length, 2);
  } finally {
    await instance.stop();
  }
});

await test("discovery notices evidence while a Host round is pending and waits for its completion", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let complete!: () => void;
  const round = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const submit = bound.io.submitText.bind(bound.io);
  bound.io.submitText = async (text) => {
    await submit(text);
    await round;
  };
  let loaded = false;
  native.handler = (request) =>
    request.method === "thread/loaded/list"
      ? { data: loaded ? ["pending-input"] : [] }
      : {
          thread: thread("pending-input", [
            {
              type: "commandExecution",
              source: "userShell",
              command: bound.inputs[0]?.slice(1),
              exitCode: 1,
            },
          ]),
        };
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    { readyTimeout: 5 },
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
    await flush();
    loaded = true;
    native.notify("item/completed", {
      threadId: "pending-input",
      item: {
        type: "commandExecution",
        source: "userShell",
        command: bound.inputs[0]?.slice(1),
      },
    });
    await flush();
    await flush();
    assert.ok(
      native.requests.some(
        ({ method, params }) =>
          method === "thread/resume" && params.threadId === "pending-input",
      ),
    );
    t.mock.timers.tick(4_000);
    await flush();
    assert.equal(ready, false);
    assert.equal(bound.inputs.length, 1);
    complete();
    assert.equal(await waiting, "pending-input");
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(bound.inputs.length, 1);
  } finally {
    complete();
    await instance.stop();
  }
});

await test("discovery timeout retries the same Tab and GUID without relaunching", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let matching = false;
  native.handler = (request) =>
    request.method === "thread/loaded/list"
      ? { data: ["same-cwd"] }
      : {
          thread: {
            ...thread("same-cwd", [
              {
                type: "commandExecution",
                source: "userShell",
                command: matching ? bound.inputs[0]?.slice(1) : "wrong-guid",
              },
            ]),
            cwd: process.cwd(),
          },
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
    const timeout = assert.rejects(instance.waitUntilReady(), /timed out/);
    await flush();
    t.mock.timers.tick(2_000);
    await flush();
    t.mock.timers.tick(1_000);
    await timeout;
    assert.equal(
      native.requests.some(({ method }) => method === "thread/resume"),
      false,
    );
    matching = true;
    assert.equal(await instance.waitUntilReady(), "same-cwd");
    assert.equal(new Set(bound.inputs).size, 1);
    assert.equal(native.launches.length, 2);
    assert.equal(bound.recoveries, 0);
  } finally {
    await instance.stop();
  }
});

await test("discovery does not lose a notification during an in-flight enumeration", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  let release!: (value: unknown) => void;
  let firstPage = true;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list") {
      if (firstPage) {
        firstPage = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return { data: ["just-loaded"] };
    }
    return {
      thread: thread("just-loaded", [
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
    const waiting = instance.waitUntilReady();
    void waiting.catch(() => undefined);
    await flush();
    native.notify("thread/started", { threadId: "just-loaded" });
    await flush();
    release({ data: [] });
    await flush();
    await flush();
    assert.ok(native.requests.some(({ method }) => method === "thread/resume"));
    assert.equal(await waiting, "just-loaded");
    assert.equal(bound.inputs.length, 1);
  } finally {
    await instance.stop();
  }
});

await test("distinct Tabs discover their own GUIDs among the same loaded threads and cwd", async (t) => {
  const native = await nativeFixture(t);
  const first = boundCapabilities();
  const second = boundCapabilities();
  let secondMarker = false;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list")
      return { data: ["first", "second"] };
    const ref = String(request.params.threadId);
    const command =
      ref === "first"
        ? first.inputs[0]?.slice(1)
        : secondMarker
          ? second.inputs[0]?.slice(1)
          : "not-ready";
    return {
      thread: {
        ...thread(ref, [
          { type: "commandExecution", source: "userShell", command },
        ]),
        cwd: process.cwd(),
      },
    };
  };
  const a = await createEnhancement(
    first.io,
    first.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const b = await createEnhancement(
    second.io,
    second.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await a.startMonitoring();
    await b.startMonitoring();
    const ar = a.waitUntilReady();
    const br = b.waitUntilReady();
    let secondReady = false;
    void br.then(
      () => {
        secondReady = true;
      },
      () => undefined,
    );
    assert.equal(await ar, "first");
    assert.notEqual(first.inputs[0], second.inputs[0]);
    assert.equal(secondReady, false);
    await a.stop();
    secondMarker = true;
    native.notify("item/completed", {
      threadId: "second",
      item: {
        type: "commandExecution",
        source: "userShell",
        command: second.inputs[0]?.slice(1),
      },
    });
    assert.equal(await br, "second");
    assert.equal(first.inputs.length, 1);
    assert.equal(second.inputs.length, 1);
    assert.equal(first.recoveries + second.recoveries, 0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

await test("stop during enumeration or inspection cancels discovery without adopting late evidence", async (t) => {
  const native = await nativeFixture(t);
  for (const pendingMethod of ["thread/loaded/list", "thread/read"]) {
    const bound = boundCapabilities();
    let release!: (value: unknown) => void;
    const received = new Promise<void>((received) => {
      native.handler = (request) => {
        if (request.method === pendingMethod)
          return new Promise((resolve) => {
            release = resolve;
            received();
          });
        return { data: ["late"] };
      };
    });
    const requestStart = native.requests.length;
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    await instance.startMonitoring();
    const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
    await received;
    await instance.stop();
    await waiting;
    release(
      pendingMethod === "thread/loaded/list"
        ? { data: ["late"] }
        : {
            thread: thread("late", [
              {
                type: "commandExecution",
                source: "userShell",
                command: bound.inputs[0]?.slice(1),
              },
            ]),
          },
    );
    await flush();
    assert.equal(
      native.requests
        .slice(requestStart)
        .some(({ method }) => method === "thread/resume"),
      false,
    );
    await assert.rejects(instance.waitUntilReady(), /stopped/);
    await instance.stop();
  }
});
