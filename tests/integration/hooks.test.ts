import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import {
  boundCapabilities,
  flush,
  hook,
  nativeFixture,
} from "../fixtures/native.ts";

await test("factory trusts a newly added hook by its current hash before startup", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(
    { ...hook(), enabled: false },
    { ...hook("trusted"), trustStatus: "trusted" },
    { ...hook("managed"), trustStatus: "managed", isManaged: true },
  );
  const bound = boundCapabilities();
  const instance = await createEnhancement(
    bound.io,
    bound.requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration.hooks, {
    state: { "new hook": { trusted_hash: "sha256:new hook" } },
  });
  assert.deepEqual(bound.inputs, []);
  await instance.stop();
});

await test("factory refreshes changed hashes without enabling disabled hooks or changing unrelated state", async (t) => {
  const native = await nativeFixture(t);
  const key = 'space "quoted".dot\\hook';
  native.hooks.push({ ...hook(key), trustStatus: "modified", enabled: false });
  native.configuration.hooks = {
    state: {
      [key]: { trusted_hash: "sha256:old", enabled: false },
      unrelated: { trusted_hash: "sha256:keep", enabled: false },
    },
    retained: "hook setting",
  };
  native.configuration.model = "retained model";
  const stderr = t.mock.method(process.stderr, "write", () => true);
  for (let i = 0; i < 2; i++) {
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    await instance.stop();
  }
  assert.deepEqual(native.configuration.hooks, {
    state: {
      [key]: { trusted_hash: `sha256:${key}`, enabled: false },
      unrelated: { trusted_hash: "sha256:keep", enabled: false },
    },
    retained: "hook setting",
  });
  assert.equal(native.configuration.model, "retained model");
  assert.equal(native.hooks[0]?.enabled, false);
  assert.deepEqual(
    native.requests
      .filter(({ method }) => method === "config/value/write")
      .map(({ params }) => params),
    [
      {
        keyPath: "hooks.state",
        value: { [key]: { trusted_hash: `sha256:${key}` } },
        mergeStrategy: "upsert",
      },
    ],
  );
  assert.ok(
    stderr.mock.calls.every(({ arguments: [line] }) =>
      String(line).startsWith("[codex]: logfile:"),
    ),
  );
});

await test("factory queries already-trusted and managed hooks only once", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(
    { ...hook("trusted"), trustStatus: "trusted" },
    { ...hook("managed"), trustStatus: "managed", isManaged: true },
  );
  const before = structuredClone(native.configuration);
  const instance = await createEnhancement(
    boundCapabilities().io,
    boundCapabilities().requestRecovery,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration, before);
  assert.equal(
    native.requests.filter(({ method }) => method === "hooks/list").length,
    1,
  );
  assert.equal(
    native.requests.some(({ method }) => method === "config/value/write"),
    false,
  );
  await instance.stop();
});

await test(
  "factory lists task hooks after checkout trust and awaits readback before returning",
  { timeout: 5_000 },
  async (t) => {
    const native = await nativeFixture(t);
    native.configuration.projects = {};
    native.hooks.push(hook());
    const bound = boundCapabilities();
    const context = { cwd: join(native.primary, "linked task"), env: {} };
    const list = native.hooksHandler;
    let release!: () => void;
    let reads = 0;
    const reading = new Promise<void>((received) => {
      native.hooksHandler = (request) => {
        assert.deepEqual(request.params, { cwds: [context.cwd] });
        assert.deepEqual(native.configuration.projects, {
          [native.primary]: { trust_level: "trusted" },
        });
        assert.deepEqual(bound.inputs, []);
        if (++reads === 2)
          return new Promise((resolve) => {
            release = () => resolve(list(request));
            received();
          });
        return list(request);
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
    assert.equal(returned, false);
    assert.deepEqual(
      native.requests
        .filter(
          ({ method }) =>
            method.startsWith("config/") || method === "hooks/list",
        )
        .map(({ method }) => method),
      [
        "config/read",
        "config/value/write",
        "config/read",
        "hooks/list",
        "config/value/write",
        "hooks/list",
      ],
    );
    release();
    const instance = await creating;
    assert.deepEqual(bound.keys, []);
    assert.equal(bound.recoveries, 0);
    await instance.stop();
  },
);

for (const phase of ["list", "write", "readback"] as const) {
  await test(`factory accepts hook inventory and configuration warnings during ${phase}`, async (t) => {
    const native = await nativeFixture(t);
    native.hooks.push(hook());
    const list = native.hooksHandler;
    let reads = 0;
    native.hooksHandler = (request) => {
      const response = list(request) as { data: { warnings: unknown[] }[] };
      if (++reads === (phase === "list" ? 1 : 2)) {
        native.notify("configWarning", { summary: "private hook warning" });
        response.data[0]!.warnings = ["private inventory warning"];
      }
      return response;
    };
    const write = native.configHandler;
    native.configHandler = (request) => {
      if (phase === "write" && request.params.keyPath === "hooks.state")
        native.notify("configWarning", { summary: "private write warning" });
      return write(request);
    };
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    assert.deepEqual(native.configuration.hooks, {
      state: { "new hook": { trusted_hash: "sha256:new hook" } },
    });
    await instance.stop();
  });
}

for (const failure of [
  "list-error",
  "write-error",
  "readback-error",
  "ineffective-overridden-status",
  "ineffective-override-metadata",
  "malformed-write",
] as const) {
  await test(`factory tolerates hook ${failure} and preserves other observers and terminal state`, async (t) => {
    const native = await nativeFixture(t);
    const other = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    native.hooks.push(hook());
    const list = native.hooksHandler;
    let reads = 0;
    native.hooksHandler = (request) => {
      reads++;
      if (
        failure === "list-error" ||
        (failure === "readback-error" && reads >= 2)
      )
        throw new Error("private hook read error");
      return list(request);
    };
    const write = native.configHandler;
    native.configHandler = (request) => {
      if (request.params.keyPath === "hooks.state") {
        if (failure === "write-error")
          throw new Error("private hook write error");
        if (failure === "ineffective-overridden-status")
          return { status: "okOverridden" };
        if (failure === "ineffective-override-metadata")
          return {
            status: "ok",
            overriddenMetadata: { message: "private policy" },
          };
        if (failure === "malformed-write") return {};
      }
      return write(request);
    };
    const bound = boundCapabilities();
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    await flush();
    assert.equal(native.sockets[1]?.readyState, 1);
    assert.equal(native.sockets[0]?.readyState, 1);
    assert.deepEqual(bound.inputs, []);
    assert.deepEqual(bound.keys, []);
    assert.equal(bound.recoveries, 0);
    assert.ok(
      stderr.mock.calls.some(({ arguments: [line] }) =>
        String(line).includes("hook preflight failed"),
      ),
    );
    assert.ok(
      stderr.mock.calls.every(
        ({ arguments: [line] }) => !/private|secret/.test(String(line)),
      ),
    );
    await instance.stop();
    assert.ok(
      native.launches.every(
        ({ args }) => !args.includes("stop") && !args.includes("restart"),
      ),
    );
    await other.stop();
  });
}

for (const [name, changes] of [
  ["removed hook", { hooks: [] }],
  [
    "additional trusted disabled hook",
    {
      hooks: [
        { ...hook(), trustStatus: "trusted" },
        { ...hook("added"), enabled: false, trustStatus: "trusted" },
      ],
    },
  ],
  [
    "different trusted key",
    { hooks: [{ ...hook("different"), trustStatus: "trusted" }] },
  ],
  [
    "changed trusted definition",
    {
      hooks: [
        { ...hook(), currentHash: "sha256:changed", trustStatus: "trusted" },
      ],
    },
  ],
  [
    "changed enabled setting",
    { hooks: [{ ...hook(), enabled: false, trustStatus: "trusted" }] },
  ],
  [
    "changed managed setting",
    { hooks: [{ ...hook(), isManaged: true, trustStatus: "managed" }] },
  ],
] as const) {
  await test(`factory accepts effective hook trust with ${name}`, async (t) => {
    const native = await nativeFixture(t);
    native.hooks.push(hook());
    const list = native.hooksHandler;
    let reads = 0;
    native.hooksHandler = (request) =>
      ++reads === 1
        ? list(request)
        : {
            data: [
              { cwd: process.cwd(), errors: [], warnings: [], ...changes },
            ],
          };
    const bound = boundCapabilities();
    const instance = await createEnhancement(
      bound.io,
      bound.requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    assert.deepEqual(bound.inputs, []);
    assert.equal(reads, 2);
    await instance.stop();
  });
}

for (const [name, response] of [
  ["missing inventory", {}],
  ["empty inventory", { data: [] }],
  [
    "missing hooks",
    { data: [{ cwd: process.cwd(), errors: [], warnings: [] }] },
  ],
  [
    "another cwd",
    {
      data: [
        {
          cwd: join(process.cwd(), "other"),
          hooks: [],
          errors: [],
          warnings: [],
        },
      ],
    },
  ],
  ["multiple inventories", { data: [{}, {}] }],
  ...(
    [
      [
        "hook errors",
        { errors: [{ path: "private path", message: "private error" }] },
      ],
      ["invalid hooks", { hooks: null }],
      ["empty hash", { hooks: [{ ...hook(), currentHash: "" }] }],
      ["empty key", { hooks: [{ ...hook(), key: "" }] }],
      [
        "unknown trust status",
        { hooks: [{ ...hook(), trustStatus: "unknown" }] },
      ],
      [
        "inconsistent managed status",
        { hooks: [{ ...hook(), isManaged: true }] },
      ],
      ["duplicate key", { hooks: [hook(), hook()] }],
    ] as const
  ).map(
    ([name, changes]) =>
      [
        name,
        {
          data: [
            {
              cwd: process.cwd(),
              hooks: [],
              errors: [],
              warnings: [],
              ...changes,
            },
          ],
        },
      ] as const,
  ),
] as const) {
  await test(`factory validates ${name} without changing hook trust`, async (t) => {
    const native = await nativeFixture(t);
    native.hooksHandler = () => response;
    const instance = await createEnhancement(
      boundCapabilities().io,
      boundCapabilities().requestRecovery,
      { cwd: process.cwd(), env: {} },
      {},
    );
    await instance.stop();
    assert.equal(
      native.requests.filter(({ method }) => method === "hooks/list").length,
      1,
    );
    assert.equal(
      native.requests.some(({ method }) => method === "config/value/write"),
      false,
    );
  });
}
