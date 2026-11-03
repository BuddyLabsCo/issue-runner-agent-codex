import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { failedThread, recoveryFixture } from "../fixtures/recovery.ts";

await test("turn start, assignment replacement, native retry and inactive-to-active changes cancel without advancing attempts", async (t) => {
  for (const trigger of ["turn", "assignment", "retry", "active", "excluded"]) {
    await t.test(trigger, async (t) => {
      const { instance, native, state, bound, stderr } =
        await recoveryFixture(t);
      await instance.startMonitoring("known");
      t.mock.timers.tick(9_000);
      if (trigger === "assignment") instance.onAssignment("new-file.json");
      else if (trigger === "turn")
        native.notify("turn/started", {
          threadId: "known",
          turn: { id: "new", status: "inProgress", items: [] },
        });
      else if (trigger === "retry")
        native.notify("error", {
          threadId: "known",
          turnId: "failed-1",
          willRetry: true,
        });
      else if (trigger === "active")
        native.notify("thread/status/changed", {
          threadId: "known",
          status: { type: "active", activeFlags: [] },
        });
      else
        native.notify("turn/completed", {
          threadId: "known",
          turn: failedThread({ codexErrorInfo: "unauthorized" }).turns[0],
        });
      await flush();
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      if (trigger !== "assignment") {
        state.snapshot = failedThread();
        state.snapshot.turns[0]!.id = "later-failure";
        native.notify("turn/completed", {
          threadId: "known",
          turn: state.snapshot.turns[0],
        });
        native.notify("thread/status/changed", {
          threadId: "known",
          status: { type: "idle" },
        });
        await flush();
      }
      t.mock.timers.tick(trigger === "assignment" ? 8_999 : 9_999);
      await flush();
      assert.equal(bound.recoveries, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(bound.recoveries, 1);
      assert.match(stderr.at(-1)!, /attempt=1\/3/);
      assert.ok(
        stderr.every((line) => !/wait|schedul|cancel|retry/i.test(line)),
      );
    });
  }
});

await test("stop and loss of observation cancel pending recovery and preserve the native daemon", async (t) => {
  for (const trigger of ["stop", "disconnect"]) {
    await t.test(trigger, async (t) => {
      const { instance, native, bound, stderr } = await recoveryFixture(t);
      await instance.startMonitoring("known");
      t.mock.timers.tick(9_999);
      if (trigger === "stop") await instance.stop();
      else {
        native.sockets[0]!.close();
        await flush();
      }
      t.mock.timers.tick(1_000_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.ok(
        stderr.every((line) => line.includes("observation disconnected")),
      );
      assert.ok(native.launches.every(({ args }) => !args.includes("stop")));
      assert.equal(native.launches.length, 2);
    });
  }
});

await test("a silent native state change is caught by the final read, and later eligibility gets a fresh delay", async (t) => {
  const { instance, state, native, bound, fileReads } =
    await recoveryFixture(t);
  await instance.startMonitoring("known");
  state.snapshot.status.type = "active";
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  state.snapshot.status.type = "idle";
  native.notify("thread/status/changed", {
    threadId: "known",
    status: { type: "idle" },
  });
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(bound.recoveries, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.ok(fileReads.length >= 1);
});

await test("file appearance before the final check suppresses submission without consuming a retry", async (t) => {
  const {
    instance,
    native,
    state,
    bound,
    files,
    expectedFile,
    fileReads,
    stderr,
  } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  files.add(expectedFile);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(fileReads, [expectedFile]);
  assert.deepEqual(stderr, []);
  files.delete(expectedFile);
  native.notify("turn/completed", {
    threadId: "known",
    turn: state.snapshot.turns[0],
  });
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  assert.match(stderr.at(-1)!, /attempt=1\/3/);
});

await test("changes during an outstanding final read discard its result before reading or submitting stale input", async (t) => {
  for (const trigger of ["assignment", "turn", "stop", "retry", "excluded"]) {
    await t.test(trigger, async (t) => {
      const { instance, native, state, bound, fileReads } =
        await recoveryFixture(t);
      await instance.startMonitoring("known");
      let release!: (value: unknown) => void;
      const read = new Promise<void>((received) => {
        native.handler = (request) =>
          request.method === "thread/read"
            ? new Promise((resolve) => {
                release = resolve;
                received();
              })
            : {};
      });
      t.mock.timers.tick(10_000);
      await read;
      let stopped: Promise<void> | undefined;
      if (trigger === "assignment") instance.onAssignment("replacement.json");
      else if (trigger === "turn")
        native.notify("turn/started", {
          threadId: "known",
          turn: { id: "new-turn", status: "inProgress", items: [] },
        });
      else if (trigger === "retry")
        native.notify("error", {
          threadId: "known",
          turnId: "failed-1",
          willRetry: true,
        });
      else if (trigger === "excluded")
        native.notify("turn/completed", {
          threadId: "known",
          turn: failedThread({ codexErrorInfo: "unauthorized" }).turns[0],
        });
      else stopped = instance.stop();
      await flush();
      release({ thread: failedThread() });
      await stopped;
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(fileReads, []);
      if (trigger === "assignment") {
        native.handler = () => ({ thread: state.snapshot });
        t.mock.timers.tick(10_000);
        await flush();
        assert.equal(bound.recoveries, 1);
        assert.match(fileReads[0]!, /replacement\.json$/);
      }
    });
  }
});

await test("a snapshot invalidated by bound activity cannot authorize recovery from older cached state", async (t) => {
  const { instance, native, state, bound } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  let release!: (value: unknown) => void;
  const read = new Promise<void>((received) => {
    native.handler = (request) =>
      request.method === "thread/read"
        ? new Promise((resolve) => {
            release = resolve;
            received();
          })
        : {};
  });
  t.mock.timers.tick(10_000);
  await read;
  native.notify("item/started", {
    threadId: "known",
    turnId: "failed-1",
    item: { id: "activity", type: "commandExecution" },
  });
  await flush();
  state.snapshot.status.type = "active";
  release({ thread: state.snapshot });
  await flush();
  assert.equal(bound.recoveries, 0);
  native.handler = () => ({ thread: state.snapshot });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 0);
});
