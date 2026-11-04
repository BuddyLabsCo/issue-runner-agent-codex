import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("missing handoffs require both a finished turn and an idle bound conversation", async (t) => {
  for (const [turn, thread] of [
    ["completed", "active"],
    ["interrupted", "active"],
    ["completed", "systemError"],
    ["interrupted", "notLoaded"],
    ["inProgress", "idle"],
    ["failed", "idle"],
  ]) {
    await t.test(`${turn}/${thread}`, async (t) => {
      const { instance, state, bound, stderr } = await recoveryFixture(t, {
        handoffRecoveryDelaySeconds: 2,
        retryDelay: [99],
      });
      state.snapshot.turns[0]!.status = turn!;
      state.snapshot.status.type = thread!;
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(2_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(stderr, []);
    });
  }
});

await test("turn start, changed assignment, active status, file appearance, human action, disconnect and stop cancel quietly without consuming attempts", async (t) => {
  for (const trigger of [
    "turn",
    "assignment",
    "active",
    "file",
    "action",
    "disconnect",
    "stop",
  ]) {
    await t.test(trigger, async (t) => {
      const { instance, state, native, bound, stderr, files, expectedFile } =
        await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
          retryLimit: 1,
        });
      state.snapshot.turns[0]!.status = "completed";
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(1_000);
      if (trigger === "turn")
        native.notify("turn/started", {
          threadId: "known",
          turn: { id: "new", status: "inProgress", items: [] },
        });
      else if (trigger === "assignment")
        instance.onAssignment({
          id: "replacement.json",
          expectedFile: "replacement.json",
        });
      else if (trigger === "active")
        native.notify("thread/status/changed", {
          threadId: "known",
          status: { type: "active" },
        });
      else if (trigger === "file") files.add(expectedFile);
      else if (trigger === "action")
        native.notify("item/completed", {
          threadId: "known",
          turnId: state.snapshot.turns[0]!.id,
          item: {
            id: "reply",
            type: "agentMessage",
            phase: "final_answer",
            text: " \n[action required] Decide",
          },
        });
      else if (trigger === "disconnect") native.sockets[0]!.close();
      else await instance.stop();
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(
        stderr,
        trigger === "action"
          ? ["[codex] sessionref=known ACTION REQUIRED!!!\n"]
          : trigger === "disconnect"
            ? ["[codex] sessionref=known observation disconnected\n"]
            : [],
      );
      if (trigger === "stop" || trigger === "disconnect") return;
      files.clear();
      state.snapshot.turns[0]!.id = "later";
      state.snapshot.turns[0]!.status = "interrupted";
      state.snapshot.turns[0]!.items = [];
      native.notify("turn/completed", {
        threadId: "known",
        turn: state.snapshot.turns[0],
      });
      native.notify("thread/status/changed", {
        threadId: "known",
        status: { type: "idle" },
      });
      await flush();
      t.mock.timers.tick(1_999);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(bound.recoveries, 1);
      assert.match(stderr.at(-2)!, /missing-handoff attempt=1\/1/);
      assert.ok(stderr.every((line) => !/wait|schedul|cancel/.test(line)));
    });
  }
});

await test("a file already present prevents missing-handoff timers and file contents stay owned by Core", async (t) => {
  const { instance, state, bound, native, files, expectedFile, stderr } =
    await recoveryFixture(t, {
      handoffRecoveryDelaySeconds: 2,
    });
  state.snapshot.turns[0]!.status = "interrupted";
  files.add(expectedFile);
  await instance.startMonitoring("known");
  await flush();
  const reads = native.requests.filter(
    ({ method }) => method === "thread/read",
  ).length;
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/read").length,
    reads,
  );
  assert.deepEqual(stderr, []);
});
