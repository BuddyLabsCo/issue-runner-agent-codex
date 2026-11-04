import assert from "node:assert/strict";
import { test } from "node:test";
import { recoveryFixture, failedThread } from "../fixtures/recovery.ts";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, flush, nativeFixture } from "../fixtures/native.ts";

await test("unknown final errors recover through the Assignment-aware recovery after the default delay", async (t) => {
  const { native, bound, instance, stderr } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(stderr, []);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  assert.deepEqual(bound.inputs, []);
  assert.deepEqual(stderr, [
    "[codex] sessionref=known recovery=error attempt=1/3\n",
  ]);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/read").length,
    2,
  );
  assert.ok(
    native.requests.every(
      ({ method }) => !["turn/start", "turn/steer"].includes(method),
    ),
  );
});

await test("excluded machine classifications override HTTP 429 and remain observable", async (t) => {
  for (const classification of [
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "unauthorized",
    "modelNotFound",
    "contextWindowExceeded",
    "cyberPolicy",
    "misalignmentPolicyViolation",
  ]) {
    await t.test(classification, async (t) => {
      const { instance, state, bound, stderr, native } =
        await recoveryFixture(t);
      state.snapshot = failedThread({
        codexErrorInfo: classification,
        message: "HTTP 429 secret-token full payload",
      });
      await instance.startMonitoring("known");
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(stderr, [
        `[codex] sessionref=known recovery=error excluded=${classification}\n`,
      ]);
      state.snapshot = failedThread({
        codexErrorInfo: "other",
        message: "unknown",
      });
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(bound.recoveries, 1);
    });
  }
});

await test("inactive systemError and every remaining final error use recovery", async (t) => {
  for (const error of [
    null,
    { codexErrorInfo: "badRequest", message: "HTTP 400" },
    { codexErrorInfo: "rateLimitExceeded", message: "HTTP 429" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
    { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
    {
      codexErrorInfo: "futureUnknownClassification",
      message: "unclassified failure",
    },
  ]) {
    await t.test(JSON.stringify(error), async (t) => {
      const { instance, state, bound } = await recoveryFixture(t);
      state.snapshot = failedThread(error);
      state.snapshot.status.type = "systemError";
      await instance.startMonitoring("known");
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(bound.recoveries, 1);
    });
  }
});

await test("active, incomplete, unloaded and native-retrying states never receive recovery input", async (t) => {
  for (const [threadStatus, turnStatus, retry] of [
    ["active", "failed", undefined],
    ["active", "failed", false],
    ["idle", "inProgress", undefined],
    ["systemError", "inProgress", false],
    ["notLoaded", "failed", undefined],
    ["idle", "completed", false],
    ["idle", "interrupted", false],
    ["idle", "failed", true],
  ] as const) {
    await t.test(
      `${threadStatus}/${turnStatus}/${String(retry)}`,
      async (t) => {
        const { instance, state, native, bound, stderr } =
          await recoveryFixture(t);
        state.snapshot.status.type = threadStatus;
        state.snapshot.turns[0]!.status = turnStatus;
        await instance.startMonitoring("known");
        if (retry !== undefined)
          native.notify("error", {
            threadId: "known",
            turnId: "failed-1",
            willRetry: retry,
          });
        await flush();
        t.mock.timers.tick(100_000);
        await flush();
        assert.equal(bound.recoveries, 0);
        assert.deepEqual(stderr, []);
      },
    );
  }
});

await test("unbound and unassigned instances never schedule business recovery", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  native.handler = () => ({ thread: failedThread() });
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    instance.onAssignment({ id: "handoff.json", expectedFile: "handoff.json" });
    await instance.startMonitoring();
    t.mock.timers.tick(100_000);
    await flush();
    assert.equal(bound.recoveries, 0);
  } finally {
    await instance.stop();
  }
  const second = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  try {
    await second.startMonitoring("known");
    t.mock.timers.tick(100_000);
    await flush();
    assert.equal(bound.recoveries, 0);
  } finally {
    await second.stop();
  }
});
