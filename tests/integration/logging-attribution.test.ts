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
      const snapshot = thread();
      const history = {
        ...snapshot,
        turns: [
          {
            ...snapshot.turns[0]!,
            error: { message: "historical turn failure" },
          },
        ],
      };
      native.handler = (request) => {
        if (request.method === "thread/resume") {
          resumeStarted();
          return resumeResult;
        }
        return request.method === "thread/read" ? { thread: history } : {};
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
      const historicalFailure = records().find(
        (record) => record.event === "native turn error",
      )!;
      assert.ok(historicalFailure);
      assert.ok(!("assignmentId" in historicalFailure));
      native.notify("error", {
        threadId: "known",
        turnId: "turn-1",
        message: "unattributed history",
      });
      await flush();
      const historical = records().find(
        (record) => record.detail?.message === "unattributed history",
      )!;
      assert.ok(historical);
      assert.ok(!("assignmentId" in historical));
      await instance.stop();
    },
  );
  await suite.test(
    "delayed notifications preserve known turn Assignments and omit unknown ones",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const snapshot = thread();
      snapshot.turns = [];
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
      native.notify("turn/started", {
        threadId: "known",
        turn: {
          id: "turn-original",
          status: "inProgress",
          error: null,
          items: [],
        },
      });
      await flush();
      instance.onAssignment({
        id: "notification-replacement",
        expectedFile: "replacement.json",
      });
      const replacementStart = records().length;
      for (const method of ["error", "configWarning"]) {
        native.notify(method, {
          threadId: "known",
          turnId: "turn-original",
          message: "before replacement turn",
        });
      }
      native.notify("turn/completed", {
        threadId: "known",
        turn: {
          id: "turn-original",
          status: "failed",
          error: { message: "failure before replacement turn" },
          items: [],
        },
      });
      await flush();
      const turnFailure = records()
        .slice(replacementStart)
        .find((record) => record.event === "native turn error")!;
      assert.ok(turnFailure);
      assert.equal(turnFailure.assignmentId, "notification-original");
      assert.equal(turnFailure.turnId, "turn-original");
      const beforeTurn = records()
        .slice(replacementStart)
        .filter((record) => record.event === "native service notification");
      assert.equal(beforeTurn.length, 2);
      for (const record of beforeTurn) {
        assert.equal(record.assignmentId, "notification-original");
        assert.equal(record.turnId, "turn-original");
        assert.equal(record.sessionref, "known");
      }
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
