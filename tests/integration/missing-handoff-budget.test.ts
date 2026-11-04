import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { failedThread, recoveryFixture } from "../fixtures/recovery.ts";

await test("file appearance resets even an exhausted missing-handoff budget while observation continues", async (t) => {
  const { instance, state, native, bound, stderr, files, expectedFile } =
    await recoveryFixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 2 });
  state.snapshot.turns[0]!.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  files.add(expectedFile);
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  files.delete(expectedFile);
  instance.onAssignment({ id: "assignment-1", expectedFile });
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  assert.match(stderr.at(-2)!, /missing-handoff attempt=1\/1/);
});

await test("file appearance during human-action suppression resets the budget for later same-path continuation", async (t) => {
  const { instance, state, native, bound, stderr, files, expectedFile } =
    await recoveryFixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 2 });
  state.snapshot.turns[0]!.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.match(stderr.at(-1)!, /missing-handoff exhausted=1\/1/);

  files.add(expectedFile);
  state.snapshot.turns[0]!.id = "human-action";
  state.snapshot.turns[0]!.items = [
    {
      id: "reply",
      type: "agentMessage",
      phase: "final_answer",
      text: " \n[action required] Decide",
    },
  ];
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.deepEqual(stderr.slice(2), [
    "[codex] sessionref=known ACTION REQUIRED!!!\n",
  ]);

  files.delete(expectedFile);
  instance.onAssignment({ id: "assignment-1", expectedFile });
  state.snapshot.turns[0]!.id = "later-completion";
  state.snapshot.turns[0]!.items = [
    { id: "later-reply", type: "agentMessage", text: "Continuing delivery" },
  ];
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  assert.match(stderr.at(-2)!, /missing-handoff attempt=1\/1/);
});

await test("exhausting either category leaves the other available and completed turns reset only error attempts", async (t) => {
  for (const first of ["failed", "completed"]) {
    await t.test(first, async (t) => {
      const { instance, state, native, bound, stderr } = await recoveryFixture(
        t,
        {
          retryLimit: 1,
          retryDelay: [1],
          handoffRecoveryDelaySeconds: 2,
        },
      );
      state.snapshot.turns[0]!.status = first;
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(first === "failed" ? 1_000 : 2_000);
      await flush();
      assert.equal(bound.recoveries, 1);
      state.snapshot.turns[0]!.status =
        first === "failed" ? "completed" : "failed";
      state.snapshot.turns[0]!.id = "other-category";
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(first === "failed" ? 2_000 : 1_000);
      await flush();
      assert.equal(bound.recoveries, 2);
      assert.deepEqual(
        stderr.filter((line) => line.includes("attempt=")),
        first === "failed"
          ? [
              "[codex] sessionref=known recovery=error attempt=1/1\n",
              "[codex] sessionref=known recovery=missing-handoff attempt=1/1\n",
            ]
          : [
              "[codex] sessionref=known recovery=missing-handoff attempt=1/1\n",
              "[codex] sessionref=known recovery=error attempt=1/1\n",
            ],
      );
      state.snapshot.turns[0]!.status = "interrupted";
      state.snapshot.turns[0]!.id = "interruption";
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(20_000);
      await flush();
      assert.equal(bound.recoveries, 2);
      state.snapshot = failedThread();
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 3);
      assert.match(stderr.at(-2)!, /recovery=error attempt=1\/1/);
    });
  }
});

await test("same-path continuation and refreshed or later completed turns preserve missing-handoff attempts; a new path resets them", async (t) => {
  const { instance, state, native, bound, stderr, expectedFile } =
    await recoveryFixture(t, {
      retryLimit: 2,
      handoffRecoveryDelaySeconds: 2,
      retryDelay: [99],
    });
  state.snapshot.turns[0]!.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(1_000);
  instance.onAssignment({ id: "assignment-1", expectedFile });
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  native.notify("turn/started", {
    threadId: "unrelated",
    turn: { id: "unrelated", status: "inProgress", items: [] },
  });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1_999);
  state.snapshot.turns[0]!.id = "later-completion";
  state.snapshot.turns[0]!.status = "interrupted";
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  assert.match(stderr.at(-2)!, /missing-handoff attempt=2\/2/);
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(bound.recoveries, 2);
  instance.onAssignment({
    id: "new-handoff.json",
    expectedFile: "new-handoff.json",
  });
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.recoveries, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 3);
  assert.match(stderr.at(-1)!, /missing-handoff attempt=1\/2/);
});

await test("zero missing-handoff limit reports exhaustion without input and huge delays do not overflow", async (t) => {
  for (const config of [
    { retryLimit: 0, handoffRecoveryDelaySeconds: 2 },
    { retryLimit: 3, handoffRecoveryDelaySeconds: Number.MAX_VALUE },
  ]) {
    await t.test(String(config.retryLimit), async (t) => {
      const { instance, state, bound, stderr } = await recoveryFixture(
        t,
        config,
      );
      state.snapshot.turns[0]!.status = "completed";
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(
        stderr,
        config.retryLimit === 0
          ? [
              "[codex] sessionref=known recovery=missing-handoff exhausted=0/0\n",
            ]
          : [],
      );
    });
  }
});
