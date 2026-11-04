import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, flush, nativeFixture } from "../fixtures/native.ts";

await test("awaited factory initialization failure releases its partial connection without native shutdown", async (t) => {
  const native = await nativeFixture(t);
  native.handler = () => {
    throw new Error("private native error");
  };
  await assert.rejects(
    createEnhancement(boundHost().host, { cwd: process.cwd(), env: {} }, {}),
    /RPC request failed/,
  );
  await flush();
  assert.equal(native.sockets[0]?.readyState, 3);
  assert.ok(
    native.launches.every(
      ({ args }) => !args.includes("stop") && !args.includes("restart"),
    ),
  );
});

await test("stop rejects an in-flight bound snapshot and late results cannot restore readiness", async (t) => {
  const native = await nativeFixture(t);
  let release!: (value: unknown) => void;
  const received = new Promise<void>((received) => {
    native.handler = (request) =>
      request.method === "thread/read"
        ? new Promise((resolve) => {
            release = resolve;
            received();
          })
        : {};
  });
  const bound = boundHost();
  const instance = await createEnhancement(
    bound.host,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const starting = assert.rejects(
    instance.startMonitoring("known"),
    /disconnected/,
  );
  await received;
  const waiting = assert.rejects(instance.waitUntilReady(), /stopped/);
  await flush();
  await Promise.all([instance.stop(), instance.stop()]);
  release({ thread: { id: "known", status: { type: "idle" }, turns: [] } });
  await starting;
  await waiting;
  await flush();
  assert.equal(native.sockets[0]?.readyState, 3);
  assert.equal(bound.inputs.length, 1);
});

await test("the default deadline is twenty seconds and zero recovery settings accept the whole shared options object", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundHost();
  const instance = await createEnhancement(
    bound.host,
    { cwd: process.cwd(), env: {} },
    {
      retryLimit: 0,
      retryDelay: [0],
      handoffRecoveryDelaySeconds: 0,
      anotherEnhancement: { enabled: true },
    },
  );
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finished = false;
  const waiting = assert
    .rejects(instance.waitUntilReady(), /timed out/)
    .then(() => {
      finished = true;
    });
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(native.launches.length, 2);
  await instance.stop();
});

await test("repeatable stop waits for its owned proxy to close", async (t) => {
  const native = await nativeFixture(t);
  const instance = await createEnhancement(
    boundHost().host,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const proxy = native.proxies[0]!;
  const kill = proxy.kill.bind(proxy);
  let release!: () => void;
  t.mock.method(proxy, "kill", () => {
    release = () => {
      kill();
    };
    return true;
  });
  const stopped = instance.stop();
  let finished = false;
  void stopped.then(() => {
    finished = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await Promise.all([stopped, instance.stop()]);
});

await test("large finite readiness deadlines do not overflow native timers", async (t) => {
  await nativeFixture(t);
  const instance = await createEnhancement(
    boundHost().host,
    { cwd: process.cwd(), env: {} },
    { readyTimeout: Number.MAX_VALUE },
  );
  await instance.startMonitoring();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let failure: unknown;
  const waiting = instance.waitUntilReady().catch((error: unknown) => {
    failure = error;
  });
  await flush();
  t.mock.timers.tick(1);
  await flush();
  assert.equal(failure, undefined);
  await instance.stop();
  await waiting;
  assert.match(String(failure), /stopped/);
});

await test("daemon startup timeout survives failed starter release without stopping the shared daemon", async (t) => {
  for (const release of ["throw", "refuse", "error", "close"]) {
    await t.test(release, async (t) => {
      const bound = boundHost();
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex]")) stderr.push(value);
        return true;
      });
      let kills = 0;
      const starter = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          kills++;
          if (release === "throw") throw new Error("private cleanup error");
          if (release === "error")
            starter.emit("error", new Error("private cleanup error"));
          if (release === "close") starter.emit("close", 0);
          return release === "close";
        },
      });
      t.after(() => {
        starter.stdin.destroy();
        starter.stdout.destroy();
        starter.stderr.destroy();
      });
      const spawn = t.mock.method(
        childProcess,
        "spawn",
        (command: string, args: readonly string[]) => {
          assert.equal(command, "codex");
          assert.deepEqual(args, ["app-server", "daemon", "start"]);
          return starter;
        },
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const failed = assert.rejects(
        createEnhancement(bound.host, { cwd: process.cwd(), env: {} }, {}),
        { message: "Codex daemon startup timed out" },
      );
      t.mock.timers.tick(9_999);
      assert.equal(kills, 0);
      assert.doesNotThrow(() => t.mock.timers.tick(1));
      await failed;
      assert.equal(kills, 1);
      assert.deepEqual(
        stderr,
        release === "close"
          ? []
          : ["[codex] sessionref=unbound initialization cleanup failed\n"],
      );
      starter.emit("close", 0);
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(spawn.mock.callCount(), 1);
      assert.equal(kills, 1);
      assert.deepEqual(bound.inputs, []);
      assert.equal(bound.recoveries, 0);
    });
  }
});
