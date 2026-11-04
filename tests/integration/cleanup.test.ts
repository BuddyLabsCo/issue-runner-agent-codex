import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { Duplex } from "node:stream";
import { recoveryFixture } from "../fixtures/recovery.ts";
import { createEnhancement } from "../../src/index.ts";
import { boundCapabilities, flush, nativeFixture } from "../fixtures/native.ts";

await test("concurrent stops share failure and retry unfinished native releases", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const proxy = native.proxies[0]!;
  const kill = proxy.kill.bind(proxy);
  const failure = new Error("transient proxy release failure");
  const release = t.mock.method(proxy, "kill", kill);
  release.mock.mockImplementationOnce(() => {
    throw failure;
  });
  const first = instance.stop();
  const concurrent = instance.stop();
  assert.equal(first, concurrent);
  await assert.rejects(first, (error) => error === failure);
  await assert.rejects(concurrent, (error) => error === failure);
  await assert.rejects(instance.startMonitoring("known"), /stopped/);
  await assert.rejects(instance.waitUntilReady(), /stopped/);
  assert.throws(
    () =>
      instance.onAssignment({
        id: "assignment-1",
        expectedFile: "handoff.json",
      }),
    /stopped/,
  );
  assert.deepEqual(bound.inputs, []);
  assert.equal(bound.recoveries, 0);
  release.mock.mockImplementation(kill);
  await instance.stop();
  await instance.stop();
  assert.equal(release.mock.callCount(), 2);
  await flush();
  assert.equal(native.sockets[0]!.readyState, 3);
});

await test("a failed socket release does not prevent proxy cleanup or repeat it on retry", async (t) => {
  const native = await nativeFixture(t);
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const kill = t.mock.method(native.proxies[0]!, "kill");
  const terminate = t.mock.method(WebSocket.prototype, "terminate");
  const failure = new Error("socket release failed");
  terminate.mock.mockImplementationOnce(() => {
    throw failure;
  });
  await assert.rejects(instance.stop(), (error) => error === failure);
  assert.equal(kill.mock.callCount(), 1);
  await instance.stop();
  await instance.stop();
  assert.equal(kill.mock.callCount(), 1);
  assert.equal(terminate.mock.callCount(), 2);
});

await test("stop waits for issued readiness input to settle without sending replacement input", async (t) => {
  for (const rejects of [false, true]) {
    await t.test(String(rejects), async (t) => {
      await nativeFixture(t);
      const bound = boundCapabilities();
      let settle!: () => void;
      const input = new Promise<void>((resolve, reject) => {
        settle = rejects ? () => reject(new Error("input failed")) : resolve;
      });
      const submit = bound.io.submitText.bind(bound.io);
      bound.io.submitText = async (text) => {
        await submit(text);
        await input;
      };
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        {},
      );
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const ready = assert.rejects(instance.waitUntilReady(), /stopped/);
      await flush();
      assert.equal(bound.inputs.length, 1);
      let finished = false;
      const stopped = instance.stop().finally(() => {
        finished = true;
      });
      await flush();
      assert.equal(finished, false);
      settle();
      await stopped;
      await ready;
      await instance.stop();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(bound.inputs.length, 1);
      assert.deepEqual(bound.keys, []);
      assert.equal(bound.recoveries, 0);
    });
  }
});

await test("initialization and preflight errors survive cleanup failure with a separate diagnostic", async (t) => {
  for (const stage of ["initialize", "preflight"]) {
    await t.test(stage, async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex]")) stderr.push(value);
        return true;
      });
      const fail = () => {
        const kill = t.mock.method(native.proxies[0]!, "kill");
        kill.mock.mockImplementationOnce(() => {
          throw new Error("private cleanup failure");
        });
        throw new Error("private initialization failure");
      };
      if (stage === "initialize") native.handler = fail;
      else native.configHandler = fail;
      await assert.rejects(
        createEnhancement(
          bound.io,
          bound.requestRecovery,
          { cwd: process.cwd(), env: {} },
          {},
        ),
        /Codex RPC request failed/,
      );
      await flush();
      assert.deepEqual(stderr, [
        "[codex] sessionref=unbound initialization cleanup failed\n",
      ]);
      assert.equal(native.proxies[0]!.stdin.destroyed, true);
      assert.equal(native.proxies[0]!.stdout.destroyed, true);
      assert.deepEqual(bound.inputs, []);
      assert.equal(bound.recoveries, 0);
      assert.ok(native.launches.every(({ args }) => !args.includes("stop")));
    });
  }
});

await test("factory releases an allocated proxy when connection construction throws", async (t) => {
  const native = await nativeFixture(t);
  const failure = new Error("connection construction failed");
  let releases = 0;
  t.mock.method(Duplex, "from", () => {
    const proxy = native.proxies[0]!;
    const kill = proxy.kill.bind(proxy);
    t.mock.method(proxy, "kill", () => {
      releases++;
      return kill();
    });
    throw failure;
  });
  await assert.rejects(
    createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    ),
    (error) => error === failure,
  );
  assert.equal(releases, 1);
});

await test("a refused proxy release fails unless its close event already confirmed exit", async (t) => {
  for (const exited of [false, true]) {
    await t.test(String(exited), async (t) => {
      const native = await nativeFixture(t);
      const instance = await createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        { cwd: process.cwd(), env: {} },
        {},
      );
      const proxy = native.proxies[0]!;
      const kill = t.mock.method(proxy, "kill");
      kill.mock.mockImplementationOnce(() => false);
      if (exited) proxy.emit("close", 0);
      if (exited) await instance.stop();
      else await assert.rejects(instance.stop(), /proxy release failed/);
      await instance.stop();
      assert.equal(kill.mock.callCount(), exited ? 1 : 2);
    });
  }
});

await test("cleanup failure remains retryable when recovery fails before or during stop", async (t) => {
  for (const historical of [true, false]) {
    await t.test(String(historical), async (t) => {
      const { instance, native, bound, stderr } = await recoveryFixture(t);
      const operationFailure = new Error("private recovery failure");
      let rejectInput!: () => void;
      const input = new Promise<void>((resolve, reject) => {
        rejectInput = () => reject(operationFailure);
      });
      const request = bound.recovery.request;
      bound.recovery.request = async (id) => {
        await request(id);
        await input;
      };
      await instance.startMonitoring("known");
      t.mock.timers.tick(10_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
      if (historical) {
        rejectInput();
        await flush();
        await assert.rejects(
          instance.waitUntilReady(),
          (error) => error === operationFailure,
        );
      }
      const cleanupFailure = new Error("private cleanup failure");
      const kill = t.mock.method(native.proxies[0]!, "kill");
      kill.mock.mockImplementationOnce(() => {
        throw cleanupFailure;
      });
      const stopped = instance.stop();
      assert.equal(stopped, instance.stop());
      let finished = false;
      const failure = assert
        .rejects(stopped, (error) => error === cleanupFailure)
        .then(() => {
          finished = true;
        });
      await flush();
      if (!historical) {
        assert.equal(finished, false);
        rejectInput();
      }
      await failure;
      assert.ok(
        stderr.includes("[codex] sessionref=known recovery operation failed\n"),
      );
      assert.ok(stderr.every((line) => !line.includes("private")));
      await instance.stop();
      await instance.stop();
      assert.equal(kill.mock.callCount(), 2);
      t.mock.timers.tick(100_000);
      await flush();
      assert.deepEqual(bound.recoveryIds, ["assignment-1"]);
    });
  }
});

await test("stop shares an in-flight reconnect release and never opens its replacement proxy", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const proxy = native.proxies[0]!;
  const emit = proxy.emit.bind(proxy);
  let release!: () => void;
  t.mock.method(proxy, "emit", (event: string, ...args: unknown[]) => {
    if (event === "close") {
      release = () => {
        emit(event, ...args);
      };
      return true;
    }
    return emit(event, ...args);
  });
  const delayed = t.mock.method(proxy, "kill");
  native.sockets[0]!.close();
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  const stopped = instance.stop();
  assert.equal(stopped, instance.stop());
  assert.equal(delayed.mock.callCount(), 1);
  release();
  await stopped;
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(native.proxies.length, 1);
  assert.equal(delayed.mock.callCount(), 1);
  assert.deepEqual(bound.inputs, []);
  assert.equal(bound.recoveries, 0);
});

await test("immediate stop and its cleanup retry leave another enhancement usable", async (t) => {
  const native = await nativeFixture(t);
  const first = boundCapabilities();
  const second = boundCapabilities();
  const context = { cwd: process.cwd(), env: {} };
  const stopped = await createEnhancement(
    first.io,
    first.requestRecovery,
    context,
    {},
  );
  const active = await createEnhancement(
    second.io,
    second.requestRecovery,
    context,
    {},
  );
  const kill = t.mock.method(native.proxies[0]!, "kill");
  kill.mock.mockImplementationOnce(() => {
    throw new Error("cleanup failed");
  });
  await assert.rejects(stopped.stop(), /cleanup failed/);
  assert.equal(
    native.requests.some(({ method }) => method.startsWith("thread/")),
    false,
  );
  await active.startMonitoring("known");
  const ready = active.waitUntilReady();
  await flush();
  native.notify("item/completed", {
    threadId: "known",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: second.inputs[0]!.slice(1),
    },
  });
  await stopped.stop();
  assert.equal(await ready, "known");
  assert.deepEqual(first.inputs, []);
  assert.equal(first.recoveries, 0);
  assert.ok(
    native.launches.every(
      ({ args }) => !args.includes("stop") && !args.includes("restart"),
    ),
  );
  await active.stop();
});

await test("stop reports all remaining release failures and retries them together", async (t) => {
  const native = await nativeFixture(t);
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  const socketFailure = new Error("socket cleanup failed");
  const proxyFailure = new Error("proxy cleanup failed");
  const terminate = t.mock.method(WebSocket.prototype, "terminate");
  terminate.mock.mockImplementationOnce(() => {
    throw socketFailure;
  });
  const kill = t.mock.method(native.proxies[0]!, "kill");
  kill.mock.mockImplementationOnce(() => {
    throw proxyFailure;
  });
  await assert.rejects(instance.stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [socketFailure, proxyFailure]);
    return true;
  });
  await instance.stop();
  assert.equal(terminate.mock.callCount(), 2);
  assert.equal(kill.mock.callCount(), 2);
});
