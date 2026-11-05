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
    let failed = false;
    const requestStart = native.requests.length;
    native.handler = (request) => {
      if (request.method === failingMethod && !failed) {
        failed = true;
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
