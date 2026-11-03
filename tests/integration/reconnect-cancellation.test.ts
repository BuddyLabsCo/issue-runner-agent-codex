import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, flush, nativeFixture, thread } from "../fixtures/native.ts";

await test("stop cancels each in-flight reattachment stage and ignores late responses", async (t) => {
  for (const stage of ["initialize", "thread/resume", "thread/read"]) {
    await t.test(stage, async (t) => {
      const native = await nativeFixture(t);
      const bound = boundHost();
      const stderr: string[] = [];
      t.mock.method(process.stderr, "write", (value: string) => {
        if (value.startsWith("[codex]")) stderr.push(value);
        return true;
      });
      const instance = await createEnhancement(
        bound.host,
        { cwd: process.cwd(), env: {} },
        {},
      );
      t.after(() => instance.stop());
      await instance.startMonitoring("known");
      instance.onAssignment("handoff.json");
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
