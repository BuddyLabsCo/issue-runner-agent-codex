import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { createLog } from "../../src/codex/log.ts";

await test("shared rotation counts UTF-8 bytes, preserves records and never overwrites files", (t) => {
  const root = fs.mkdtempSync(join(process.cwd(), "rotation "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktrees", "run", "first");
  const directory = join(root, "logs");
  fs.mkdirSync(directory);
  const timestamp = Date.UTC(2026, 10, 10);
  t.mock.timers.enable({ apis: ["Date"], now: timestamp });
  const filename = (offset: number) =>
    `agent-codex-log-${new Date(timestamp + offset).toISOString().replaceAll(":", "-")}.jsonl`;
  for (const offset of [0, 2])
    fs.writeFileSync(join(directory, filename(offset)), "old\n");
  const first = createLog(cwd);
  const secondCwd = join(root, "worktrees", "run", "second");
  const second = createLog(secondCwd);
  first.context = () => ({
    sessionref: "first-session",
    assignmentId: "first-assignment",
    turnId: "first-turn",
  });
  second.context = () => ({
    sessionref: "second-session",
    assignmentId: "second-assignment",
    turnId: "second-turn",
  });
  first.error("boundary", "");
  const path = join(directory, filename(1));
  const overhead = fs.statSync(path).size;
  const remaining = 2_097_152 - overhead * 2;
  first.error(
    "boundary",
    "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2),
  );
  assert.equal(fs.statSync(path).size, 2_097_152);
  second.error("after boundary");
  assert.ok(fs.existsSync(join(directory, filename(3))));
  assert.equal(fs.statSync(path).size, 2_097_152);
  first.error("oversized", "界".repeat(700_000));
  assert.ok(fs.statSync(join(directory, filename(4))).size > 2_097_152);
  second.error("after oversized");
  const last = join(directory, filename(5));
  assert.ok(fs.statSync(last).size < 2_097_152);
  for (const offset of [0, 2])
    assert.equal(
      fs.readFileSync(join(directory, filename(offset)), "utf8"),
      "old\n",
    );
  const records = [1, 3, 4, 5].flatMap((offset) =>
    fs
      .readFileSync(join(directory, filename(offset)), "utf8")
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            runId: string;
            instanceId: string;
            cwd: string;
            sessionref: string;
            assignmentId: string;
            turnId: string;
          },
      ),
  );
  assert.deepEqual(
    records.map((record) => record.event),
    ["boundary", "boundary", "after boundary", "oversized", "after oversized"],
  );
  assert.equal(new Set(records.map((record) => record.runId)).size, 1);
  assert.equal(records[0]!.instanceId, records[3]!.instanceId);
  assert.equal(records[2]!.instanceId, records[4]!.instanceId);
  assert.notEqual(records[0]!.instanceId, records[2]!.instanceId);
  assert.equal(records[2]!.cwd, secondCwd);
  for (const record of records) {
    const prefix = record.cwd === cwd ? "first" : "second";
    assert.equal(record.sessionref, `${prefix}-session`);
    assert.equal(record.assignmentId, `${prefix}-assignment`);
    assert.equal(record.turnId, `${prefix}-turn`);
  }

  const moduleUrl = new URL("../../src/codex/log.ts", import.meta.url).href;
  const script = `import {createLog} from ${JSON.stringify(moduleUrl)}; Date.now = () => ${timestamp}; createLog(process.argv[1]).error("new invocation");`;
  for (let invocation = 0; invocation < 2; invocation++) {
    execFileSync(process.execPath, ["--input-type=module", "-e", script, cwd]);
  }
  const newRecords = [6, 7].map(
    (offset) =>
      JSON.parse(
        fs.readFileSync(join(directory, filename(offset)), "utf8"),
      ) as { runId: string },
  );
  assert.equal(
    new Set([records[0]!.runId, ...newRecords.map((record) => record.runId)])
      .size,
    3,
  );
  assert.equal(fs.readFileSync(last, "utf8").trimEnd().split("\n").length, 1);
});
