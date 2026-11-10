import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("human pause survives reconnect and Enter releases it independently of transport", async (t) => {
  for (const status of ["completed", "failed"]) {
    for (const resumeAt of ["disconnected", "reattaching", "connected"]) {
      await t.test(`${status}/${resumeAt}`, async (t) => {
        const { instance, native, state, bound } = await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
          retryDelay: [2],
          retryLimit: 1,
        });
        const turn = state.snapshot.turns[0]!;
        turn.status = "completed";
        turn.items = [
          {
            id: "reply",
            type: "agentMessage",
            text: "[action required] Decide",
          },
        ];
        await instance.startMonitoring("known");
        await flush();
        turn.id = "later";
        turn.status = status;
        turn.items = [];
        native.notify("turn/completed", { threadId: "known", turn });
        native.notify("error", {
          threadId: "known",
          turnId: turn.id,
          willRetry: true,
        });
        await flush();
        native.sockets[0]!.close();
        await flush();
        const reads = native.requests.length;
        if (resumeAt === "disconnected") {
          await instance.enhancementResume("assignment-1");
          assert.equal(native.requests.length, reads);
        }
        t.mock.timers.tick(9_999);
        await flush();
        assert.deepEqual(bound.recoveryIds, []);

        let release!: () => void;
        const reading = new Promise<void>((received) => {
          native.handler = (request) => {
            if (request.method !== "thread/read") return {};
            received();
            return new Promise((resolve) => {
              release = () => resolve({ thread: state.snapshot });
            });
          };
        });
        t.mock.timers.tick(1);
        await reading;
        if (resumeAt === "reattaching")
          await instance.enhancementResume("assignment-1");
        t.mock.timers.tick(2_000);
        await flush();
        assert.deepEqual(
          bound.recoveryIds,
          [],
          "attachment is not initialized",
        );
        native.handler = () => ({ thread: state.snapshot });
        release();
        await flush();

        if (resumeAt === "connected") {
          t.mock.timers.tick(20_000);
          await flush();
          assert.deepEqual(
            bound.recoveryIds,
            [],
            "reconnect preserves the pause",
          );
          await instance.enhancementResume("assignment-1");
          await flush();
        }
        assert.equal(bound.pauses.length, 1);
        assert.deepEqual(
          bound.recoveryIds,
          [],
          "Enter sends no recovery input",
        );
        t.mock.timers.tick(1_999);
        await flush();
        assert.deepEqual(bound.recoveryIds, []);
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
        assert.equal(bound.pauses.length, 1);
        assert.deepEqual(bound.inputs, []);
      });
    }
  }
});

await test("resume cannot recover from a fulfilled but superseded reconnect snapshot", async (t) => {
  const { instance, native, state, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryLimit: 1,
  });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  turn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  await instance.startMonitoring("known");
  await flush();
  native.sockets[0]!.close();
  await flush();
  await instance.enhancementResume("assignment-1");
  let releaseOld!: () => void;
  let releaseFresh!: () => void;
  let freshStarted!: () => void;
  const freshRead = new Promise<void>((resolve) => {
    freshStarted = resolve;
  });
  const oldRead = new Promise<void>((received) => {
    let reads = 0;
    native.handler = (request) => {
      if (request.method !== "thread/read") return {};
      if (reads++ === 0) {
        received();
        return new Promise((resolve) => {
          releaseOld = () => resolve({ thread: state.snapshot });
        });
      }
      if (reads === 2) {
        freshStarted();
        return new Promise((resolve) => {
          releaseFresh = () => resolve({ thread: state.snapshot });
        });
      }
      return { thread: state.snapshot };
    };
  });
  t.mock.timers.tick(10_000);
  await oldRead;
  turn.id = "later";
  turn.items = [];
  native.notify("turn/completed", { threadId: "known", turn });
  await flush();
  releaseOld();
  await freshRead;
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, []);
  releaseFresh();
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.deepEqual(bound.recoveryIds, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  assert.equal(bound.pauses.length, 1);
});

await test("disconnected resume preserves spent budgets and handled replies across reconnect", async (t) => {
  const { instance, native, state, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryLimit: 2,
  });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  t.mock.timers.tick(1_000);
  turn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  native.notify("item/completed", {
    threadId: "known",
    turnId: turn.id,
    item: turn.items[0],
  });
  await flush();
  native.sockets[0]!.close();
  await flush();
  await instance.enhancementResume("assignment-1");
  const reattached = new Promise<void>((received) => {
    native.handler = (request) => {
      if (request.method === "thread/read") received();
      return { thread: state.snapshot };
    };
  });
  t.mock.timers.tick(10_000);
  await reattached;
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  t.mock.timers.tick(1_999);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1", "assignment-1"]);
  t.mock.timers.tick(20_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1", "assignment-1"]);
  assert.equal(bound.pauses.length, 1);
});
