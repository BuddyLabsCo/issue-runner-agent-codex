import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("public binding cannot bypass pending reconnect initialization", async (t) => {
  for (const ref of [undefined, "known"]) {
    await t.test(ref ?? "unbound", async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        { retryLimit: 0 },
      );
      t.after(() => instance.stop());
      await instance.startMonitoring(ref);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      native.sockets[0]!.close();
      await flush();
      const before = native.requests.length;
      let release!: (value: unknown) => void;
      const initializing = new Promise<void>((received) => {
        native.handler = (request) => {
          if (request.method !== "initialize") return { thread: thread() };
          received();
          return new Promise((resolve) => {
            release = resolve;
          });
        };
      });
      t.mock.timers.tick(10_000);
      await initializing;
      await assert.rejects(instance.startMonitoring("known"), /unavailable/);
      await assert.rejects(instance.waitUntilReady(), /unavailable/);
      assert.deepEqual(
        native.requests.slice(before).map(({ method }) => method),
        ["initialize"],
      );
      assert.deepEqual(bound.inputs, []);
      release({});
      await flush();
      await instance.startMonitoring("known");
      assert.deepEqual(
        native.requests.slice(before).map(({ method }) => method),
        ["initialize", "initialized", "thread/resume", "thread/read"],
      );
      await instance.stop();
    });
  }
});

await test("stop cancels each in-flight reattachment stage and ignores late responses", async (t) => {
  for (const stage of ["initialize", "thread/resume", "thread/read"]) {
    await t.test(stage, async (t) => {
      const native = await nativeFixture(t);
      const bound = boundCapabilities();
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex] ")) stderr.push(value);
        return true;
      });
      const instance = await createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        {},
      );
      t.after(() => instance.stop());
      await instance.startMonitoring("known");
      instance.onAssignment({
        id: "handoff.json",
        expectedFile: "handoff.json",
      });
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      native.sockets[0]!.close();
      await flush();
      let release!: (value: unknown) => void;
      const pending = new Promise<void>((received) => {
        native.handler = (request) => {
          if (request.method !== stage) return { thread: thread() };
          received();
          return new Promise((resolve) => {
            release = resolve;
          });
        };
      });
      t.mock.timers.tick(10_000);
      await pending;
      await Promise.all([instance.stop(), instance.stop()]);
      const requests = native.requests.length;
      release({ thread: thread() });
      await flush();
      t.mock.timers.tick(100_000);
      await flush();
      assert.equal(native.proxies.length, 2);
      assert.equal(native.requests.length, requests);
      assert.ok(native.sockets.every((socket) => socket.readyState === 3));
      assert.equal(bound.recoveries, 0);
      assert.deepEqual(stderr, [
        "[codex] sessionref=known observation disconnected\n",
      ]);
      await assert.rejects(instance.waitUntilReady(), /stopped/);
    });
  }
});
