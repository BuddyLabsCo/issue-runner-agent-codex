import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { connectNative } from "../../src/codex/client.ts";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, flush, nativeFixture } from "../fixtures/native.ts";

await test("Tabs create distinct JSONL logs before connection and reconnect reuses the file", async (t) => {
  const native = await nativeFixture(t);
  const root = await mkdtemp(join(process.cwd(), "tab logs "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "worktrees", "run", "ticket");
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (value: string) => {
    messages.push(value);
    return true;
  });
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (args[0] === "codex") {
      assert.ok(fs.readdirSync(join(root, "logs")).length > 0);
      assert.ok(messages.some((line) => line.startsWith("[codex]: logfile:")));
    }
    const child = spawn(...args);
    if (args[0] === "codex" && args[1]?.includes("daemon")) {
      queueMicrotask(() => {
        child.stderr?.emit("data", Buffer.from("original daemon stderr\n"));
        child.emit("exit", 0, null);
      });
    }
    return child;
  });
  const context = { cwd, env: {} };
  const bound = boundCapabilities();
  const first = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    context,
    {},
  );
  const second = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    context,
    {},
  );
  t.after(() => first.stop());
  t.after(() => second.stop());
  const files = await readdir(join(root, "logs"));
  assert.equal(files.length, 2);
  for (const name of files) {
    assert.match(name, /^[\w.-]+\.jsonl$/);
    assert.ok(
      messages.includes(`[codex]: logfile: ${resolve(root, "logs", name)}\n`),
    );
  }
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
  await first.stop();
  await second.stop();
  assert.ok(
    messages.every(
      (line) => !line.includes("secret") && !line.includes("nested cause"),
    ),
  );
});

for (const stage of ["creation", "append"] as const) {
  await test(`log ${stage} failure does not interrupt the workflow`, async (t) => {
    await nativeFixture(t);
    const messages: string[] = [];
    t.mock.method(process.stderr, "write", (value: string) => {
      messages.push(value);
      return true;
    });
    t.mock.method(
      fs,
      stage === "creation" ? "writeFileSync" : "appendFileSync",
      () => {
        throw new Error("private disk error");
      },
    );
    const bound = boundCapabilities();
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    await instance.stop();
    assert.equal(
      messages.some((line) => line.startsWith("[codex]: logfile:")),
      stage !== "creation",
    );
    assert.ok(messages.every((line) => !line.includes("private disk error")));
  });
}

await test("service code, message and data survive retry exhaustion without terminal disclosure", async (t) => {
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
  const address = messages
    .find((line) => line.startsWith("[codex]: logfile:"))!
    .trim()
    .slice("[codex]: logfile: ".length);
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
  assert.equal(messages.length, 1);
});

await test("an unavailable stderr cannot turn log failure into a lifecycle failure", async (t) => {
  await nativeFixture(t);
  t.mock.method(process.stderr, "write", () => {
    throw new Error("stderr unavailable");
  });
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  await instance.stop();
});
