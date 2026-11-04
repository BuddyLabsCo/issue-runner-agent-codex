import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { failedThread, recoveryFixture } from "../fixtures/recovery.ts";

await test("default delays count three actual submissions, then report exhaustion without stopping observation", async (t) => {
  const { instance, bound, stderr, native } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  for (const [index, delay] of [10_000, 20_000, 40_000].entries()) {
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(bound.recoveries, index);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(bound.recoveries, index + 1);
  }
  assert.deepEqual(stderr, [
    "[codex] sessionref=known recovery=error attempt=1/3\n",
    "[codex] sessionref=known recovery=error attempt=2/3\n",
    "[codex] sessionref=known recovery=error attempt=3/3\n",
    "[codex] sessionref=known recovery=error exhausted=3/3\n",
  ]);
  t.mock.timers.tick(1_000_000);
  await flush();
  assert.equal(bound.recoveries, 3);
  instance.onAssignment({
    id: "another-handoff.json",
    expectedFile: "another-handoff.json",
  });
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 4);
  assert.match(stderr.at(-1)!, /attempt=1\/3/);
});

await test("configured attempts reuse the last delay with no total recovery window", async (t) => {
  const { instance, bound } = await recoveryFixture(t, {
    retryLimit: 4,
    retryDelay: [400, 700],
  });
  await instance.startMonitoring("known");
  for (const [index, delay] of [400_000, 700_000, 700_000, 700_000].entries()) {
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(bound.recoveries, index);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(bound.recoveries, index + 1);
  }
});

await test("zero limit reports exhaustion without reading files or sending input", async (t) => {
  const { instance, bound, stderr, fileReads } = await recoveryFixture(t, {
    retryLimit: 0,
  });
  await instance.startMonitoring("known");
  t.mock.timers.tick(1_000_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(fileReads, []);
  assert.deepEqual(stderr, [
    "[codex] sessionref=known recovery=error exhausted=0/0\n",
  ]);
});

await test("same-path continuation preserves both budget and pending delay", async (t) => {
  const { instance, expectedFile, bound, stderr } = await recoveryFixture(t, {
    retryLimit: 2,
  });
  await instance.startMonitoring("known");
  t.mock.timers.tick(10_000);
  await flush();
  t.mock.timers.tick(15_000);
  instance.onAssignment({ id: "assignment-1", expectedFile });
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  assert.match(stderr.at(-1)!, /exhausted=2\/2/);
});

await test("completed and interrupted later turns reset error attempts even without a handoff", async (t) => {
  for (const status of ["completed", "interrupted"]) {
    await t.test(status, async (t) => {
      const { instance, native, state, bound, stderr } = await recoveryFixture(
        t,
        { retryLimit: 1 },
      );
      await instance.startMonitoring("known");
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(bound.recoveries, 1);
      state.snapshot.turns[0]!.status = status;
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.recoveries, 1);
      state.snapshot = failedThread();
      state.snapshot.turns[0]!.id = "later-failure";
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      await flush();
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(bound.recoveries, 2);
      assert.match(stderr.at(-2)!, /attempt=1\/1/);
    });
  }
});

await test("large validated delays do not overflow into immediate recovery", async (t) => {
  const { instance, bound } = await recoveryFixture(t, {
    retryDelay: [Number.MAX_VALUE],
  });
  await instance.startMonitoring("known");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 0);
});

await test("a cancelled second wait retains its twenty-second delay and attempt position", async (t) => {
  const { instance, native, state, bound, stderr } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(19_000);
  native.notify("turn/started", {
    threadId: "known",
    turn: { id: "next", status: "inProgress", items: [] },
  });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  state.snapshot.turns[0]!.id = "next";
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  assert.match(stderr.at(-1)!, /attempt=2\/3/);
});

await test("fresh Assignment IDs sharing a path reset each budget and replace pending waits", async (t) => {
  for (const status of ["failed", "completed"]) {
    await t.test(status, async (t) => {
      const { instance, state, bound, expectedFile } = await recoveryFixture(
        t,
        {
          retryLimit: 1,
          retryDelay: [1],
          handoffRecoveryDelaySeconds: 1,
        },
      );
      state.snapshot.turns[0]!.status = status;
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
      instance.onAssignment({ id: "assignment-2", expectedFile });
      await flush();
      t.mock.timers.tick(999);
      instance.onAssignment({ id: "assignment-3", expectedFile });
      await flush();
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
      t.mock.timers.tick(999);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1", "assignment-3"]);
      t.mock.timers.tick(10_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1", "assignment-3"]);
    });
  }
});
