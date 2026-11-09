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

for (const status of ["completed", "inProgress"]) {
  await test(`metadata during discovery binding preserves ${status} GUID history`, async (t) => {
    const native = await nativeFixture(t);
    const bound = bootstrapCapabilities(native, "found");
    let reads = 0;
    native.handler = (request) => {
      if (request.method === "thread/loaded/list") return { data: ["found"] };
      if (request.method !== "thread/read") return {};
      if (++reads === 2) {
        native.notify("thread/goal/cleared", { threadId: "found" });
        native.notify("mcpServer/startupStatus/updated", {
          threadId: "found",
        });
      }
      const snapshot = thread("found", [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]?.slice(1),
        },
      ]);
      snapshot.turns[0]!.status = status;
      return { thread: snapshot };
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
      await flush();
      assert.equal(reads, 2);
      if (status === "inProgress") {
        assert.equal(bound.inputs.length, 1);
        native.notify("item/completed", {
          threadId: "found",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            source: "userShell",
            command: bound.inputs[0]!.slice(1),
            status: "completed",
          },
        });
        await flush();
        assert.equal(bound.inputs.length, 1);
        native.notify("turn/completed", {
          threadId: "found",
          turn: { id: "turn-1", status: "completed", items: [] },
        });
        await flush();
      }
      assert.equal(bound.inputs.length, 2);
      assert.equal(await waiting, "found");
      assert.equal(reads, 2);
    } finally {
      await instance.stop();
    }
  });
}

await test("a status notification during binding preserves initial history and readiness evidence", async (t) => {
  const native = await nativeFixture(t);
  let release!: (value: unknown) => void;
  const reading = new Promise<void>((received) => {
    native.handler = (request) =>
      request.method === "thread/read"
        ? new Promise((resolve) => {
            release = resolve;
            received();
          })
        : {};
  });
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    const starting = instance.startMonitoring("known");
    await reading;
    let ready = false;
    const waiting = instance.waitUntilReady();
    void waiting.then(
      () => {
        ready = true;
      },
      () => undefined,
    );
    await flush();
    native.notify("thread/status/changed", {
      threadId: "known",
      status: { type: "systemError" },
    });
    await flush();
    release({
      thread: thread("known", [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]!.slice(1),
          exitCode: 127,
        },
      ]),
    });
    await starting;
    await flush();
    assert.equal(ready, true);
    assert.equal(await waiting, "known");
    assert.equal(
      native.requests.filter(({ method }) => method === "thread/read").length,
      1,
    );
  } finally {
    await instance.stop();
  }
});

await test("failed binding initialization can be retried for the same exact conversation", async (t) => {
  const native = await nativeFixture(t);
  for (const failingMethod of ["thread/resume", "thread/read"]) {
    let failures = 0;
    const requestStart = native.requests.length;
    native.handler = (request) => {
      if (
        request.method === failingMethod &&
        failures++ < (failingMethod === "thread/read" ? 3 : 1)
      ) {
        throw new Error("scripted binding failure");
      }
      return request.method.startsWith("thread/") ? { thread: thread() } : {};
    };
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    try {
      await assert.rejects(
        instance.startMonitoring("known"),
        /RPC request failed/,
      );
      await assert.rejects(instance.startMonitoring("other"), /already bound/);
      await instance.startMonitoring("known");
      assert.deepEqual(
        native.requests
          .slice(requestStart)
          .filter(({ method }) => method.startsWith("thread/"))
          .map(({ method, params }) => [method, params.threadId]),
        failingMethod === "thread/resume"
          ? [
              ["thread/resume", "known"],
              ["thread/resume", "known"],
              ["thread/read", "known"],
            ]
          : [
              ["thread/resume", "known"],
              ["thread/read", "known"],
              ["thread/read", "known"],
              ["thread/read", "known"],
              ["thread/resume", "known"],
              ["thread/read", "known"],
            ],
      );
      const initializedRequests = native.requests.length;
      await instance.startMonitoring("known");
      assert.equal(native.requests.length, initializedRequests);
    } finally {
      await instance.stop();
    }
  }
});

await test("same-ref monitoring calls wait for the pending subscription and initial snapshot", async (t) => {
  const native = await nativeFixture(t);
  let release!: (value: unknown) => void;
  const subscribing = new Promise<void>((received) => {
    native.handler = (request) => {
      if (request.method === "thread/resume") {
        return new Promise((resolve) => {
          release = resolve;
          received();
        });
      }
      return request.method === "thread/read" ? { thread: thread() } : {};
    };
  });
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    const first = instance.startMonitoring("known");
    await subscribing;
    let finished = false;
    const second = instance.startMonitoring("known").then(() => {
      finished = true;
    });
    await flush();
    assert.equal(finished, false);
    release({});
    await Promise.all([first, second]);
    assert.deepEqual(
      native.requests
        .filter(({ method }) => method.startsWith("thread/"))
        .map(({ method }) => method),
      ["thread/resume", "thread/read"],
    );
  } finally {
    await instance.stop();
  }
});
