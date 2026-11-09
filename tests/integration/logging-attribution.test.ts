import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

interface Record {
  event: string;
  level: string;
  sessionref?: string;
  assignmentId?: string;
  turnId?: string;
  detail: { method?: string; message?: string };
}

await test("logging attribution across Assignment replacement", async (suite) => {
  const root = fs.mkdtempSync(join(process.cwd(), "attribution logs "));
  suite.after(async () => {
    await flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, "worktrees", "run", "ticket");
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
    "binding retains its originating Assignment after a pending resume completes",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      let releaseResume!: () => void;
      const resumeResult = new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      let resumeStarted!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resumeStarted = resolve;
      });
      native.handler = (request) => {
        if (request.method === "thread/resume") {
          resumeStarted();
          return resumeResult;
        }
        return request.method === "thread/read" ? { thread: thread() } : {};
      };
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd, env: {} },
        { logLevel: "info", retryLimit: 0 },
      );
      t.after(() => instance.stop());
      instance.onAssignment({
        id: "binding-original",
        expectedFile: "original.json",
      });
      const start = records().length;
      const binding = instance.startMonitoring("known");
      await resumed;
      instance.onAssignment({
        id: "binding-replacement",
        expectedFile: "replacement.json",
      });
      releaseResume();
      await binding;
      const attempts = records()
        .slice(start)
        .filter((record) => record.event === "RPC attempt");
      assert.deepEqual(
        attempts.map((record) => record.detail.method),
        ["thread/resume", "thread/read"],
      );
      for (const attempt of attempts) {
        assert.equal(attempt.assignmentId, "binding-original");
        assert.equal(attempt.sessionref, "known");
        assert.ok(!("turnId" in attempt));
      }
      await instance.stop();
    },
  );
  await suite.test(
    "delayed same-session notifications omit an unknown originating Assignment",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const snapshot = thread();
      snapshot.turns[0]!.id = "turn-original";
      native.snapshot = snapshot;
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd, env: {} },
        { logLevel: "info", retryLimit: 0 },
      );
      t.after(() => instance.stop());
      instance.onAssignment({
        id: "notification-original",
        expectedFile: "original.json",
      });
      await instance.startMonitoring("known");
      instance.onAssignment({
        id: "notification-replacement",
        expectedFile: "replacement.json",
      });
      native.notify("turn/started", {
        threadId: "known",
        turn: {
          id: "turn-replacement",
          status: "inProgress",
          error: null,
          items: [],
        },
      });
      await flush();
      const start = records().length;
      for (const method of ["error", "configWarning"]) {
        native.notify(method, {
          threadId: "known",
          turnId: "turn-original",
          message: "delayed original turn",
        });
        native.notify(method, {
          threadId: "known",
          turnId: "turn-replacement",
          message: "current turn",
        });
      }
      await flush();
      const emitted = records()
        .slice(start)
        .filter((record) => record.event === "native service notification");
      const delayed = emitted.filter(
        (record) => record.detail.message === "delayed original turn",
      );
      const current = emitted.filter(
        (record) => record.detail.message === "current turn",
      );
      assert.equal(delayed.length, 2);
      assert.equal(current.length, 2);
      for (const record of delayed) {
        assert.equal(record.sessionref, "known");
        assert.equal(record.turnId, "turn-original");
        assert.ok(!("assignmentId" in record));
      }
      for (const record of current) {
        assert.equal(record.assignmentId, "notification-replacement");
        assert.equal(record.sessionref, "known");
        assert.equal(record.turnId, "turn-replacement");
      }
      assert.deepEqual(
        delayed.map((record) => record.level),
        ["error", "info"],
      );
      await instance.stop();
    },
  );
});
