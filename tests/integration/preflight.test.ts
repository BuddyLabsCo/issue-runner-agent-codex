import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  hook,
  nativeFixture,
} from "../fixtures/native.ts";

await test(
  "factory trusts the primary checkout and awaits effective readback before terminal startup",
  { timeout: 5_000 },
  async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = { unrelated: { trust_level: "untrusted" } };
    native.configuration.model = "preserved";
    const bound = boundCapabilities();
    const context = {
      cwd: join(native.primary, "linked task"),
      env: { CODEX_HOME: "injected-home" },
    };
    const handleConfig = native.configHandler;
    let release!: () => void;
    let reads = 0;
    const reading = new Promise<void>((received) => {
      native.configHandler = (request) => {
        assert.deepEqual(bound.inputs, []);
        if (request.method === "config/read") {
          assert.deepEqual(request.params, {
            cwd: context.cwd,
            includeLayers: true,
          });
          if (++reads === 2)
            return new Promise((resolve) => {
              release = () => resolve(handleConfig(request));
              received();
            });
        }
        return handleConfig(request);
      };
    });
    let returned = false;
    const creating = createEnhancement(
      bound.io,
      bound.requestRecovery,
      context,
      {},
    ).then((instance) => {
      returned = true;
      return instance;
    });
    await reading;
    assert.ok(
      native.requests.some(({ method }) => method === "config/value/write"),
    );
    assert.equal(returned, false);
    release();
    const instance = await creating;
    assert.deepEqual(native.configuration, {
      projects: {
        unrelated: { trust_level: "untrusted" },
        [native.primary]: { trust_level: "trusted" },
      },
      model: "preserved",
    });
    assert.deepEqual(
      native.requests.find(({ method }) => method === "config/value/write")
        ?.params,
      {
        keyPath: "projects",
        value: { [native.primary]: { trust_level: "trusted" } },
        mergeStrategy: "upsert",
      },
    );
    assert.deepEqual(native.gitLaunches, [
      {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: context.cwd,
      },
      { args: ["rev-parse", "--show-toplevel"], cwd: native.primary },
      { args: ["rev-parse", "--absolute-git-dir"], cwd: native.primary },
      { args: ["rev-parse", "--show-toplevel"], cwd: context.cwd },
    ]);
    assert.equal(native.launches.length, 2);
    assert.deepEqual(bound.keys, []);
    assert.equal(bound.recoveries, 0);
    await instance.stop();
  },
);

for (const status of ["ok", "okOverridden"]) {
  await test(`factory accepts project trust write ${status} with override metadata when readback proves trust`, async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = {};
    const handleConfig = native.configHandler;
    native.configHandler = (request) => {
      const result = handleConfig(request);
      if (request.method === "config/value/write")
        return {
          status,
          overriddenMetadata: { message: "private policy detail" },
        };
      return result;
    };
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    assert.deepEqual(native.configuration.projects, {
      [native.primary]: { trust_level: "trusted" },
    });
    assert.equal(
      native.requests.filter(({ method }) => method === "config/read").length,
      2,
    );
    await instance.stop();
  });
}

await test("factory accepts an already-trusted checkout with the reported unrelated initialization warning", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push({
    ...hook("startup"),
    enabled: false,
    trustStatus: "trusted",
  });
  native.handler = (request) => {
    if (request.method === "initialize")
      native.notify("configWarning", {
        summary: "Ignored 7 configuration settings",
        details: "disable_response_storage, mcp_servers.fixture.type",
      });
    return {};
  };
  const before = structuredClone(native.configuration);
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration, before);
  assert.equal(
    native.requests.filter(({ method }) => method === "hooks/list").length,
    1,
  );
  assert.deepEqual(bound.inputs, []);
  await instance.stop();
});

await test("factory rejects relative primary metadata instead of resolving it against the Runner checkout", async (t) => {
  const native = await nativeFixture(t);
  native.gitHandler = (args) =>
    args.includes("--show-toplevel")
      ? "primary repo"
      : join(native.primary, ".git");
  await assert.rejects(
    createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    ),
    /ordinary primary checkout/,
  );
  assert.equal(
    native.requests.some(({ method }) => method.startsWith("config/")),
    false,
  );
});

await test("structured trust preserves unusual path characters, project fields and unrelated state across repeated creation", async (t) => {
  const native = await nativeFixture(t);
  const primary = resolve(process.cwd(), 'space "quoted".dot', "back\\slash");
  native.gitHandler = (args) =>
    args.includes("--show-toplevel") ? primary : join(primary, ".git");
  native.configuration.projects = {
    [primary]: { trust_level: "untrusted", retained: "project setting" },
    unrelated: { trust_level: "trusted" },
  };
  native.configuration.model = "retained model";
  const expected = {
    projects: {
      [primary]: { trust_level: "trusted", retained: "project setting" },
      unrelated: { trust_level: "trusted" },
    },
    model: "retained model",
  };
  const stderr = t.mock.method(process.stderr, "write", () => true);
  // Keep the synthetic project key out of the logger's real filesystem path.
  for (let i = 0; i < 2; i++) {
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: join(native.primary, "task"), env: {} },
      {},
    );
    assert.deepEqual(native.configuration, expected);
    await instance.stop();
  }
  assert.equal(stderr.mock.callCount(), 0);
  const writes = native.requests.filter(
    ({ method }) => method === "config/value/write",
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.params, {
    keyPath: "projects",
    value: { [primary]: { trust_level: "trusted" } },
    mergeStrategy: "upsert",
  });
});

await test("already-trusted creation reads effective configuration without changing it", async (t) => {
  const native = await nativeFixture(t);
  const before = structuredClone(native.configuration);
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration, before);
  assert.deepEqual(
    native.requests
      .filter(({ method }) => method.startsWith("config/"))
      .map(({ method }) => method),
    ["config/read"],
  );
  await instance.stop();
});

for (const failure of [
  "initial-read",
  "write",
  "readback",
  "ineffective",
  "malformed-readback",
  "malformed-write",
  "invalid-status",
  "overridden-ineffective",
] as const) {
  await test(`factory rejects ${failure} and releases its partial resources while preserving another observer`, async (t) => {
    const native = await nativeFixture(t);
    const other = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    native.configuration.projects = {};
    const handleConfig = native.configHandler;
    let reads = 0;
    native.configHandler = (request) => {
      if (request.method === "config/read") {
        reads++;
        if (
          failure === "initial-read" ||
          (failure === "readback" && reads >= 2)
        )
          throw new Error("private read error");
        if (failure === "malformed-readback" && reads === 2)
          return { config: null };
      } else {
        if (failure === "write") throw new Error("private write error");
        if (failure === "malformed-write") return {};
        if (failure === "invalid-status") return { status: "invalid" };
        if (failure === "overridden-ineffective")
          return {
            status: "okOverridden",
            overriddenMetadata: { message: "private policy detail" },
          };
        if (failure === "ineffective")
          return {
            status: "ok",
            version: "written",
            filePath: join(native.primary, "config.toml"),
          };
      }
      return handleConfig(request);
    };
    const bound = boundCapabilities();
    await assert.rejects(
      createEnhancement(
        bound.io,
        bound.requestRecovery,
        { cwd: process.cwd(), env: {} },
        {},
      ),
      (error: Error) => {
        const operation = [
          "write",
          "malformed-write",
          "invalid-status",
        ].includes(failure)
          ? /config\/value\/write.*projects/
          : failure.includes("ineffective")
            ? /primary checkout trust was not established/
            : /config\/read/;
        assert.match(error.message, operation);
        assert.doesNotMatch(error.message, /private|secret/);
        return true;
      },
    );
    await flush();
    assert.equal(native.sockets[1]?.readyState, 3);
    assert.equal(native.sockets[0]?.readyState, 1);
    assert.deepEqual(bound.inputs, []);
    assert.deepEqual(bound.keys, []);
    assert.equal(bound.recoveries, 0);
    assert.ok(
      native.launches.every(
        ({ args }) => !args.includes("stop") && !args.includes("restart"),
      ),
    );
    await other.stop();
  });
}

for (const layout of [
  "bare",
  "separate-git-dir",
  "linked-primary",
  "unrelated-root",
  "relative-common",
  "git-failure",
] as const) {
  await test(`factory rejects ${layout} metadata before writing project trust`, async (t) => {
    const native = await nativeFixture(t);
    const handleGit = native.gitHandler;
    native.gitHandler = (args) => {
      if (
        layout === "git-failure" ||
        (layout === "bare" && args.includes("--show-toplevel"))
      )
        throw new Error("private localized Git diagnostic");
      if (args.includes("--git-common-dir")) {
        if (layout === "separate-git-dir")
          return join(dirname(native.primary), "git-storage");
        if (layout === "relative-common") return "relative/.git";
      }
      if (layout === "linked-primary" && args.includes("--absolute-git-dir"))
        return join(native.primary, ".git", "worktrees", "other");
      if (layout === "unrelated-root" && args.includes("--show-toplevel"))
        return dirname(native.primary);
      return handleGit(args, native.primary);
    };
    await assert.rejects(
      createEnhancement(
        boundCapabilities().io,
        boundCapabilities().requestRecovery,
        { cwd: process.cwd(), env: {} },
        {},
      ),
      /Codex/,
    );
    await flush();
    assert.equal(native.sockets[0]?.readyState, 3);
    assert.equal(
      native.requests.some(({ method }) => method.startsWith("config/")),
      false,
    );
  });
}
