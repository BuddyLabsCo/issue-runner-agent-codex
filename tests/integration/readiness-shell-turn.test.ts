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

await test("fresh bootstrap needs no completed-turn association for the UUID shell item", async (t) => {
  const native = await nativeFixture(t);
  const bound = bootstrapCapabilities(native, "found");
  let reads = 0;
  native.handler = (request) => {
    if (request.method === "thread/loaded/list") return { data: ["found"] };
    if (!bound.inputs[0]) return { thread: thread("found") };
    const snapshot = thread(
      "found",
      ++reads === 1
        ? [
            {
              type: "commandExecution",
              source: "userShell",
              command: bound.inputs[0]?.slice(1),
            },
          ]
        : [],
    );
    snapshot.turns = reads === 1 ? snapshot.turns : [];
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
  assert.equal(await instance.waitUntilReady(), "found");
  assert.equal(bound.inputs.length, 2);
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
    assert.equal(await waiting, "found");
    assert.equal(bound.inputs.length, 2);
  });
}

await test("a supplied shell-only session resumes without waiting for its turn to complete", async (t) => {
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
  await flush();
  native.notify("turn/started", {
    threadId: "known",
    turn: {
      id: "shell",
      status: "inProgress",
      items: [
        {
          type: "commandExecution",
          source: "userShell",
          command: bound.inputs[0]!.slice(1),
        },
      ],
    },
  });
  assert.equal(await waiting, "known");
  assert.equal(bound.inputs.length, 1);
});
