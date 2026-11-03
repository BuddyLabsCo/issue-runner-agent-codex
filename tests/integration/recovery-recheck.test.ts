import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, flush, nativeFixture } from "../fixtures/native.ts";
import { failedThread, recoveryFixture } from "../fixtures/recovery.ts";

await test("assignment, native retry and stop during the file check prevent stale submission", async (t) => {
  for (const trigger of ["assignment", "retry", "stop", "file-error"]) {
    await t.test(trigger, async (t) => {
      const { instance, native, bound, expectedFile } =
        await recoveryFixture(t);
      await instance.startMonitoring("known");
      let release!: () => void;
      const checked = new Promise<void>((received) => {
        t.mock.method(fs, "access", (path: string) => {
          assert.equal(path, expectedFile);
          received();
          return new Promise<void>((resolve, reject) => {
            release =
              trigger === "file-error"
                ? () => reject(new Error("cancelled file read"))
                : resolve;
          });
        });
      });
      t.mock.timers.tick(10_000);
      await checked;
      let stopping: Promise<void> | undefined;
      if (trigger === "assignment") instance.onAssignment("replacement.json");
      else if (trigger === "retry")
        native.notify("error", {
          threadId: "known",
          turnId: "failed-1",
          willRetry: true,
        });
      else stopping = instance.stop();
      await flush();
      release();
      await stopping;
      await flush();
      assert.equal(bound.recoveries, 0);
    });
  }
});

await test("an excluded error discovered only by the final read cancels recovery and reports its classification", async (t) => {
  const { instance, state, bound, stderr } = await recoveryFixture(t);
  await instance.startMonitoring("known");
  state.snapshot = failedThread({
    codexErrorInfo: "modelNotFound",
    message: "secret RPC payload",
  });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 0);
  assert.deepEqual(stderr, [
    "[codex] sessionref=known recovery=error excluded=modelNotFound\n",
  ]);
});

await test("ordinary synchronous and asynchronous Host errors propagate unchanged through lifecycle and stop", async (t) => {
  for (const synchronous of [true, false]) {
    await t.test(String(synchronous), async (t) => {
      const native = await nativeFixture(t);
      const bound = boundHost();
      const failure = new Error("Host failure");
      let submitted!: () => void;
      const submission = new Promise<void>((resolve) => {
        submitted = resolve;
      });
      bound.host.requestRecovery = () => {
        submitted();
        if (synchronous) throw failure;
        return Promise.reject(failure);
      };
      native.handler = () => ({ thread: failedThread() });
      t.mock.method(fs, "access", () =>
        Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
      );
      const instance = await createEnhancement(
        bound.host,
        { cwd: process.cwd(), env: {} },
        { retryDelay: [0] },
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      instance.onAssignment("handoff.json");
      await instance.startMonitoring("known");
      t.mock.timers.tick(0);
      await submission;
      await flush();
      await assert.rejects(
        instance.waitUntilReady(),
        (error) => error === failure,
      );
      assert.throws(
        () => instance.onAssignment("next.json"),
        (error) => error === failure,
      );
      await assert.rejects(instance.stop(), (error) => error === failure);
      await assert.rejects(instance.stop(), (error) => error === failure);
      await flush();
      assert.equal(native.sockets[0]!.readyState, 3);
    });
  }
});

await test("observation and file-read errors propagate without being retried as business turns", async (t) => {
  for (const source of ["read", "file"]) {
    await t.test(source, async (t) => {
      const native = await nativeFixture(t);
      const bound = boundHost();
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex]")) stderr.push(value);
        return true;
      });
      native.handler = () => ({ thread: failedThread() });
      const instance = await createEnhancement(
        bound.host,
        { cwd: process.cwd(), env: {} },
        {},
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      instance.onAssignment("handoff.json");
      await instance.startMonitoring("known");
      const failure = Object.assign(new Error("file permission denied"), {
        code: "EACCES",
      });
      if (source === "read")
        native.handler = () => {
          throw new Error("RPC secret");
        };
      else t.mock.method(fs, "access", () => Promise.reject(failure));
      t.mock.timers.tick(10_000);
      await flush();
      t.mock.timers.tick(1_000_000);
      await flush();
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(stderr, []);
      await assert.rejects(
        instance.stop(),
        source === "read" ? /RPC request failed/ : (error) => error === failure,
      );
      await flush();
      assert.equal(native.sockets[0]!.readyState, 3);
    });
  }
});

await test("notifications and repeated final snapshots preserve attempts, delay position and retry evidence", async (t) => {
  const { instance, native, state, bound, stderr, expectedFile } =
    await recoveryFixture(t, { retryLimit: 3 });
  await instance.startMonitoring("known");
  native.notify("error", {
    threadId: "known",
    turnId: "failed-1",
    willRetry: false,
  });
  await flush();
  for (const [index, delay] of [10_000, 20_000, 40_000].entries()) {
    instance.onAssignment(expectedFile);
    native.notify("thread/status/changed", {
      threadId: "known",
      status: state.snapshot.status,
    });
    native.notify("item/completed", {
      threadId: "other",
      item: { type: "agentMessage", text: "unrelated" },
    });
    native.notify("turn/started", {
      threadId: "other",
      turn: { id: "other", status: "inProgress", items: [] },
    });
    await flush();
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(bound.recoveries, index);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(bound.recoveries, index + 1);
  }
  assert.match(stderr.at(-1)!, /exhausted=3\/3/);
  assert.equal(
    native.requests.filter(({ method }) => method === "thread/read").length,
    4,
  );
});

await test("stop awaits a submitted Host request and does not schedule more recovery", async (t) => {
  const { instance, bound } = await recoveryFixture(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = bound.host.requestRecovery.bind(bound.host);
  bound.host.requestRecovery = async () => {
    await request();
    await pending;
  };
  await instance.startMonitoring("known");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(bound.recoveries, 1);
  let finished = false;
  const stopped = instance.stop().then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  release();
  await stopped;
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(bound.recoveries, 1);
});
