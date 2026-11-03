import assert from "node:assert/strict";
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
