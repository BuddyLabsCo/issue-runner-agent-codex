import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  completeShellTurn,
  flush,
} from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("replacement clears the old pause without transferring its reply or accepting its resume", async (t) => {
  for (const path of ["same", "correction"]) {
    await t.test(path, async (t) => {
      const { instance, state, native, bound, expectedFile } =
        await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
          retryDelay: [1],
          retryLimit: 1,
        });
      const turn = state.snapshot.turns[0]!;
      turn.status = "completed";
      turn.items = [
        {
          id: "old-reply",
          type: "agentMessage",
          text: "[action required] Old",
        },
      ];
      await instance.startMonitoring("known");
      await flush();
      assert.equal(bound.pauses.length, 1);
      instance.onAssignment({ id: "assignment-1", expectedFile });
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(bound.recoveries, 0, "identical Assignment stays paused");

      const replacement = {
        id: "assignment-2",
        expectedFile: path === "same" ? expectedFile : "correction.json",
      };
      instance.onAssignment(replacement);
      await flush();
      native.notify("turn/completed", { threadId: "known", turn });
      await instance.enhancementResume("assignment-1");
      await flush();
      assert.equal(
        bound.pauses.length,
        1,
        "old output cannot pause replacement",
      );
      t.mock.timers.tick(1_999);
      await flush();
      assert.deepEqual(bound.recoveryIds, []);
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-2"]);
      assert.equal(bound.pauses.length, 1, "snapshot cannot replay old output");

      turn.id = "replacement-turn";
      turn.items = [
        {
          id: "new-reply",
          type: "agentMessage",
          text: "[action required] New",
        },
      ];
      native.notify("turn/completed", { threadId: "known", turn });
      await flush();
      assert.deepEqual(bound.pauses.at(-1), {
        assignmentId: "assignment-2",
        message: "ACTION REQUIRED!!!",
      });
      turn.id = "replacement-failure";
      turn.status = "failed";
      turn.items = [];
      native.notify("turn/completed", { threadId: "known", turn });
      await flush();
      await instance.enhancementResume("assignment-1");
      instance.onAssignment(replacement);
      t.mock.timers.tick(10_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-2"]);
      await instance.enhancementResume("assignment-2");
      assert.deepEqual(bound.recoveryIds, ["assignment-2"]);
      t.mock.timers.tick(1_000);
      await flush();
      assert.deepEqual(
        bound.recoveryIds,
        ["assignment-2", "assignment-2"],
        "only the current confirmation releases recovery",
      );

      instance.onAssignment({ id: "assignment-3", expectedFile });
      await flush();
      t.mock.timers.tick(2_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, [
        "assignment-2",
        "assignment-2",
        "assignment-3",
      ]);
      assert.equal(bound.pauses.length, 2);
    });
  }
});

await test("a late marker from an observed old turn cannot pause replacement work", async (t) => {
  const { instance, state, native, bound, expectedFile } =
    await recoveryFixture(t, { handoffRecoveryDelaySeconds: 2, retryLimit: 1 });
  const turn = state.snapshot.turns[0]!;
  turn.status = "inProgress";
  await instance.startMonitoring("known");
  await flush();
  instance.onAssignment({ id: "assignment-2", expectedFile });
  turn.status = "completed";
  turn.items = [
    { id: "late-reply", type: "agentMessage", text: "[action required] Old" },
  ];
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  assert.deepEqual(bound.pauses, []);
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(bound.pauses, [], "a refreshed old turn remains old");
  assert.deepEqual(bound.recoveryIds, ["assignment-2"]);

  turn.id = "current-turn";
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  assert.deepEqual(bound.pauses, [
    { assignmentId: "assignment-2", message: "ACTION REQUIRED!!!" },
  ]);
});

await test("a new Run resumes the session and unfinished work without restoring its human pause", async (t) => {
  const { instance, state, native, bound, cwd, expectedFile } =
    await recoveryFixture(t, { handoffRecoveryDelaySeconds: 2 });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  turn.items = [
    {
      id: "old-reply",
      type: "agentMessage",
      text: "[action required] Old Run",
    },
  ];
  await instance.startMonitoring("known");
  await flush();
  assert.equal(bound.pauses.length, 1);
  await instance.stop();

  const next = bootstrapCapabilities(native);
  const resumed = await createEnhancement(
    next.io,
    next.requestRecovery,
    { cwd, env: {}, enhancementPause: next.enhancementPause },
    { handoffRecoveryDelaySeconds: 2, retryLimit: 1 },
  );
  t.after(() => resumed.stop());
  await resumed.startMonitoring("known");
  const waiting = resumed.waitUntilReady();
  await flush();
  completeShellTurn(native, next.inputs[0]!.slice(1));
  assert.equal(await waiting, "known");
  assert.equal(next.inputs.length, 2);
  assert.match(next.inputs[1]!, /Reply exactly READY/);
  assert.deepEqual(next.pauses, []);
  resumed.onAssignment({ id: "assignment-1", expectedFile });
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  await resumed.enhancementResume("assignment-1");
  await instance.enhancementResume("assignment-1");
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(next.recoveryIds, ["assignment-1"]);
  assert.deepEqual(next.pauses, [], "old Run history cannot restore a pause");

  turn.id = "new-run-task";
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  assert.deepEqual(next.pauses, [
    { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
  ]);
  assert.equal(bound.pauses.length, 1);
});

await test("replacement ignores an old marker in a delayed recovery snapshot and later rereads", async (t) => {
  const { instance, state, native, bound, expectedFile } =
    await recoveryFixture(t, { handoffRecoveryDelaySeconds: 2, retryLimit: 1 });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  let release!: (value: unknown) => void;
  const reading = new Promise<void>((received) => {
    native.handler = () =>
      new Promise((resolve) => {
        release = resolve;
        received();
      });
  });
  t.mock.timers.tick(2_000);
  await reading;
  turn.items = [
    {
      id: "delayed-reply",
      type: "agentMessage",
      text: "[action required] Old",
    },
  ];
  instance.onAssignment({ id: "assignment-2", expectedFile });
  release({ thread: state.snapshot });
  native.handler = () => ({ thread: state.snapshot });
  await flush();
  assert.deepEqual(bound.pauses, []);
  assert.deepEqual(bound.recoveryIds, []);
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(bound.pauses, []);
  assert.deepEqual(bound.recoveryIds, ["assignment-2"]);
});
