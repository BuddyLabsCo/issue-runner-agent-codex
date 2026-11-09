import assert from "node:assert/strict";
import fs from "node:fs";
import fileIO from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  hook,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";
import { failedThread } from "../fixtures/recovery.ts";

interface Record {
  time: string;
  level: "info" | "error";
  event: string;
  runId: string;
  instanceId: string;
  cwd: string;
  sessionref?: string;
  assignmentId?: string;
  turnId?: string;
  detail: {
    reason?: string;
    delayMs?: number;
    scheduledFor?: string;
    method?: string;
    attempt?: number;
    error?: unknown;
  };
}

await test("operation logging through enhancement lifecycle", async (suite) => {
  const root = fs.mkdtempSync(join(process.cwd(), "operation logs "));
  suite.after(async () => {
    await flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, "worktrees", "run", "ticket");
  const context = { cwd, env: {} };
  const records = () =>
    fs.readdirSync(join(root, "logs")).flatMap((name) =>
      fs
        .readFileSync(join(root, "logs", name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record),
    );

  await suite.test(
    "default and explicit error levels omit ordinary lifecycle, stderr and warnings",
    async (t) => {
      const native = await nativeFixture(t);
      t.mock.method(fileIO, "access", () =>
        Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
      );
      const bound = boundCapabilities();
      for (const config of [{}, { logLevel: "error" }]) {
        const instance = await createEnhancement(
          bound.io,
          bound.requestRecovery,
          context,
          config,
        );
        const proxy = native.proxies.at(-1)!;
        proxy.stderr.emit("data", Buffer.from("ordinary stderr"));
        native.notify("configWarning", { message: "ordinary warning" });
        await flush();
        await instance.stop();
      }
      assert.deepEqual(records(), []);
      await assert.rejects(
        createEnhancement(bound.io, bound.requestRecovery, context, {
          logLevel: "debug",
        }),
        /logLevel/,
      );
      const [failure] = records();
      assert.equal(failure!.event, "configuration validation failed");
      assert.equal(failure!.level, "error");
      assert.equal(failure!.cwd, cwd);
      assert.ok(failure!.instanceId);
      assert.ok(failure!.runId);
      assert.ok(!("sessionref" in failure!));
      assert.ok(!("assignmentId" in failure!));
      assert.ok(!("turnId" in failure!));
    },
  );

  await suite.test(
    "info records external operations without successful response or terminal bodies",
    async (t) => {
      const native = await nativeFixture(t);
      t.mock.method(fileIO, "access", () =>
        Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
      );
      const bound = boundCapabilities();
      const start = records().length;
      native.configuration.projects = {};
      native.hooks.push(hook());
      native.handler = (request) => {
        if (request.method === "thread/read")
          return {
            thread: thread("known", [
              { type: "agentMessage", text: "successful body secret" },
            ]),
          };
        if (request.method === "thread/loaded/list") return { data: [] };
        return {};
      };
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info", readyTimeout: 1 },
      );
      t.after(() => instance.stop());
      instance.onAssignment({
        id: "operation-assignment",
        expectedFile: "absent.json",
      });
      await instance.startMonitoring("known");
      await flush();
      const ready = assert.rejects(
        instance.waitUntilReady(),
        /readiness timed out/,
      );
      await flush();
      t.mock.timers.tick(1_000);
      await ready;
      await instance.stop();
      const emitted = records().slice(start);
      const events = emitted.map((record) => record.event);
      for (const event of [
        "daemon start",
        "proxy start",
        "transport connection start",
        "RPC attempt",
        "Git query",
        "expected-file check",
        "terminal submit",
        "readiness deadline scheduled",
        "readiness deadline timed out",
        "readiness retry wait scheduled",
        "readiness retry wait cancelled",
        "proxy stop",
        "transport stop",
      ])
        assert.ok(events.includes(event), event);
      for (const method of [
        "config/read",
        "config/value/write",
        "hooks/list",
        "thread/resume",
        "thread/read",
      ])
        assert.ok(
          emitted.some(
            (record) =>
              record.event === "RPC attempt" && record.detail.method === method,
          ),
          method,
        );
      const scoped = emitted.find(
        (record) =>
          record.event === "RPC attempt" &&
          record.detail.method === "thread/resume",
      )!;
      assert.equal(scoped.sessionref, "known");
      assert.equal(scoped.assignmentId, "operation-assignment");
      assert.ok(!JSON.stringify(emitted).includes("successful body secret"));
      assert.ok(!JSON.stringify(emitted).includes("durationMs"));
      for (const record of emitted.filter((record) =>
        record.event.endsWith(" scheduled"),
      )) {
        assert.equal(typeof record.detail.delayMs, "number");
        assert.equal(
          new Date(record.detail.scheduledFor!).getTime() -
            new Date(record.time).getTime(),
          record.detail.delayMs,
        );
        assert.ok(record.detail.reason);
      }
    },
  );

  await suite.test(
    "recovery cancellation and late callback rejection retain the originating Assignment and turn",
    async (t) => {
      const native = await nativeFixture(t);
      t.mock.method(fileIO, "access", () =>
        Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
      );
      const bound = boundCapabilities();
      let snapshot = failedThread();
      native.handler = (request) =>
        request.method.startsWith("thread/") ? { thread: snapshot } : {};
      let rejectRecovery!: (error: Error) => void;
      bound.recovery.request = () =>
        new Promise((_resolve, reject) => {
          rejectRecovery = reject;
        });
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info", retryDelay: [1] },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const start = records().length;
      instance.onAssignment({ id: "original", expectedFile: "absent.json" });
      await instance.startMonitoring("known");
      instance.onAssignment({ id: "replacement", expectedFile: "new.json" });
      await flush();
      const cancelled = records()
        .slice(start)
        .find((record) => record.event === "recovery wait cancelled")!;
      assert.equal(cancelled.assignmentId, "original");
      assert.equal(cancelled.turnId, "failed-1");
      t.mock.timers.tick(1_000);
      await flush();
      assert.equal(typeof rejectRecovery, "function");
      snapshot = {
        ...snapshot,
        turns: [
          { ...snapshot.turns[0]!, id: "next-turn", status: "inProgress" },
        ],
      };
      instance.onAssignment({ id: "third", expectedFile: "third.json" });
      native.notify("turn/started", {
        threadId: "known",
        turn: snapshot.turns[0],
      });
      await flush();
      rejectRecovery(
        new Error("late Core failure", { cause: new Error("original cause") }),
      );
      await flush();
      const emitted = records().slice(start);
      const callback = emitted.find(
        (record) => record.event === "Core recovery callback",
      )!;
      const failure = emitted.find(
        (record) => record.event === "recovery input failed",
      )!;
      for (const record of [callback, failure]) {
        assert.equal(record.assignmentId, "replacement");
        assert.equal(record.turnId, "failed-1");
        assert.equal(record.sessionref, "known");
      }
      assert.match(JSON.stringify(failure), /original cause/);
      assert.ok(
        emitted.some((record) => record.event === "recovery wait started"),
      );
    },
  );

  await suite.test(
    "RPC timeouts retain their originating context",
    async (t) => {
      const native = await nativeFixture(t);
      t.mock.method(fileIO, "access", () =>
        Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
      );
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info" },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      instance.onAssignment({
        id: "rpc-original",
        expectedFile: "absent.json",
      });
      native.handler = () => new Promise(() => undefined);
      const start = records().length;
      const binding = instance.startMonitoring("known");
      const failure = assert.rejects(binding, /timed out/);
      await flush();
      instance.onAssignment({
        id: "rpc-replacement",
        expectedFile: "new.json",
      });
      t.mock.timers.tick(10_000);
      await failure;
      const timeout = records()
        .slice(start)
        .find((record) => record.event === "RPC deadline timed out")!;
      assert.equal(timeout.assignmentId, "rpc-original");
      assert.equal(timeout.sessionref, "known");
      await instance.stop();
    },
  );
  await suite.test(
    "RPC retry execution and cancellation keep the original Assignment",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info" },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      instance.onAssignment({
        id: "retry-original",
        expectedFile: "absent.json",
      });
      native.handler = (request) => {
        if (request.method === "thread/read")
          throw new Error("service failure");
        return {};
      };
      const start = records().length;
      const binding = assert.rejects(
        instance.startMonitoring("known"),
        /disconnected/,
      );
      await flush();
      instance.onAssignment({
        id: "retry-replacement",
        expectedFile: "new.json",
      });
      t.mock.timers.tick(1_000);
      await flush();
      await instance.stop();
      await binding;
      const emitted = records().slice(start);
      for (const event of [
        "RPC retry wait scheduled",
        "RPC retry wait started",
        "RPC retry wait cancelled",
        "RPC attempt failed",
      ])
        assert.ok(
          emitted.some((record) => record.event === event),
          event,
        );
      for (const record of emitted.filter(
        (record) =>
          record.event.startsWith("RPC retry wait") ||
          record.event === "RPC attempt failed",
      ))
        assert.equal(record.assignmentId, "retry-original");
    },
  );

  await suite.test(
    "reconnection keeps its scheduled context after an Assignment changes",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info", retryLimit: 0 },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      instance.onAssignment({
        id: "reconnect-original",
        expectedFile: "absent.json",
      });
      await instance.startMonitoring("known");
      const start = records().length;
      native.sockets[0]!.terminate();
      await flush();
      instance.onAssignment({
        id: "reconnect-replacement",
        expectedFile: "new.json",
      });
      t.mock.timers.tick(10_000);
      await flush();
      const emitted = records().slice(start);
      for (const event of [
        "reconnect wait scheduled",
        "reconnect wait started",
        "transport reconnect start",
      ]) {
        const record = emitted.find((record) => record.event === event)!;
        assert.ok(record, event);
        assert.equal(record.assignmentId, "reconnect-original");
        assert.equal(record.turnId, "turn-1");
        assert.equal(record.sessionref, "known");
      }
      native.sockets.at(-1)!.terminate();
      await flush();
      instance.onAssignment({
        id: "another-replacement",
        expectedFile: "third.json",
      });
      await instance.stop();
      const cancelled = records()
        .slice(start)
        .find((record) => record.event === "reconnect wait cancelled")!;
      assert.equal(cancelled.assignmentId, "reconnect-replacement");
    },
  );
  await suite.test(
    "a readiness retry submits and fails under its scheduled Assignment",
    async (t) => {
      await nativeFixture(t);
      const bound = boundCapabilities();
      let submissions = 0;
      bound.io.submitText = () => {
        if (++submissions === 2)
          return Promise.reject(new Error("delayed terminal failure"));
        return Promise.resolve();
      };
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info", retryLimit: 0 },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      instance.onAssignment({
        id: "readiness-original",
        expectedFile: "absent.json",
      });
      await instance.startMonitoring("known");
      const start = records().length;
      const waiting = assert.rejects(
        instance.waitUntilReady(),
        /delayed terminal failure/,
      );
      instance.onAssignment({
        id: "microtask-replacement",
        expectedFile: "intermediate.json",
      });
      await flush();
      instance.onAssignment({
        id: "readiness-replacement",
        expectedFile: "new.json",
      });
      t.mock.timers.tick(2_000);
      await waiting;
      const emitted = records().slice(start);
      const logged = emitted.filter(
        (record) =>
          record.event.startsWith("readiness retry wait") ||
          record.event.startsWith("terminal submit"),
      );
      assert.deepEqual(
        logged.map((record) => [record.event, record.level]),
        [
          ["terminal submit", "info"],
          ["readiness retry wait scheduled", "info"],
          ["readiness retry wait started", "info"],
          ["terminal submit", "info"],
          ["terminal submit failed", "error"],
        ],
      );
      for (const record of logged) {
        assert.equal(record.assignmentId, "readiness-original");
        assert.equal(record.turnId, "turn-1");
      }
      assert.equal(submissions, 2);
    },
  );
  await suite.test(
    "a failed RPC attempt remains an error after a successful retry",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info", retryLimit: 0 },
      );
      t.after(() => instance.stop());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let reads = 0;
      native.handler = (request) => {
        if (request.method === "thread/read" && ++reads === 1)
          throw new Error("first attempt fails");
        return { thread: thread() };
      };
      const start = records().length;
      const binding = instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(1_000);
      await binding;
      const failures = records()
        .slice(start)
        .filter((record) => record.event === "RPC attempt failed");
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.level, "error");
      assert.equal(reads, 2);
      await instance.stop();
    },
  );
});
