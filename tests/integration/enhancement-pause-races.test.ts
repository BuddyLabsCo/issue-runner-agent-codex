import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("resume discards paused file checks and waits for current eligibility before a full delay", async (t) => {
  const { instance, state, bound } = await recoveryFixture(t, {
    handoffRecoveryDelaySeconds: 2,
    retryLimit: 1,
  });
  const turn = state.snapshot.turns[0]!;
  turn.status = "completed";
  turn.items = [
    { id: "reply", type: "agentMessage", text: "[action required] Decide" },
  ];
  const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
  const releases: (() => void)[] = [];
  t.mock.method(fs, "access", () => {
    if (releases.length >= 2) return Promise.reject(absent);
    return new Promise<void>((_resolve, reject) => {
      releases.push(() => reject(absent));
    });
  });
  await instance.startMonitoring("known");
  await flush();
  assert.equal(bound.pauses.length, 1);
  assert.equal(releases.length, 1);
  await instance.enhancementResume("assignment-1");
  await flush();
  assert.equal(releases.length, 2);
  releases[0]!();
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  assert.deepEqual(
    bound.recoveryIds,
    [],
    "the cancelled check cannot schedule recovery",
  );
  releases[1]!();
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.deepEqual(bound.recoveryIds, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
  assert.equal(bound.pauses.length, 1);
});

await test("pause cancels outstanding final checks through resume, replacement and stop", async (t) => {
  for (const checking of ["snapshot", "file"]) {
    for (const next of ["resume", "replacement", "stop"]) {
      await t.test(`${checking}/${next}`, async (t) => {
        const { instance, state, native, bound, expectedFile } =
          await recoveryFixture(t, {
            handoffRecoveryDelaySeconds: 2,
            retryLimit: 1,
          });
        const turn = state.snapshot.turns[0]!;
        turn.status = "completed";
        await instance.startMonitoring("known");
        await flush();
        const releases: (() => void)[] = [];
        const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
        let holdFiles = true;
        const waiting = new Promise<void>((received) => {
          if (checking === "snapshot") {
            native.handler = () =>
              new Promise((resolve) => {
                releases.push(() => resolve({ thread: state.snapshot }));
                received();
              });
          } else {
            t.mock.method(fs, "access", () => {
              if (!holdFiles) return Promise.reject(absent);
              return new Promise<void>((_resolve, reject) => {
                releases.push(() => reject(absent));
                received();
              });
            });
          }
        });
        t.mock.timers.tick(2_000);
        await waiting;
        turn.items = [
          {
            id: "reply",
            type: "agentMessage",
            text: "[action required] Decide",
          },
        ];
        native.notify("item/completed", {
          threadId: "known",
          turnId: turn.id,
          item: turn.items[0],
        });
        await flush();
        assert.equal(bound.pauses.length, 1);
        if (next === "stop") {
          let stopped = false;
          const stopping = instance.stop().then(() => {
            stopped = true;
          });
          await flush();
          assert.equal(
            stopped,
            true,
            "cleanup needs neither Enter nor the file check",
          );
          await stopping;
        } else if (next === "replacement") {
          instance.onAssignment({ id: "assignment-2", expectedFile });
          await instance.enhancementResume("assignment-1");
        } else {
          await instance.enhancementResume("assignment-1");
        }
        await flush();
        native.handler = () => ({ thread: state.snapshot });
        holdFiles = false;
        for (const release of releases) release();
        await flush();
        assert.deepEqual(bound.recoveryIds, []);
        await instance.enhancementResume("assignment-1");
        t.mock.timers.tick(1_999);
        await flush();
        assert.deepEqual(bound.recoveryIds, []);
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(
          bound.recoveryIds,
          next === "stop"
            ? []
            : [next === "replacement" ? "assignment-2" : "assignment-1"],
        );
        assert.equal(bound.pauses.length, 1);
      });
    }
  }
});
