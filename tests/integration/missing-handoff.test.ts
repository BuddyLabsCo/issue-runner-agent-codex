import assert from "node:assert/strict";
import { test } from "node:test";
import { flush } from "../fixtures/native.ts";
import { recoveryFixture } from "../fixtures/recovery.ts";

await test("missing handoffs wait 120 seconds before each of three argument-free Host submissions", async (t) => {
  const { instance, state, bound, stderr, native } = await recoveryFixture(t);
  state.snapshot.turns[0]!.status = "completed";
  const calls: unknown[][] = [];
  const request = bound.host.requestRecovery.bind(bound.host);
  bound.host.requestRecovery = (...args: unknown[]) => {
    calls.push(args);
    return request();
  };
  await instance.startMonitoring("known");
  await flush();
  for (let attempt = 1; attempt <= 3; attempt++) {
    t.mock.timers.tick(119_999);
    await flush();
    assert.equal(bound.recoveries, attempt - 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(bound.recoveries, attempt);
  }
  assert.deepEqual(calls, [[], [], []]);
  assert.deepEqual(bound.inputs, []);
  assert.deepEqual(stderr, [
    "[codex] sessionref=known recovery=missing-handoff attempt=1/3\n",
    "[codex] sessionref=known recovery=missing-handoff attempt=2/3\n",
    "[codex] sessionref=known recovery=missing-handoff attempt=3/3\n",
    "[codex] sessionref=known recovery=missing-handoff exhausted=3/3\n",
  ]);
  t.mock.timers.tick(1_000_000);
  await flush();
  assert.equal(bound.recoveries, 3);
  assert.ok(
    native.requests.every(
      ({ method }) => !["turn/start", "turn/steer"].includes(method),
    ),
  );
});

await test("only the literal prefix of the complete latest final assistant reply requests human action", async (t) => {
  for (const [text, phase, paused] of [
    ["[action required] Choose a deployment.", "final_answer", true],
    [" \n\t[action required]\n" + "details ".repeat(10_000), null, true],
    ["[action required] Legacy final reply", undefined, true],
    ["[Action Required] Case differs", "final_answer", false],
    ["Text before [action required]", "final_answer", false],
    ["[action required ] Extra space", "final_answer", false],
    ["```\n[action required]\n```", "final_answer", false],
    ["[action required] Still working", "commentary", false],
    ["[action required] Partial answer", "partial_answer", false],
  ] as const) {
    await t.test(`${String(phase)}/${text.slice(0, 40)}`, async (t) => {
      const { instance, state, bound, stderr } = await recoveryFixture(t, {
        retryLimit: 1,
        handoffRecoveryDelaySeconds: 2,
      });
      state.snapshot.turns[0]!.status = "completed";
      state.snapshot.turns[0]!.items = [
        { id: "old", type: "agentMessage", text: "An older reply" },
        { id: "latest", type: "agentMessage", phase, text },
        { id: "user", type: "userMessage", text: "[action required]" },
      ];
      await instance.startMonitoring("known");
      await flush();
      t.mock.timers.tick(2_000);
      await flush();
      assert.equal(bound.recoveries, paused ? 0 : 1);
      assert.deepEqual(
        stderr,
        paused
          ? ["[codex] sessionref=known ACTION REQUIRED!!!\n"]
          : [
              "[codex] sessionref=known recovery=missing-handoff attempt=1/1\n",
              "[codex] sessionref=known recovery=missing-handoff exhausted=1/1\n",
            ],
      );
    });
  }
});
