import { boundCapabilities } from "../fixtures/native.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectNative } from "../../src/codex/client.ts";
import { flush, nativeFixture } from "../fixtures/native.ts";

for (const method of [
  "hooks/list",
  "config/read",
  "thread/read",
  "thread/loaded/list",
]) {
  for (const failures of [1, 2, 3]) {
    await test(`${method} retries service errors up to three attempts (${failures} failures)`, async (t) => {
      const native = await nativeFixture(t);
      const client = await connectNative({
        enhancementPause: boundCapabilities().enhancementPause,
        cwd: process.cwd(),
        env: {},
      });
      t.after(() => client.close());
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let calls = 0;
      const handler = () => {
        if (++calls <= failures) throw new Error("service failure");
        return { success: true };
      };
      native.hooksHandler = handler;
      native.configHandler = handler;
      native.handler = handler;
      const result = client.request(method, {});
      const outcome =
        failures === 3 ? assert.rejects(result, /RPC request failed/) : result;
      await flush();
      for (let i = 1; i < Math.min(failures + 1, 3); i++) {
        assert.equal(calls, i);
        t.mock.timers.tick(999);
        await flush();
        assert.equal(calls, i);
        t.mock.timers.tick(1);
        await flush();
      }
      if (failures < 3) assert.deepEqual(await outcome, { success: true });
      else await outcome;
      assert.equal(calls, Math.min(failures + 1, 3));
      assert.equal(
        new Set(
          native.requests
            .map((request) => request.id)
            .filter((id) => id !== undefined),
        ).size,
        calls + 1,
      );
    });
  }
}

for (const mode of ["stop", "disconnect", "replacement"]) {
  await test(`${mode} cancels retries from the old connection`, async (t) => {
    const native = await nativeFixture(t);
    const client = await connectNative({
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    });
    t.after(() => client.close());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    native.hooksHandler = () => {
      throw new Error("service failure");
    };
    const result = assert.rejects(client.request("hooks/list", {}));
    await flush();
    if (mode === "stop") await client.close();
    else {
      native.sockets[0]!.close();
      await flush();
      if (mode === "replacement") await client.reconnect();
    }
    await result;
    t.mock.timers.tick(100_000);
    await flush();
    assert.equal(
      native.requests.filter((request) => request.method === "hooks/list")
        .length,
      1,
    );
  });
}

await test("timeouts use fresh IDs and late replies cannot settle parallel requests", async (t) => {
  const native = await nativeFixture(t);
  const client = await connectNative({
    enhancementPause: boundCapabilities().enhancementPause,
    cwd: process.cwd(),
    env: {},
  });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const releases: ((result: unknown) => void)[] = [];
  native.handler = () =>
    new Promise((resolve) => {
      releases.push(resolve);
    });
  const first = client.request("thread/read", {});
  const second = client.request("thread/loaded/list", {});
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(releases.length, 2);
  t.mock.timers.tick(1);
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(releases.length, 4);
  releases[0]!({ stale: true });
  releases[1]!({ stale: true });
  releases[3]!({ second: true });
  releases[2]!({ first: true });
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(await second, { second: true });
});

for (const method of ["initialize", "config/value/write", "thread/resume"]) {
  await test(`${method} is never retried`, async (t) => {
    const native = await nativeFixture(t);
    const client = await connectNative({
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    });
    t.after(() => client.close());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    native.handler = native.configHandler = () => {
      throw new Error("service failure");
    };
    await assert.rejects(client.request(method, {}));
    t.mock.timers.tick(100_000);
    await flush();
    assert.equal(
      native.requests.filter((request) => request.method === method).length,
      method === "initialize" ? 2 : 1,
    );
  });
}

await test("persistent timeouts stop after three ten-second attempts", async (t) => {
  const native = await nativeFixture(t);
  const client = await connectNative({
    enhancementPause: boundCapabilities().enhancementPause,
    cwd: process.cwd(),
    env: {},
  });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  native.handler = () => new Promise(() => undefined);
  const failed = assert.rejects(client.request("thread/read", {}), /timed out/);
  await flush();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(
      native.requests.filter((request) => request.method === "thread/read")
        .length,
      attempt,
    );
    t.mock.timers.tick(9_999);
    await flush();
    assert.equal(
      native.requests.filter((request) => request.method === "thread/read")
        .length,
      attempt,
    );
    t.mock.timers.tick(1);
    await flush();
    if (attempt < 3) {
      t.mock.timers.tick(1_000);
      await flush();
    }
  }
  await failed;
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(
    native.requests.filter((request) => request.method === "thread/read")
      .length,
    3,
  );
});
