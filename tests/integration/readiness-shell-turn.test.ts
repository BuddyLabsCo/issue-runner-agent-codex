import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  bootstrapCapabilities,
  flush,
  nativeFixture,
  thread,
} from "../fixtures/native.ts";

await test("bootstrap waits for the GUID shell turn to end, ignoring unrelated completions", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const waiting = instance.waitUntilReady();
  void waiting.catch(() => undefined);
  await flush();
  const marker = {
    type: "commandExecution",
    source: "userShell",
    command: bound.inputs[0]!.slice(1),
  };
  native.notify("turn/started", {
    threadId: "known",
    turn: { id: "shell", status: "inProgress", items: [] },
  });
  native.notify("item/completed", {
    threadId: "known",
    turnId: "shell",
    item: marker,
  });
  await flush();
  assert.equal(bound.inputs.length, 1);
  native.notify("turn/completed", {
    threadId: "other",
    turn: { id: "shell", status: "completed", items: [marker] },
  });
  native.notify("turn/completed", {
    threadId: "known",
    turn: { id: "unrelated", status: "completed", items: [] },
  });
  await flush();
  assert.equal(bound.inputs.length, 1);
  native.notify("turn/completed", {
    threadId: "known",
    turn: { id: "shell", status: "completed", items: [marker] },
  });
  await flush();
  assert.equal(bound.inputs.length, 2);
  assert.match(bound.inputs[1]!, /Reply exactly READY/);
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "bootstrap",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: bound.inputs[1] }],
        },
      ],
    },
  });
  assert.equal(await waiting, "known");
});

for (const status of ["completed", "failed", "interrupted", "inProgress"]) {
  await test(`discovery handles a GUID shell turn with ${status} history`, async (t) => {
    const native = await nativeFixture(t);
    const bound = bootstrapCapabilities(native, "found");
    native.handler = (request) => {
      if (request.method === "thread/loaded/list") return { data: ["found"] };
      const snapshot = thread("found", [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]?.slice(1),
        },
      ]);
      snapshot.turns[0]!.status = status;
      return { thread: snapshot };
    };
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
      {},
    );
    t.after(() => instance.stop());
    await instance.startMonitoring();
    const waiting = instance.waitUntilReady();
    if (status === "inProgress") {
      await flush();
      await flush();
      assert.equal(bound.inputs.length, 1);
      native.notify("turn/completed", {
        threadId: "found",
        turn: { id: "turn-1", status: "completed", items: [] },
      });
    }
    assert.equal(await waiting, "found");
    assert.equal(bound.inputs.length, 2);
  });
}

await test("waiting for a shell turn preserves the readiness deadline and ignores late completion", async (t) => {
  const native = await nativeFixture(t);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { enhancementPause: bound.enhancementPause, cwd: process.cwd(), env: {} },
    { readyTimeout: 3 },
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const waiting = assert.rejects(instance.waitUntilReady(), /timed out/);
  await flush();
  const marker = {
    type: "commandExecution",
    source: "userShell",
    command: bound.inputs[0]!.slice(1),
  };
  native.notify("turn/started", {
    threadId: "known",
    turn: { id: "shell", status: "inProgress", items: [marker] },
  });
  await flush();
  assert.equal(bound.inputs.length, 1);
  t.mock.timers.tick(3_000);
  await waiting;
  native.notify("turn/completed", {
    threadId: "known",
    turn: { id: "shell", status: "completed", items: [] },
  });
  await flush();
  assert.equal(bound.inputs.length, 1);
});
