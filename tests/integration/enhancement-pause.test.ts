import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, flush, thread } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("human action suppresses both recovery categories across turns until matching resume", async (t) => {
  const { instance, state, native, bound, stderr } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryDelay: [1],
    retryLimit: 1,
  });
  state.snapshot.turns[0]!.status = "completed";
  state.snapshot.turns[0]!.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  await instance.startMonitoring("known");
  await flush();
  assert.deepEqual(bound.pauses, [
    { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
  ]);
  assert.deepEqual(stderr, []);

  for (const status of ["completed", "failed", "interrupted"]) {
    state.snapshot.turns[0]!.id = status;
    state.snapshot.turns[0]!.status = status;
    state.snapshot.turns[0]!.items = [
      { id: status, type: "agentMessage", text: "Still resolving it" },
    ];
    native.notify("turn/completed", {
      threadId: "known",
      turn: state.snapshot.turns[0],
    });
    await flush();
    t.mock.timers.tick(100_000);
    await flush();
    assert.equal(bound.recoveries, 0);
  }
  await instance.enhancementResume("stale-assignment");
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  await instance.enhancementResume("assignment-1");
  await flush();
  assert.equal(bound.recoveries, 0);
  t.mock.timers.tick(1_000);
  await instance.enhancementResume("assignment-1");
  t.mock.timers.tick(999);
  await flush();
  assert.equal(bound.recoveries, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.deepEqual(bound.inputs, []);
  assert.equal(bound.pauses.length, 1);
});

await test("handled replies stay handled after resume and only new requests start another pause", async (t) => {
  const { instance, state, native, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryLimit: 1,
  });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  turn.items = [
    { id: "first", type: "agentMessage", text: "[action required] First" },
  ];
  await instance.startMonitoring("known");
  await flush();
  const later = {
    id: "second",
    type: "agentMessage",
    text: "[action required] Second",
  };
  turn.items.push(later);
  for (let repeat = 0; repeat < 2; repeat++) {
    native.notify("item/completed", {
      threadId: "known",
      turnId: turn.id,
      item: later,
    });
    native.notify("thread/status/changed", {
      threadId: "known",
      status: { type: "idle" },
    });
    await flush();
  }
  assert.equal(bound.pauses.length, 1);
  await instance.enhancementResume("assignment-1");
  await flush();
  native.notify("item/completed", {
    threadId: "known",
    turnId: turn.id,
    item: later,
  });
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  // The final snapshot still contains the handled marker.
  assert.equal(bound.pauses.length, 1);
  assert.equal(bound.recoveries, 1);

  turn.id = "new-turn";
  turn.items = [
    { id: "third", type: "agentMessage", text: "[action required] Third" },
  ];
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  assert.equal(bound.pauses.length, 2);
  await instance.enhancementResume("assignment-1");
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(
    bound.recoveries,
    1,
    "resume preserves the spent missing-handoff budget",
  );
  await instance.stop();
  await instance.enhancementResume("assignment-1");
  assert.equal(bound.pauses.length, 2);
});

await test("resume still requires idle work, no handoff, and an eligible non-retrying error", async (t) => {
  for (const blocked of ["active", "handoff", "excluded", "native-retry"]) {
    await t.test(blocked, async (t) => {
      const { instance, state, native, bound, files, expectedFile } =
        await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
          retryDelay: [1],
          retryLimit: 1,
        });
      const turn = state.snapshot.turns[0]!;
      turn.status = "completed";
      turn.items = [
        { id: "reply", type: "agentMessage", text: "[action required] Decide" },
      ];
      await instance.startMonitoring("known");
      await flush();
      turn.id = "later";
      turn.items = [];
      turn.status =
        blocked === "active"
          ? "inProgress"
          : blocked === "handoff"
            ? "completed"
            : "failed";
      if (blocked === "handoff") files.add(expectedFile);
      if (blocked === "excluded")
        turn.error = { codexErrorInfo: "unauthorized" };
      native.notify("turn/completed", { threadId: "known", turn });
      if (blocked === "native-retry") {
        native.notify("error", {
          threadId: "known",
          turnId: turn.id,
          willRetry: true,
        });
      }
      await flush();
      await instance.enhancementResume("assignment-1");
      await flush();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.equal(bound.pauses.length, 1);

      files.clear();
      turn.status =
        blocked === "active" || blocked === "handoff" ? "completed" : "failed";
      turn.error = null;
      native.notify("turn/completed", { threadId: "known", turn });
      native.notify("error", {
        threadId: "known",
        turnId: turn.id,
        willRetry: false,
      });
      await flush();
      const delay = turn.status === "completed" ? 2_000 : 1_000;
      t.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(bound.recoveries, 1);
    });
  }
});

await test("completed human-action turns keep the ordinary error-budget reset while paused", async (t) => {
  const { instance, state, native, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryDelay: [1],
    retryLimit: 1,
  });
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  const turn = state.snapshot.turns[0]!;
  turn.id = "human-action";
  turn.status = "completed";
  turn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  turn.id = "later-failure";
  turn.status = "failed";
  turn.items = [];
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  await instance.enhancementResume("assignment-1");
  t.mock.timers.tick(999);
  await flush();
  assert.equal(bound.recoveries, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 2);
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 2);
});

await test("partial output cannot pause before its turn finishes", async (t) => {
  const { instance, state, native, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
  });
  const turn = state.snapshot.turns[0]!;
  turn.status = "inProgress";
  turn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  await instance.startMonitoring("known");
  native.notify("item/started", {
    threadId: "known",
    turnId: turn.id,
    item: turn.items[0],
  });
  await flush();
  t.mock.timers.tick(100_000);
  await flush();
  assert.deepEqual(bound.pauses, []);
  assert.equal(bound.recoveries, 0);
  turn.status = "completed";
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  assert.deepEqual(bound.pauses, [
    { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
  ]);
});

await test("each enhancement instance owns its pause even with the same Assignment ID", async (t) => {
  const { instance, state, native, bound, cwd, expectedFile } =
    await recoveryFixture(t, {
      handoffRecoveryDelaySeconds: 2,
      retryLimit: 1,
    });
  const firstTurn = state.snapshot.turns[0]!;
  firstTurn.status = "completed";
  firstTurn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  await instance.startMonitoring("known");
  await flush();
  const other = boundCapabilities();
  const snapshot = thread("other");
  native.handler = (request) => ({
    thread: request.params.threadId === "other" ? snapshot : state.snapshot,
  });
  const second = await createEnhancement(
    other.io,
    other.requestRecovery,
    { cwd, env: {}, enhancementPause: other.enhancementPause },
    { handoffRecoveryDelaySeconds: 2, retryLimit: 1 },
  );
  t.after(() => second.stop());
  second.onAssignment({ id: "assignment-1", expectedFile });
  await second.startMonitoring("other");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.equal(other.recoveries, 1);
  snapshot.turns[0]!.items = firstTurn.items;
  native.notify("turn/completed", {
    threadId: "other",
    turn: snapshot.turns[0],
  });
  await flush();
  assert.equal(bound.pauses.length, 1);
  assert.equal(other.pauses.length, 1);
  await instance.enhancementResume("assignment-1");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.equal(other.recoveries, 1);
  await second.stop();
  await second.enhancementResume("assignment-1");
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(other.recoveries, 1);
});
