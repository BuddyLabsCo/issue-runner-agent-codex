import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("a full human-action reply discovered by the final snapshot suppresses input; a later turn stays paused until resume", async (t) => {
  const { instance, state, native, bound, stderr } = await recoveryFixture(t, {
    retryLimit: 1,
    handoffRecoveryDelaySeconds: 2,
  });
  state.snapshot.turns[0]!.status = "completed";
  await instance.startMonitoring("known");
  await flush();
  t.mock.timers.tick(1_999);
  state.snapshot.turns[0]!.items = [
    {
      id: "commentary",
      type: "agentMessage",
      phase: "commentary",
      text: "Working",
    },
    {
      id: "reply",
      type: "agentMessage",
      phase: "final_answer",
      text: " \n\t[action required] " + "full reply ".repeat(10_000),
    },
  ];
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(bound.pauses, [
    { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
  ]);
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.deepEqual(stderr, []);
  assert.deepEqual(bound.pauses, [
    { assignmentId: "assignment-1", message: "ACTION REQUIRED!!!" },
  ]);
  state.snapshot.turns.push({
    id: "later",
    status: "interrupted",
    error: null,
    items: [
      {
        id: "older-reply",
        type: "agentMessage",
        phase: "final_answer",
        text: "[action required] Old output",
      },
      {
        id: "latest-reply",
        type: "agentMessage",
        phase: "final_answer",
        text: "Continuing delivery",
      },
    ],
  });
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns.at(-1),
  });
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  await instance.enhancementResume("assignment-1");
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(bound.recoveries, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.match(stderr.at(-2)!, /missing-handoff attempt=1\/1/);
});

await test("missing-handoff file and Host failures propagate through the lifecycle without additional submissions", async (t) => {
  for (const source of ["file", "host"]) {
    await t.test(source, async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const failure = Object.assign(new Error("boundary failure"), {
        code: "EACCES",
      });
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex] ")) stderr.push(value);
        return true;
      });
      native.handler = () => ({ thread: thread() });
      t.mock.method(fs, "access", () =>
        Promise.reject(
          source === "file"
            ? failure
            : Object.assign(new Error("absent"), { code: "ENOENT" }),
        ),
      );
      const request = bound.recovery.request;
      bound.recovery.request = async (id) => {
        await request(id);
        throw failure;
      };
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        {
          enhancementPause: bound.enhancementPause,
          cwd: process.cwd(),
          env: {},
        },
        { handoffRecoveryDelaySeconds: 2 },
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      instance.onAssignment({
        id: "handoff.json",
        expectedFile: "handoff.json",
      });
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(2_000);
      await flush();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.recoveries, source === "file" ? 0 : 1);
      if (source === "host") {
        await assert.rejects(
          instance.waitUntilReady(),
          (error) => error === failure,
        );
      } else {
        assert.doesNotThrow(() =>
          instance.onAssignment({ id: "next", expectedFile: "next.json" }),
        );
      }
      await instance.stop();
      await instance.stop();
      assert.ok(
        stderr.includes("[codex] sessionref=known recovery operation failed\n"),
      );
      assert.ok(stderr.every((line) => !line.includes("boundary failure")));
    });
  }
});

await test("a changed native turn or active thread seen only at the final read cancels input and requires a fresh delay", async (t) => {
  for (const changed of ["turn", "active"]) {
    await t.test(changed, async (t) => {
      const { instance, state, native, bound, stderr } = await recoveryFixture(
        t,
        {
          handoffRecoveryDelaySeconds: 2,
        },
      );
      state.snapshot.turns[0]!.status = "completed";
      await instance.startMonitoring("known");
      await flush();
      if (changed === "turn") state.snapshot.turns[0]!.id = "silent-later-turn";
      else state.snapshot.status.type = "active";
      t.mock.timers.tick(2_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      if (changed === "active") {
        state.snapshot.status.type = "idle";
        native.notify("thread/status/changed", {
          threadId: "known",
          status: { type: "idle" },
        });
        await flush();
      }
      t.mock.timers.tick(1_999);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(bound.recoveries, 1);
      assert.deepEqual(stderr, [
        "[codex] sessionref=known recovery=missing-handoff attempt=1/3\n",
      ]);
    });
  }
});

await test("new turn, assignment, action-required output, disconnect and stop invalidate an outstanding native recheck", async (t) => {
  for (const trigger of [
    "turn",
    "assignment",
    "same-path",
    "action",
    "disconnect",
    "stop",
  ]) {
    await t.test(trigger, async (t) => {
      const { instance, state, native, bound, stderr, expectedFile } =
        await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
        });
      state.snapshot.turns[0]!.status = "completed";
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
      let stopping: Promise<void> | undefined;
      if (trigger === "assignment")
        instance.onAssignment({ id: "new.json", expectedFile: "new.json" });
      else if (trigger === "same-path")
        instance.onAssignment({ id: "assignment-2", expectedFile });
      else if (trigger === "turn")
        native.notify("turn/started", {
          threadId: "known",
          turn: { id: "new-turn", status: "inProgress", items: [] },
        });
      else if (trigger === "action")
        native.notify("item/completed", {
          threadId: "known",
          turnId: state.snapshot.turns[0]!.id,
          item: {
            id: "reply",
            type: "agentMessage",
            text: "[action required] Decide",
          },
        });
      else if (trigger === "disconnect") native.sockets[0]!.close();
      else stopping = instance.stop();
      await flush();
      release({ thread: state.snapshot });
      await stopping;
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.ok(stderr.every((line) => !line.includes("attempt=")));
      native.handler = () => ({ thread: state.snapshot });
    });
  }
});

await test("assignment, human action and stop during outstanding file checks cannot send stale input", async (t) => {
  for (const trigger of ["assignment", "same-path", "action", "stop"]) {
    await t.test(trigger, async (t) => {
      const { instance, state, native, bound, expectedFile } =
        await recoveryFixture(t, {
          handoffRecoveryDelaySeconds: 2,
        });
      state.snapshot.turns[0]!.status = "completed";
      await instance.startMonitoring("known");
      await flush();
      const releases: (() => void)[] = [];
      const checking = new Promise<void>((received) => {
        t.mock.method(
          fs,
          "access",
          () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
              received();
            }),
        );
      });
      t.mock.timers.tick(2_000);
      await checking;
      await flush();
      let stopping: Promise<void> | undefined;
      if (trigger === "assignment")
        instance.onAssignment({
          id: "replacement.json",
          expectedFile: "replacement.json",
        });
      else if (trigger === "same-path")
        instance.onAssignment({ id: "assignment-2", expectedFile });
      else if (trigger === "action")
        native.notify("item/completed", {
          threadId: "known",
          turnId: state.snapshot.turns[0]!.id,
          item: {
            id: "reply",
            type: "agentMessage",
            text: "[action required] Decide",
          },
        });
      else stopping = instance.stop();
      await flush();
      for (const release of releases) release();
      await stopping;
      await flush();
      assert.equal(bound.recoveries, 0);
    });
  }
});
