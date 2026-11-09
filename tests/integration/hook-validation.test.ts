import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  bootstrapCapabilities,
  flush,
  hook,
  nativeFixture,
} from "../fixtures/native.ts";

const inventoryErrors = [
  {
    path: "/secret/hook.json",
    message: "original hook parse error",
    code: "PARSE_FAILURE",
    data: { line: 7 },
  },
];

async function assertReadyWithHookFailure(
  t: TestContext,
  native: Awaited<ReturnType<typeof nativeFixture>>,
  expectedMessage: string,
  originalErrors?: unknown,
): Promise<void> {
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (message: string) => {
    messages.push(message);
    return true;
  });
  const bound = bootstrapCapabilities(native);
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  t.after(() => instance.stop());
  await instance.startMonitoring("known");
  const ready = instance.waitUntilReady();
  await flush();
  native.notify("item/completed", {
    threadId: "known",
    item: {
      type: "commandExecution",
      source: "userShell",
      command: bound.inputs[0]!.slice(1),
    },
  });
  assert.equal(await ready, "known");
  assert.deepEqual(
    messages.filter((message) => message.startsWith("[codex] ")),
    ["[codex] sessionref=unbound hook preflight failed\n"],
  );
  const address = messages
    .find((message) => message.startsWith("[codex]: logfile:"))!
    .trim()
    .slice("[codex]: logfile: ".length);
  const records = (await readFile(address, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          detail: { message: string; cause?: unknown };
        },
    );
  const failures = records.filter(
    (record) => record.event === "hook preflight failed",
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.detail.message, expectedMessage);
  if (originalErrors !== undefined)
    assert.deepEqual(failures[0]!.detail.cause, originalErrors);
}

await test("changed hash on hook readback logs a warning and readiness can complete", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(hook());
  const list = native.hooksHandler;
  let reads = 0;
  native.hooksHandler = (request) => {
    if (++reads === 2) native.hooks[0]!.currentHash = "sha256:changed-again";
    return list(request);
  };
  await assertReadyWithHookFailure(
    t,
    native,
    "Codex hook trust could not be verified",
  );
  assert.equal(reads, 2);
});

for (const [name, changes] of [
  ["still untrusted", { hooks: [hook()] }],
  ["still modified", { hooks: [{ ...hook(), trustStatus: "modified" }] }],
  [
    "additional untrusted disabled hook",
    {
      hooks: [
        { ...hook(), trustStatus: "trusted" },
        { ...hook("added"), enabled: false },
      ],
    },
  ],
  ["hook error", { errors: inventoryErrors }],
] as const) {
  await test(`factory tolerates invalid hook readback with ${name}`, async (t) => {
    const native = await nativeFixture(t);
    native.hooks.push(hook());
    const list = native.hooksHandler;
    let reads = 0;
    native.hooksHandler = (request) =>
      ++reads === 1
        ? list(request)
        : {
            data: [
              {
                cwd: process.cwd(),
                hooks: [],
                errors: [],
                warnings: [],
                ...changes,
              },
            ],
          };
    await assertReadyWithHookFailure(
      t,
      native,
      name === "hook error"
        ? "Codex hook inventory has errors or invalid data"
        : "Codex hook trust could not be verified",
      "errors" in changes ? changes.errors : undefined,
    );
    assert.equal(reads, 2);
  });
}

await test("initial hook inventory errors retain original details while readiness succeeds", async (t) => {
  const native = await nativeFixture(t);
  native.hooksHandler = () => ({
    data: [{ cwd: process.cwd(), hooks: [], errors: inventoryErrors }],
  });
  await assertReadyWithHookFailure(
    t,
    native,
    "Codex hook inventory has errors or invalid data",
    inventoryErrors,
  );
  assert.equal(
    native.requests.filter(({ method }) => method === "hooks/list").length,
    1,
  );
});
