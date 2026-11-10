import { boundCapabilities } from "../fixtures/native.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TerminalIO, EnhancementModule } from "issue-runner-core/terminal";
import * as enhancement from "../../src/index.ts";

const module: EnhancementModule = enhancement;
const io: TerminalIO = {
  read: () => Promise.resolve(""),
  submitText: () => Promise.resolve(),
  sendKeys: () => Promise.resolve(),
};

await test("exports the approved Core contract and rejects invalid options before native startup", async () => {
  assert.equal(module.contractVersion, 3);
  for (const config of [
    null,
    [],
    1,
    { logLevel: "debug" },
    { logLevel: null },
    { logLevel: 1 },
    { readyTimeout: 0 },
    { readyTimeout: Infinity },
    { readyTimeout: "20" },
    { retryLimit: -1 },
    { retryLimit: 1.5 },
    { retryLimit: NaN },
    { retryDelay: [] },
    { retryDelay: [-1] },
    { retryDelay: [Infinity] },
    { retryDelay: "10" },
    { handoffRecoveryDelaySeconds: -1 },
    { handoffRecoveryDelaySeconds: NaN },
  ]) {
    await assert.rejects(
      module.createEnhancement(
        io,
        () => Promise.resolve(),
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: process.cwd(),
          env: {},
        },
        config,
      ),
      /enhancements/,
    );
  }
});

await test("explicit null option values and sparse delays are rejected instead of silently defaulting", async () => {
  for (const config of [
    { readyTimeout: null },
    { retryLimit: null },
    { retryDelay: null },
    { handoffRecoveryDelaySeconds: null },
    { retryDelay: new Array<number>(1) },
  ])
    await assert.rejects(
      module.createEnhancement(
        io,
        () => Promise.resolve(),
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: process.cwd(),
          env: {},
        },
        config,
      ),
      /enhancements/,
    );
});
