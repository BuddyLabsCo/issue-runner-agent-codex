import childProcess from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { EnhancementContext } from "issue-runner-core/terminal";
import { createLog, type ErrorLog } from "./log.ts";
import { diagnostic } from "../diagnostics.ts";

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Codex protocol object");
  }
  return value as Record<string, unknown>;
}

export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

const requestTimeout = 10_000;
const proxyReleaseTimeout = 10_000;

const retryable = new Set([
  "hooks/list",
  "config/read",
  "thread/read",
  "thread/loaded/list",
]);

class RpcFailure extends Error {}

export class NativeClient {
  readonly log: ErrorLog;
  private readonly retryWaits = new Set<() => void>();
  readonly notifications = new Set<(notification: Notification) => void>();
  readonly disconnections = new Set<() => void>();
  available = true;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly context: EnhancementContext;
  private socket!: WebSocket;
  private stopped = false;
  private readonly releases = new Set<() => void | Promise<void>>();
  private releasing: Promise<void> | undefined;

  constructor(
    context: EnhancementContext,
    log: ErrorLog = createLog(context.cwd),
  ) {
    this.context = context;
    this.log = log;
  }

  private open(): void {
    const context = this.context;
    const proxy = childProcess.spawn("codex", ["app-server", "proxy"], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: "pipe",
    });
    proxy.on("exit", (code, signal) =>
      this.log("proxy exit", { code, signal }),
    );
    let closed = false;
    const exited = new Promise<void>((resolve) => {
      proxy.once("close", (code, signal) => {
        this.log("proxy close", { code, signal });
        closed = true;
        resolve();
      });
    });
    this.releases.add(async () => {
      if (closed) return;
      let timer!: ReturnType<typeof setTimeout>;
      let failed!: (error: Error) => void;
      try {
        await new Promise<void>((resolve, reject) => {
          failed = reject;
          proxy.once("error", failed);
          timer = setTimeout(
            () => reject(new Error("Codex proxy release timed out")),
            proxyReleaseTimeout,
          );
          void exited.then(resolve);
          proxy.kill();
        });
      } finally {
        clearTimeout(timer);
        proxy.off("error", failed);
      }
    });
    const stream = Duplex.from({
      readable: proxy.stdout,
      writable: proxy.stdin,
    });
    this.releases.add(() => {
      stream.destroy();
    });
    // The URL supplies only the HTTP upgrade authority; all bytes use the native proxy.
    this.socket = new WebSocket("ws://localhost/", {
      createConnection: () => stream,
      handshakeTimeout: requestTimeout,
      perMessageDeflate: false,
    });
    const socket = this.socket;
    this.releases.add(() => socket.terminate());
    const disconnected = () => {
      if (socket === this.socket) this.disconnect();
    };
    proxy.stderr.on("data", (data: Buffer) =>
      this.log("proxy stderr", data.toString()),
    );
    proxy.on("error", (error) => {
      this.log("proxy error", error);
      disconnected();
    });
    proxy.on("close", disconnected);
    stream.on("error", (error) => {
      this.log("transport error", error);
      disconnected();
    });
    socket.on("error", (error) => {
      this.log("socket error", error);
      disconnected();
    });
    socket.on("close", (code, reason) => {
      this.log("socket close", { code, reason: reason.toString() });
      disconnected();
    });
    this.socket.on("message", (data) => {
      if (socket !== this.socket || !this.available || this.stopped) return;
      try {
        if (!Buffer.isBuffer(data)) throw new Error("Invalid Codex frame");
        const message = object(JSON.parse(data.toString()));
        if (typeof message.method === "string") {
          if (message.id !== undefined) return;
          if (message.method === "error" || message.method === "configWarning")
            this.log("native service notification", message.params);
          const notification = {
            method: message.method,
            params: object(message.params),
          };
          for (const listener of this.notifications) listener(notification);
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error !== undefined)
            pending.reject(
              new RpcFailure("Codex RPC request failed", {
                cause: message.error,
              }),
            );
          else pending.resolve(message.result);
        } else {
          throw new Error("Invalid Codex message");
        }
      } catch (error) {
        this.log("native message failed", error);
        this.disconnect();
      }
    });
  }

  async initialize(): Promise<void> {
    this.open();
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Codex proxy connection failed"));
      };
      const cleanup = () => {
        socket.off("open", opened);
        socket.off("close", failed);
        this.disconnections.delete(failed);
      };
      this.disconnections.add(failed);
      socket.once("open", opened);
      socket.once("close", failed);
      if (!this.available || this.stopped) failed();
    });
    await this.request("initialize", {
      clientInfo: { name: "issue-runner-agent-codex", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.socket.send(JSON.stringify({ method: "initialized" }));
  }

  async reconnect(): Promise<void> {
    await this.release();
    if (this.stopped) throw new Error("Codex enhancement stopped");
    this.available = true;
    try {
      await this.initialize();
    } catch (error) {
      this.disconnect();
      await this.release();
      throw error;
    }
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const socket = this.socket;
    const attempts = retryable.has(method) ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        if (socket !== this.socket || !this.available || this.stopped)
          throw new Error("Codex observation unavailable");
        return await this.send(method, params);
      } catch (error) {
        this.log("RPC attempt failed", { method, attempt, error });
        if (
          !(error instanceof RpcFailure) ||
          attempt === attempts ||
          socket !== this.socket ||
          !this.available ||
          this.stopped
        )
          throw error;
        await this.retryDelay();
      }
    }
  }

  private retryDelay(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        this.retryWaits.delete(cancel);
        reject(new Error("Codex observation disconnected"));
      };
      const timer = setTimeout(() => {
        this.retryWaits.delete(cancel);
        resolve();
      }, 1_000);
      this.retryWaits.add(cancel);
    });
  }

  private send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure("Codex RPC request timed out"));
      }, requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      const socket = this.socket;
      try {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            this.log("socket send failed", error);
            if (socket === this.socket) this.disconnect();
          }
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("Codex socket send failed", { cause: error }),
        );
      }
    });
  }

  private disconnect(): void {
    if (!this.available) return;
    this.available = false;
    for (const cancel of this.retryWaits) cancel();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex observation disconnected"));
    }
    this.pending.clear();
    if (!this.stopped) for (const listener of this.disconnections) listener();
  }

  close(): Promise<void> {
    this.stopped = true;
    this.disconnect();
    this.notifications.clear();
    this.disconnections.clear();
    return this.release();
  }

  private release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.releasing = Promise.allSettled(
      [...this.releases].reverse().map(async (release) => {
        await release();
        this.releases.delete(release);
      }),
    )
      .then((results) => {
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason as unknown);
        for (const error of errors) this.log("native cleanup failed", error);
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(errors, "Codex cleanup failed");
      })
      .finally(() => {
        this.releasing = undefined;
      });
    return this.releasing;
  }
}

export async function connectNative(
  context: EnhancementContext,
  log: ErrorLog = createLog(context.cwd),
): Promise<NativeClient> {
  log("native connection starting", { cwd: context.cwd });
  await new Promise<void>((resolve, reject) => {
    const starter = childProcess.spawn(
      "codex",
      ["app-server", "daemon", "start"],
      {
        cwd: context.cwd,
        env: { ...process.env, ...context.env },
        stdio: "pipe",
      },
    );
    starter.on("exit", (code, signal) =>
      log("daemon starter exit", { code, signal }),
    );
    starter.stdout.resume();
    starter.stderr.on("data", (data: Buffer) =>
      log("daemon starter stderr", data.toString()),
    );
    const timer = setTimeout(() => {
      // Release can emit error or close synchronously; preserve the timeout first.
      const error = new Error("Codex daemon startup timed out");
      log("daemon startup failed", error);
      reject(error);
      try {
        if (!starter.kill()) throw new Error("Codex starter release failed");
      } catch (error) {
        log("initialization cleanup failed", error);
        diagnostic(undefined, "initialization cleanup failed");
      }
    }, requestTimeout);
    starter.once("error", (error) => {
      log("daemon starter error", error);
      clearTimeout(timer);
      reject(new Error("Codex daemon startup failed"));
    });
    starter.once("close", (code, signal) => {
      log("daemon starter close", { code, signal });
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Codex daemon startup failed"));
    });
  }).catch((error: unknown) => {
    log("daemon startup failed", error);
    throw error;
  });
  const client = new NativeClient(context, log);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    log("native initialization failed", error);
    await client.close().catch((error: unknown) => {
      log("initialization cleanup failed", error);
      diagnostic(undefined, "initialization cleanup failed");
    });
    throw error;
  }
}
