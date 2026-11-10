import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  hook,
  nativeFixture,
} from "../fixtures/native.ts";

function projectLayer(root: string, disabledReason: string | null = null) {
  return {
    name: { type: "project", dotCodexFolder: join(root, ".codex") },
    config: { model: "project-model" },
    version: "project-version",
    disabledReason,
  };
}

function trustWarning(root: string, reason: string) {
  return {
    summary:
      "Project-local config, hooks, and exec policies are disabled in the following folders " +
      "until the project is trusted, but skills still load.\n" +
      `    1. ${join(root, ".codex")}\n       ${reason}\n`,
    details: null,
    path: null,
    range: null,
  };
}

await test("factory establishes trust when native configuration returns null projects", async (t) => {
  const native = await nativeFixture(t);
  native.configuration.projects = null;
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    {
      enhancementPause: boundCapabilities().enhancementPause,
      cwd: process.cwd(),
      env: {},
    },
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

await test("factory establishes effective trust despite an initial trust warning", async (t) => {
  const native = await nativeFixture(t);
  native.configuration.projects = null;
  native.handler = (request) => {
    if (request.method === "initialize")
      native.notify(
        "configWarning",
        trustWarning(
          native.primary,
          "Project configuration is disabled until trusted.",
        ),
      );
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
  const bound = boundCapabilities();
  for (let attempt = 0; attempt < 2; attempt++) {
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      {
        enhancementPause: bound.enhancementPause,
        cwd: native.primary,
        env: {},
      },
      {},
    );
    await instance.stop();
  }
  assert.equal(written, true);
  assert.deepEqual(native.configuration.projects, {
    [native.primary]: { trust_level: "trusted" },
  });
  assert.equal(
    native.requests.filter(({ method }) => method === "config/read").length,
    3,
  );
  assert.deepEqual(bound.inputs, []);
});

for (const withTrustWarning of [false, true]) {
  await test(`factory accepts an unrelated initialization warning across a trust write${withTrustWarning ? " alongside a resolved trust warning" : ""}`, async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = null;
    native.configuration.unknown_setting = "preserved";
    let written = false;
    const reason = "Project configuration is disabled until trusted.";
    native.handler = (request) => {
      if (request.method === "initialize") {
        if (withTrustWarning && !written)
          native.notify("configWarning", trustWarning(native.primary, reason));
        native.notify("configWarning", {
          summary: "Unknown config key in config.toml: unknown_setting",
          details: null,
          path: null,
          range: null,
        });
      }
      return {};
    };
    const handleConfig = native.configHandler;
    native.configHandler = (request) => {
      if (request.method === "config/read")
        return {
          config: native.configuration,
          origins: {},
          layers: withTrustWarning
            ? [projectLayer(native.primary, written ? null : reason)]
            : [],
        };
      written = true;
      return handleConfig(request);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const instance = await createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: native.primary,
          env: {},
        },
        {},
      );
      await instance.stop();
      assert.equal(native.configuration.unknown_setting, "preserved");
    }
    assert.equal(written, true);
    assert.equal(
      native.requests.filter(({ method }) => method === "config/value/write")
        .length,
      1,
    );
  });
}

for (const phase of ["config/read", "config/value/write"] as const) {
  await test(`factory accepts configuration warnings during ${phase} without changing unrelated settings`, async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = null;
    native.configuration.model = "preserved";
    const handleConfig = native.configHandler;
    native.configHandler = (request) => {
      if (request.method === phase)
        native.notify("configWarning", {
          summary: "Unrecognized configuration warning",
          details: "private detail",
          path: join(native.primary, "config.toml"),
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        });
      return handleConfig(request);
    };
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      {
        enhancementPause: boundCapabilities().enhancementPause,
        cwd: native.primary,
        env: {},
      },
      {},
    );
    assert.deepEqual(native.configuration.projects, {
      [native.primary]: { trust_level: "trusted" },
    });
    assert.equal(native.configuration.model, "preserved");
    await instance.stop();
  });
}

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
  const bound = boundCapabilities();
  await assert.rejects(
    createEnhancement(
      bound.io,
      bound.requestRecovery,
      { enhancementPause: bound.enhancementPause, cwd: worktree, env: {} },
      {},
    ),
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
      createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: native.primary,
          env: {},
        },
        {},
      ),
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
      createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd,
          env: {},
        },
        {},
      ),
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
      createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        {
          enhancementPause: boundCapabilities().enhancementPause,
          cwd: native.primary,
          env: {},
        },
        {},
      ),
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

for (const status of ["ok", "okOverridden"]) {
  await test(`factory accepts hook trust write ${status} with override metadata when readback proves trust`, async (t) => {
    const native = await nativeFixture(t);
    native.hooks.push(hook());
    const write = native.configHandler;
    native.configHandler = (request) => {
      const result = write(request);
      return request.params.keyPath === "hooks.state"
        ? { status, overriddenMetadata: { message: "private policy" } }
        : result;
    };
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      {
        enhancementPause: boundCapabilities().enhancementPause,
        cwd: process.cwd(),
        env: {},
      },
      {},
    );
    assert.deepEqual(native.configuration.hooks, {
      state: { "new hook": { trusted_hash: "sha256:new hook" } },
    });
    await instance.stop();
  });
}
