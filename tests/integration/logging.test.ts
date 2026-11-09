import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { connectNative } from "../../src/codex/client.ts";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, flush, nativeFixture } from "../fixtures/native.ts";

await test("process logging", async (suite) => {
  const root = await mkdtemp(join(process.cwd(), "tab logs "));
  suite.after(async () => {
    await flush();
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "worktrees", "run", "ticket");

  await suite.test(
    "Tabs share a contextual JSONL log across reconnect and replacement",
    async (t) => {
      const native = await nativeFixture(t);
      const messages: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        messages.push(value);
        return true;
      });
      const spawn = childProcess.spawn;
      t.mock.method(
        childProcess,
        "spawn",
        (...args: Parameters<typeof spawn>) => {
          if (args[0] === "codex") {
            assert.ok(fs.readdirSync(join(root, "logs")).length > 0);
            assert.ok(
              !messages.some((line) => line.startsWith("[codex]: logfile:")),
            );
          }
          const child = spawn(...args);
          if (args[0] === "codex" && args[1]?.includes("daemon")) {
            queueMicrotask(() => {
              child.stderr?.emit(
                "data",
                Buffer.from("original daemon stderr\n"),
              );
              child.emit("exit", 0, null);
            });
          }
          return child;
        },
      );
      const context = { cwd, env: {} };
      const bound = boundCapabilities();
      const first = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info" },
      );
      const second = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info" },
      );
      t.after(() => first.stop());
      t.after(() => second.stop());
      const files = await readdir(join(root, "logs"));
      assert.equal(files.length, 1);
      assert.match(
        files[0]!,
        /^agent-codex-log-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.jsonl$/,
      );
      assert.ok(!messages.some((line) => line.startsWith("[codex]: logfile:")));
      const error = new Error("original transport secret", {
        cause: new Error("nested cause"),
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      native.proxies[0]!.stderr.emit(
        "data",
        Buffer.from("original proxy stderr\n"),
      );
      native.proxies[0]!.emit("error", error);
      await flush();
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(native.proxies.length, 3);
      assert.deepEqual(await readdir(join(root, "logs")), files);
      const text = (
        await Promise.all(
          files.map((name) => readFile(join(root, "logs", name), "utf8")),
        )
      ).join("");
      assert.match(text, /original transport secret/);
      assert.match(text, /nested cause/);
      assert.match(text, /original proxy stderr/);
      assert.match(text, /original daemon stderr/);
      assert.match(text, /daemon starter exit/);
      assert.match(text, /proxy close/);
      assert.match(text, /stack/);
      assert.ok(
        text
          .trim()
          .split("\n")
          .every((line) => typeof JSON.parse(line) === "object"),
      );
      const records = text
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              runId: string;
              instanceId: string;
              cwd: string;
            },
        );
      assert.equal(new Set(records.map((record) => record.runId)).size, 1);
      assert.equal(new Set(records.map((record) => record.instanceId)).size, 2);
      assert.ok(records.every((record) => record.cwd === cwd));
      await first.stop();
      await second.stop();
      const replacement = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        context,
        { logLevel: "info" },
      );
      await replacement.stop();
      assert.deepEqual(await readdir(join(root, "logs")), files);
      const replaced = (await readFile(join(root, "logs", files[0]!), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { runId: string; instanceId: string },
        );
      assert.equal(new Set(replaced.map((record) => record.runId)).size, 1);
      assert.equal(
        new Set(replaced.map((record) => record.instanceId)).size,
        3,
      );

      assert.ok(
        messages.every(
          (line) => !line.includes("secret") && !line.includes("nested cause"),
        ),
      );
    },
  );

  await suite.test(
    "log append failure does not interrupt the workflow",
    async (t) => {
      await nativeFixture(t);
      const messages: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        messages.push(value);
        return true;
      });
      t.mock.method(fs, "appendFileSync", () => {
        throw new Error("private disk error");
      });
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        { logLevel: "info" },
      );
      await instance.stop();
      assert.equal(
        messages.some((line) => line.startsWith("[codex]: logfile:")),
        false,
      );
      assert.ok(messages.some((line) => line.includes("log write failed")));
      assert.ok(messages.every((line) => !line.includes("private disk error")));
    },
  );

  await suite.test(
    "service code, message and data survive retry exhaustion without terminal disclosure",
    async (t) => {
      const native = await nativeFixture(t);
      const messages: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        messages.push(value);
        return true;
      });
      const client = await connectNative({ cwd: process.cwd(), env: {} });
      t.after(() => client.close());
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const original = {
        code: -32001,
        message: "original service secret",
        data: {
          authorization: "raw secret",
          nested: { message: "nested service detail" },
        },
      };
      native.hooksHandler = (request) => {
        native.sockets[0]!.send(
          JSON.stringify({ id: request.id, error: original }),
        );
        return new Promise(() => undefined);
      };
      const failed = assert.rejects(
        client.request("hooks/list", {}),
        /RPC request failed/,
      );
      await flush();
      for (let i = 0; i < 2; i++) {
        t.mock.timers.tick(1_000);
        await flush();
      }
      await failed;
      const address = join(
        root,
        "logs",
        (await readdir(join(root, "logs")))[0]!,
      );
      const records = (await readFile(address, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              event: string;
              detail: { attempt: number; error: { cause: unknown } };
            },
        );
      const attempts = records.filter(
        (record) => record.event === "RPC attempt failed",
      );
      assert.deepEqual(
        attempts.map((record) => record.detail.attempt),
        [1, 2, 3],
      );
      assert.deepEqual(attempts[0]!.detail.error.cause, original);
      assert.equal(messages.length, 0);
    },
  );

  await suite.test(
    "an unavailable stderr cannot turn log failure into a lifecycle failure",
    async (t) => {
      await nativeFixture(t);
      const stderr = t.mock.method(process.stderr, "write", () => {
        throw new Error("stderr unavailable");
      });
      const append = t.mock.method(fs, "appendFileSync", () => {
        throw new Error("disk unavailable");
      });
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        { logLevel: "info" },
      );
      await instance.stop();
      assert.ok(append.mock.callCount() > 0);
      assert.ok(
        stderr.mock.calls.some(
          ({ arguments: [message] }) =>
            String(message) === "[codex] sessionref=unbound log write failed\n",
        ),
      );
    },
  );
  await suite.test(
    "unrelated native errors do not inherit the bound Assignment",
    async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd, env: {} },
        {},
      );
      t.after(() => instance.stop());
      instance.onAssignment({
        id: "bound-assignment",
        expectedFile: "absent.json",
      });
      await instance.startMonitoring("known");
      native.notify("error", {
        threadId: "other-session",
        turnId: "other-turn",
        message: "original native failure",
      });
      await flush();
      const entries = fs.readdirSync(join(root, "logs")).flatMap((name) =>
        fs
          .readFileSync(join(root, "logs", name), "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                event: string;
                level: string;
                sessionref?: string;
                turnId?: string;
                assignmentId?: string;
              },
          ),
      );
      const error = entries.find(
        (record) => record.event === "native service notification",
      )!;
      assert.equal(error.level, "error");
      assert.equal(error.sessionref, "other-session");
      assert.equal(error.turnId, "other-turn");
      assert.ok(!("assignmentId" in error));
      await instance.stop();
    },
  );
});
