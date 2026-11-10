import assert from "node:assert/strict";
import { test } from "node:test";
import { flush, thread } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("refreshed endings reach existing policies without replaying historical native retries", async (t) => {
  for (const status of [
    "failed",
    "completed",
    "interrupted",
    "action-required",
  ]) {
    await t.test(status, async (t) => {
      const { instance, native, state, bound, stderr } = await recoveryFixture(
        t,
        {
          retryDelay: [1],
          handoffRecoveryDelaySeconds: 1,
        },
      );
      state.snapshot = {
        ...thread(),
        status: { type: "active" },
        turns: [
          { id: "outage-turn", status: "inProgress", error: null, items: [] },
        ],
      };
      await instance.startMonitoring("known");
      native.notify("thread/status/changed", {
        threadId: "known",
        status: { type: "active" },
      });
      native.notify("error", {
        threadId: "known",
        turnId: "outage-turn",
        willRetry: true,
      });
      await flush();
      native.sockets[0]!.close();
      await flush();
      state.snapshot = {
        ...thread(),
        turns: [
          {
            id: "outage-turn",
            status: status === "action-required" ? "completed" : status,
            error: null,
            items:
              status === "action-required"
                ? [
                    {
                      type: "agentMessage",
                      phase: "final_answer",
                      text: " \n[action required] complete reply loaded from native history",
                    },
                  ]
                : [],
          },
        ],
      };
      const refreshed = new Promise<void>((received) => {
        native.handler = (request) => {
          if (request.method === "thread/read") received();
          return { thread: state.snapshot };
        };
      });
      t.mock.timers.tick(9_999);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await refreshed;
      await instance.startMonitoring("known");
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(999);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(bound.recoveries, status === "action-required" ? 0 : 1);
      if (status === "action-required") {
        assert.deepEqual(bound.pauses, [
          { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
        ]);
        assert.ok(stderr.every((line) => !line.includes("ACTION REQUIRED!!!")));
      } else {
        assert.ok(
          stderr.includes(
            `[codex] sessionref=known recovery=${status === "failed" ? "error" : "missing-handoff"} attempt=1/3\n`,
          ),
        );
      }
    });
  }
});

await test("reconnection retains each category's spent budget and the same assignment", async (t) => {
  for (const status of ["failed", "completed"]) {
    await t.test(status, async (t) => {
      const { instance, native, state, bound, expectedFile } =
        await recoveryFixture(t, {
          retryLimit: 1,
          retryDelay: [1],
          handoffRecoveryDelaySeconds: 1,
        });
      if (status === "completed") state.snapshot = thread();
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 1);
      native.sockets[0]!.close();
      await flush();
      const refreshed = new Promise<void>((received) => {
        native.handler = (request) => {
          if (request.method === "thread/read") received();
          return { thread: state.snapshot };
        };
      });
      t.mock.timers.tick(10_000);
      await refreshed;
      await instance.startMonitoring("known");
      await flush();
      instance.onAssignment({ id: "assignment-1", expectedFile });
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 1);
      instance.onAssignment({
        id: "replacement.json",
        expectedFile: "replacement.json",
      });
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 2);
    });
  }
});

await test("same-path Assignment replacement during reattachment requires fresh native state before recovery", async (t) => {
  const { instance, native, state, bound, expectedFile } =
    await recoveryFixture(t, {
      retryLimit: 1,
      retryDelay: [1],
    });
  await instance.startMonitoring("known");
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  native.sockets[0]!.close();
  await flush();
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
  instance.onAssignment({ id: "assignment-2", expectedFile });
  releaseOld();
  await freshRead;
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  releaseFresh();
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(999);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1", "assignment-2"]);
});
