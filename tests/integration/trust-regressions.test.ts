import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, flush, nativeFixture } from "../fixtures/native.ts";

function projectLayer(root: string, disabledReason: string | null = null) {
  return {
    name: { type: "project", dotCodexFolder: join(root, ".codex") },
    config: { model: "project-model" },
    version: "project-version",
    disabledReason,
  };
}

await test("factory establishes trust when native configuration returns null projects", async (t) => {
  const native = await nativeFixture(t);
  native.configuration.projects = null;
  const instance = await createEnhancement(
    boundHost().host,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration.projects, {
    [native.primary]: { trust_level: "trusted" },
  });
  assert.deepEqual(
    native.requests
      .filter(({ method }) => method.startsWith("config/"))
      .map(({ method }) => method),
    ["config/read", "config/value/write", "config/read"],
  );
  await instance.stop();
});

await test("factory recovers an initial trust warning when writing trust enables the project layer", async (t) => {
  const native = await nativeFixture(t);
  native.configuration.projects = null;
  native.handler = (request) => {
    if (request.method === "initialize")
      native.notify("configWarning", {
        summary:
          "Project configuration is disabled until this checkout is trusted.",
      });
    return {};
  };
  const handleConfig = native.configHandler;
  let written = false;
  native.configHandler = (request) => {
    if (request.method === "config/read")
      return {
        config: native.configuration,
        origins: {},
        layers: [
          projectLayer(
            native.primary,
            written
              ? undefined
              : "Project configuration is disabled until trusted.",
          ),
        ],
      };
    written = true;
    return handleConfig(request);
  };
  const bound = boundHost();
  const instance = await createEnhancement(
    bound.host,
    { cwd: native.primary, env: {} },
    {},
  );
  assert.equal(written, true);
  assert.deepEqual(native.configuration.projects, {
    [native.primary]: { trust_level: "trusted" },
  });
  assert.equal(
    native.requests.filter(({ method }) => method === "config/read").length,
    2,
  );
  assert.deepEqual(bound.inputs, []);
  await instance.stop();
});

await test("factory rejects a linked Worktree's explicit untrusted setting and disabled layer without warnings", async (t) => {
  const native = await nativeFixture(t);
  const worktree = resolve(process.cwd(), "untrusted task");
  native.configuration.projects = {
    [native.primary]: { trust_level: "trusted" },
    [worktree]: { trust_level: "untrusted" },
  };
  const before = structuredClone(native.configuration);
  native.configHandler = () => ({
    config: native.configuration,
    origins: {},
    layers: [
      projectLayer(
        worktree,
        "Explicit untrusted setting disables project configuration.",
      ),
    ],
  });
  const bound = boundHost();
  await assert.rejects(
    createEnhancement(bound.host, { cwd: worktree, env: {} }, {}),
    /trust/,
  );
  await flush();
  assert.deepEqual(native.configuration, before);
  assert.equal(
    native.requests.some(({ method }) => method === "config/value/write"),
    false,
  );
  assert.equal(native.sockets[0]?.readyState, 3);
  assert.deepEqual(bound.inputs, []);
});

for (const projects of [[], "invalid", 42]) {
  await test(`factory rejects invalid non-null projects: ${JSON.stringify(projects)}`, async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = projects;
    await assert.rejects(
      createEnhancement(boundHost().host, { cwd: native.primary, env: {} }, {}),
      /Invalid Codex protocol object/,
    );
    assert.equal(
      native.requests.some(({ method }) => method === "config/value/write"),
      false,
    );
  });
}

for (const override of ["worktree", "cwd"] as const) {
  await test(`factory preserves an untrusted ${override} override with no project layers or warnings`, async (t) => {
    const native = await nativeFixture(t);
    const worktree = resolve(process.cwd(), "task checkout");
    const cwd = join(worktree, "subdirectory");
    const handleGit = native.gitHandler;
    native.gitHandler = (args, directory) =>
      args.includes("--show-toplevel") && directory === cwd
        ? worktree
        : handleGit(args, directory);
    native.configuration.projects = {
      [native.primary]: { trust_level: "trusted" },
      [override === "worktree" ? worktree : cwd]: { trust_level: "untrusted" },
    };
    const before = structuredClone(native.configuration);
    await assert.rejects(
      createEnhancement(boundHost().host, { cwd, env: {} }, {}),
      /explicitly untrusted/,
    );
    await flush();
    assert.deepEqual(native.configuration, before);
    assert.equal(
      native.requests.some(({ method }) => method === "config/value/write"),
      false,
    );
    assert.equal(native.sockets[0]?.readyState, 3);
  });
}

for (const initiallyTrusted of [false, true]) {
  await test(`factory rejects a disabled project layer even when primary trust is ${initiallyTrusted ? "already present" : "successfully written"}`, async (t) => {
    const native = await nativeFixture(t);
    if (!initiallyTrusted) native.configuration.projects = null;
    native.handler = (request) => {
      if (request.method === "initialize")
        native.notify("configWarning", { summary: "Initial trust warning" });
      return {};
    };
    const handleConfig = native.configHandler;
    native.configHandler = (request) =>
      request.method === "config/read"
        ? {
            config: native.configuration,
            origins: {},
            layers: [
              {
                name: {
                  type: "project",
                  dotCodexFolder: join(native.primary, ".codex"),
                },
                config: {},
                version: "project-version",
                disabledReason: "Unresolved project constraint",
              },
            ],
          }
        : handleConfig(request);
    await assert.rejects(
      createEnhancement(boundHost().host, { cwd: native.primary, env: {} }, {}),
      /layer remains disabled/,
    );
    await flush();
    assert.equal(
      native.requests.filter(({ method }) => method === "config/value/write")
        .length,
      initiallyTrusted ? 0 : 1,
    );
    assert.equal(native.sockets[0]?.readyState, 3);
  });
}
