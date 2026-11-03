import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, connect } from "node:net";
import { PassThrough } from "node:stream";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { EnhancementHost } from "issue-runner-core/terminal";
import { WebSocketServer, WebSocket } from "ws";

export interface Request {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

export async function flush() {
  for (let i = 0; i < 8; i++) await setImmediate();
}

export function boundHost() {
  const inputs: string[] = [];
  const keys: (readonly string[])[] = [];
  let recoveries = 0;
  const host: EnhancementHost = {
    read: () => Promise.resolve(""),
    submitText: (text) => {
      inputs.push(text);
      return Promise.resolve();
    },
    sendKeys: (value) => {
      keys.push(value);
      return Promise.resolve();
    },
    requestRecovery: () => {
      recoveries++;
      return Promise.resolve();
    },
  };
  return {
    host,
    inputs,
    keys,
    get recoveries() {
      return recoveries;
    },
  };
}

export function thread(id = "known", items: unknown[] = []) {
  return {
    id,
    status: { type: "idle" },
    turns: [{ id: "turn-1", status: "completed", error: null, items }],
  };
}

export async function nativeFixture(
  t: TestContext,
  spawnGit?: typeof childProcess.spawn,
) {
  const primary = resolve(process.cwd(), "primary repo");
  const configuration: Record<string, unknown> = {
    projects: { [primary]: { trust_level: "trusted" } },
  };
  const gitLaunches: { args: readonly string[]; cwd: unknown }[] = [];
  let gitHandler = (
    args: readonly string[],
    cwd: childProcess.SpawnOptions["cwd"],
  ) => {
    if (args.includes("--show-toplevel"))
      return typeof cwd === "string" ? resolve(cwd) : primary;
    return join(primary, ".git");
  };
  let configHandler = (request: Request): unknown => {
    if (request.method === "config/read")
      return { config: configuration, origins: {}, layers: [] };
    assert.equal(request.params.keyPath, "projects");
    assert.equal(request.params.mergeStrategy, "upsert");
    const projects = (configuration.projects ??= {}) as Record<string, unknown>;
    for (const [path, value] of Object.entries(
      request.params.value as Record<string, Record<string, unknown>>,
    ))
      projects[path] = { ...(projects[path] as object), ...value };
    return {
      status: "ok",
      version: "written",
      filePath: join(primary, "config.toml"),
    };
  };
  const requests: Request[] = [];
  const launches: {
    command: string;
    args: readonly string[];
    options: childProcess.SpawnOptions;
  }[] = [];
  const sockets: WebSocket[] = [];
  const proxies: childProcess.ChildProcessWithoutNullStreams[] = [];
  const server = new WebSocketServer({ noServer: true });
  const listener = createServer((socket) => {
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", handshake);
      const headers: Record<string, string> = {};
      for (const line of buffered
        .subarray(0, end)
        .toString()
        .split("\r\n")
        .slice(1)) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      // The native proxy forwards the WebSocket upgrade bytes unchanged.
      const request = { method: "GET", headers, url: "/" };
      server.handleUpgrade(
        request as Parameters<typeof server.handleUpgrade>[0],
        socket,
        buffered.subarray(end + 4),
        (ws) => server.emit("connection", ws),
      );
    };
    socket.on("data", handshake);
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  let snapshot = thread();
  let handler: (request: Request) => unknown = (request) => {
    if (request.method === "thread/resume" || request.method === "thread/read")
      return { thread: snapshot };
    return {};
  };
  server.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => {
      assert.ok(Buffer.isBuffer(data));
      const request = JSON.parse(data.toString()) as Request;
      requests.push(request);
      if (request.id === undefined) return;
      void Promise.resolve()
        .then(() =>
          request.method.startsWith("config/")
            ? configHandler(request)
            : handler(request),
        )
        .then(
          (result) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ id: request.id, result }));
          },
          () => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  id: request.id,
                  error: {
                    code: -32603,
                    message: "secret payload must not be logged",
                  },
                }),
              );
          },
        );
    });
  });
  t.mock.method(
    childProcess,
    "spawn",
    (
      command: string,
      args: readonly string[],
      options: childProcess.SpawnOptions,
    ) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          child.emit("close", 0);
          return true;
        },
      });
      if (command === "git") {
        gitLaunches.push({ args, cwd: options.cwd });
        if (spawnGit) return spawnGit(command, args, options);
        queueMicrotask(() => {
          try {
            child.stdout.end(`${gitHandler(args, options.cwd)}\n`);
            child.emit("close", 0);
          } catch (error) {
            child.emit("error", error);
            child.emit("close", 1);
          }
        });
        return child;
      }
      launches.push({ command, args, options });
      if (args.includes("proxy")) {
        const socket = connect(address.port, "127.0.0.1");
        socket.setNoDelay(true);
        child.stdin.pipe(socket);
        socket.pipe(child.stdout);
        child.kill = () => {
          socket.destroy();
          child.emit("close", 0);
          return true;
        };
        socket.on("error", (error) => child.emit("error", error));
        socket.on("close", () => child.emit("close", 0));
        proxies.push(
          child as unknown as childProcess.ChildProcessWithoutNullStreams,
        );
      } else {
        queueMicrotask(() => child.emit("close", 0));
      }
      return child;
    },
  );
  t.after(async () => {
    for (const proxy of proxies) proxy.kill();
    for (const socket of sockets) socket.terminate();
    server.close();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    primary,
    configuration,
    gitLaunches,
    get gitHandler() {
      return gitHandler;
    },
    set gitHandler(value: typeof gitHandler) {
      gitHandler = value;
    },
    get configHandler() {
      return configHandler;
    },
    set configHandler(value: typeof configHandler) {
      configHandler = value;
    },
    requests,
    launches,
    sockets,
    proxies,
    set snapshot(value: ReturnType<typeof thread>) {
      snapshot = value;
    },
    set handler(value: typeof handler) {
      handler = value;
    },
    notify(method: string, params: Record<string, unknown>) {
      for (const socket of sockets)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ method, params }));
    },
  };
}
