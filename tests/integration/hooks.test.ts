import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createEnhancement } from "../../src/index.ts";
import { boundHost, flush, hook, nativeFixture } from "../fixtures/native.ts";

await test("factory trusts a newly added hook by its current hash before startup", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(
    hook(),
    { ...hook("trusted"), trustStatus: "trusted" },
    { ...hook("managed"), trustStatus: "managed", isManaged: true },
  );
  const bound = boundHost();
  const instance = await createEnhancement(
    bound.host,
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
      boundHost().host,
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
  assert.equal(stderr.mock.callCount(), 0);
});

await test("factory verifies already-trusted and managed hooks without writing configuration", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(
    { ...hook("trusted"), trustStatus: "trusted" },
    { ...hook("managed"), trustStatus: "managed", isManaged: true },
  );
  const before = structuredClone(native.configuration);
  const instance = await createEnhancement(
    boundHost().host,
    { cwd: process.cwd(), env: {} },
    {},
  );
  assert.deepEqual(native.configuration, before);
  assert.equal(
    native.requests.filter(({ method }) => method === "hooks/list").length,
    2,
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
    const bound = boundHost();
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
    const creating = createEnhancement(bound.host, context, {}).then(
      (instance) => {
        returned = true;
        return instance;
      },
    );
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

await test("factory rejects a changed hash on hook readback and cleans up its proxy", async (t) => {
  const native = await nativeFixture(t);
  native.hooks.push(hook());
  const list = native.hooksHandler;
  let reads = 0;
  native.hooksHandler = (request) => {
    if (++reads === 2) native.hooks[0]!.currentHash = "sha256:changed-again";
    return list(request);
  };
  const bound = boundHost();
  await assert.rejects(
    createEnhancement(bound.host, { cwd: process.cwd(), env: {} }, {}),
    /Codex hook trust.*verif/,
  );
  await flush();
  assert.equal(native.sockets[0]?.readyState, 3);
  assert.deepEqual(bound.inputs, []);
});

for (const failure of [
  "list-error",
  "write-error",
  "readback-error",
  "policy-rejected",
  "policy-overridden",
  "malformed-write",
  "list-warning",
  "write-warning",
  "readback-warning",
] as const) {
  await test(`factory rejects hook ${failure} and preserves other observers and terminal state`, async (t) => {
    const native = await nativeFixture(t);
    const other = await createEnhancement(
      boundHost().host,
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
        (failure === "readback-error" && reads === 2)
      )
        throw new Error("private hook read error");
      if (
        (failure === "list-warning" && reads === 1) ||
        (failure === "readback-warning" && reads === 2)
      )
        native.notify("configWarning", { summary: "private hook warning" });
      return list(request);
    };
    const write = native.configHandler;
    native.configHandler = (request) => {
      if (request.params.keyPath === "hooks.state") {
        if (failure === "write-error")
          throw new Error("private hook write error");
        if (failure === "write-warning")
          native.notify("configWarning", { summary: "private write warning" });
        if (failure === "policy-rejected") return { status: "okOverridden" };
        if (failure === "policy-overridden")
          return {
            status: "ok",
            overriddenMetadata: { message: "private policy" },
          };
        if (failure === "malformed-write") return {};
      }
      return write(request);
    };
    const bound = boundHost();
    const stderr = t.mock.method(process.stderr, "write", () => true);
    await assert.rejects(
      createEnhancement(bound.host, { cwd: process.cwd(), env: {} }, {}),
      /Codex/,
    );
    await flush();
    assert.equal(native.sockets[1]?.readyState, 3);
    assert.equal(native.sockets[0]?.readyState, 1);
    assert.deepEqual(bound.inputs, []);
    assert.deepEqual(bound.keys, []);
    assert.equal(bound.recoveries, 0);
    assert.equal(stderr.mock.callCount(), 0);
    assert.ok(
      native.launches.every(
        ({ args }) => !args.includes("stop") && !args.includes("restart"),
      ),
    );
    await other.stop();
  });
}

for (const [name, changes] of [
  ["missing hook", { hooks: [] }],
  [
    "unexpected hook",
    {
      hooks: [
        { ...hook(), trustStatus: "trusted" },
        { ...hook("added"), trustStatus: "trusted" },
      ],
    },
  ],
  [
    "different key",
    { hooks: [{ ...hook("different"), trustStatus: "trusted" }] },
  ],
  [
    "stale hash reported trusted",
    {
      hooks: [
        { ...hook(), currentHash: "sha256:stale", trustStatus: "trusted" },
      ],
    },
  ],
  ["still untrusted", { hooks: [hook()] }],
  ["still modified", { hooks: [{ ...hook(), trustStatus: "modified" }] }],
  [
    "changed enabled setting",
    { hooks: [{ ...hook(), enabled: false, trustStatus: "trusted" }] },
  ],
  [
    "changed managed setting",
    { hooks: [{ ...hook(), isManaged: true, trustStatus: "managed" }] },
  ],
  ["hook warning", { warnings: ["private inventory warning"] }],
  [
    "hook error",
    { errors: [{ path: "private path", message: "private inventory error" }] },
  ],
] as const) {
  await test(`factory rejects hook readback with ${name}`, async (t) => {
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
    await assert.rejects(
      createEnhancement(boundHost().host, { cwd: process.cwd(), env: {} }, {}),
      /Codex/,
    );
    await flush();
    assert.equal(native.sockets[0]?.readyState, 3);
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
    "missing warning evidence",
    { data: [{ cwd: process.cwd(), hooks: [], errors: [] }] },
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
      ["hook warnings", { warnings: ["private warning"] }],
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
  await test(`factory rejects ${name} before changing hook trust`, async (t) => {
    const native = await nativeFixture(t);
    native.hooksHandler = () => response;
    await assert.rejects(
      createEnhancement(boundHost().host, { cwd: process.cwd(), env: {} }, {}),
      /Codex/,
    );
    assert.equal(
      native.requests.some(({ method }) => method === "config/value/write"),
      false,
    );
  });
}
