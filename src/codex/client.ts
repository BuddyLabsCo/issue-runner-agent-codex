import childProcess from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { EnhancementContext } from "issue-runner-core/terminal";
import { createLog, type Log } from "./log.ts";
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
  readonly log: Log;
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
      deadline: ReturnType<Log["schedule"]>;
    }
  >();
  private readonly context: EnhancementContext;
  private socket!: WebSocket;
  private stopped = false;
  private readonly releases = new Set<() => void | Promise<void>>();
  private releasing: Promise<void> | undefined;

  constructor(context: EnhancementContext, log: Log = createLog(context.cwd)) {
    this.context = context;
    this.log = log;
  }

  private open(): void {
    const context = this.context;
    const log = this.log.capture();
    log.info("proxy start", {
      command: "codex",
      args: ["app-server", "proxy"],
    });
    const proxy = childProcess.spawn("codex", ["app-server", "proxy"], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: "pipe",
    });
    let releasing = false;
    proxy.on("exit", (code, signal) =>
      log[code === 0 || releasing ? "info" : "error"]("proxy exit", {
        code,
        signal,
      }),
    );
    let closed = false;
    const exited = new Promise<void>((resolve) => {
      proxy.once("close", (code, signal) => {
        log[code === 0 || releasing ? "info" : "error"]("proxy close", {
          code,
          signal,
        });
        closed = true;
        resolve();
      });
    });
    this.releases.add(async () => {
      if (closed) return;
      let timer!: ReturnType<typeof setTimeout>;
      let failed!: (error: Error) => void;
      const deadline = this.log.schedule(
        "proxy release deadline",
        proxyReleaseTimeout,
        "owned proxy cleanup",
      );
      try {
        await new Promise<void>((resolve, reject) => {
          failed = reject;
          proxy.once("error", failed);
          timer = setTimeout(() => {
            deadline("timed out");
            reject(new Error("Codex proxy release timed out"));
          }, proxyReleaseTimeout);
          void exited.then(resolve);
          releasing = true;
          this.log.info("proxy stop");
          proxy.kill();
        });
      } finally {
        clearTimeout(timer);
        deadline("cancelled");
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
    log.info("transport connection start");
    const handshake = log.schedule(
      "transport connection deadline",
      requestTimeout,
      "WebSocket handshake",
    );
    this.socket = new WebSocket("ws://localhost/", {
      createConnection: () => stream,
      handshakeTimeout: requestTimeout,
      perMessageDeflate: false,
    });
    const socket = this.socket;
    socket.once("open", () => handshake("cancelled"));
    this.releases.add(() => {
      releasing = true;
      this.log.info("transport stop");
      socket.terminate();
    });
    const disconnected = () => {
      if (socket === this.socket) this.disconnect();
    };
    proxy.stderr.on("data", (data: Buffer) =>
      log.info("proxy stderr", data.toString()),
    );
    proxy.on("error", (error) => {
      log.error("proxy error", error);
      disconnected();
    });
    proxy.on("close", disconnected);
    stream.on("error", (error) => {
      log[
        releasing && (error as NodeJS.ErrnoException).code === "ABORT_ERR"
          ? "info"
          : "error"
      ]("transport error", error);
      disconnected();
    });
    socket.on("error", (error) => {
      handshake(
        error.message.includes("timed out") ? "timed out" : "cancelled",
      );
      log.error("socket error", error);
      disconnected();
    });
    socket.on("close", (code, reason) => {
      handshake("cancelled");
      log[releasing || code === 1000 ? "info" : "error"]("socket close", {
        code,
        reason: reason.toString(),
      });
      disconnected();
    });
    this.socket.on("message", (data) => {
      if (socket !== this.socket || !this.available || this.stopped) return;
      try {
        if (!Buffer.isBuffer(data)) throw new Error("Invalid Codex frame");
        const message = object(JSON.parse(data.toString()));
        if (typeof message.method === "string") {
          if (message.id !== undefined) return;
          const notification = {
            method: message.method,
            params: object(message.params),
          };
          if (
            message.method === "error" ||
            message.method === "configWarning"
          ) {
            const { threadId, turnId } = notification.params;
            const context = this.log.current();
            if (
              typeof threadId === "string" &&
              threadId !== context.sessionref
            ) {
              context.sessionref = threadId;
              context.assignmentId = undefined;
              context.turnId = undefined;
            }
            if (typeof turnId === "string") context.turnId = turnId;
            const log = this.log.capture(context);
            log[message.method === "error" ? "error" : "info"](
              "native service notification",
              notification.params,
            );
          }
          for (const listener of this.notifications) listener(notification);
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.deadline("cancelled");
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
        this.log.error("native message failed", error);
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
    this.log.info("RPC notification", { method: "initialized" });
    this.socket.send(JSON.stringify({ method: "initialized" }));
  }

  async reconnect(): Promise<void> {
    this.log.info("transport reconnect start");
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
    const log = this.log.capture();
    return log.run(async () => {
      const socket = this.socket;
      const attempts = retryable.has(method) ? 3 : 1;
      for (let attempt = 1; ; attempt++) {
        try {
          log.info("RPC attempt", { method, params, attempt });
          if (socket !== this.socket || !this.available || this.stopped)
            throw new Error("Codex observation unavailable");
          return await this.send(method, params);
        } catch (error) {
          log.error("RPC attempt failed", { method, attempt, error });
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
    });
  }

  private retryDelay(): Promise<void> {
    const wait = this.log.schedule(
      "RPC retry wait",
      1_000,
      "retryable RPC failure",
    );
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        wait("cancelled");
        this.retryWaits.delete(cancel);
        reject(new Error("Codex observation disconnected"));
      };
      const timer = setTimeout(() => {
        wait("started");
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
    const log = this.log.capture();
    const id = ++this.sequence;
    const deadline = log.schedule("RPC deadline", requestTimeout, method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        deadline("timed out");
        reject(new RpcFailure("Codex RPC request timed out"));
      }, requestTimeout);
      this.pending.set(id, { resolve, reject, timer, deadline });
      const socket = this.socket;
      try {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            log.error("socket send failed", error);
            if (socket === this.socket) this.disconnect();
          }
        });
      } catch (error) {
        clearTimeout(timer);
        deadline("cancelled");
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
    for (const { reject, timer, deadline } of this.pending.values()) {
      clearTimeout(timer);
      deadline("cancelled");
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
    const log = this.log.capture();
    this.releasing = Promise.allSettled(
      [...this.releases].reverse().map(async (release) => {
        await log.run(release);
        this.releases.delete(release);
      }),
    )
      .then((results) => {
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason as unknown);
        for (const error of errors) log.error("native cleanup failed", error);
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
  log: Log = createLog(context.cwd),
): Promise<NativeClient> {
  log.info("daemon start", {
    command: "codex",
    args: ["app-server", "daemon", "start"],
  });
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
      log[code === 0 ? "info" : "error"]("daemon starter exit", {
        code,
        signal,
      }),
    );
    starter.stdout.resume();
    starter.stderr.on("data", (data: Buffer) =>
      log.info("daemon starter stderr", data.toString()),
    );
    const deadline = log.schedule(
      "daemon startup deadline",
      requestTimeout,
      "daemon start",
    );
    const timer = setTimeout(() => {
      deadline("timed out");
      // Release can emit error or close synchronously; preserve the timeout first.
      const error = new Error("Codex daemon startup timed out");
      log.error("daemon startup failed", error);
      reject(error);
      try {
        log.info("daemon starter stop");
        if (!starter.kill()) throw new Error("Codex starter release failed");
      } catch (error) {
        log.error("initialization cleanup failed", error);
        diagnostic(undefined, "initialization cleanup failed");
      }
    }, requestTimeout);
    starter.once("error", (error) => {
      log.error("daemon starter error", error);
      clearTimeout(timer);
      deadline("cancelled");
      reject(new Error("Codex daemon startup failed"));
    });
    starter.once("close", (code, signal) => {
      log[code === 0 ? "info" : "error"]("daemon starter close", {
        code,
        signal,
      });
      clearTimeout(timer);
      deadline("cancelled");
      if (code === 0) resolve();
      else reject(new Error("Codex daemon startup failed"));
    });
  }).catch((error: unknown) => {
    log.error("daemon startup failed", error);
    throw error;
  });
  const client = new NativeClient(context, log);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    log.error("native initialization failed", error);
    await client.close().catch((error: unknown) => {
      log.error("initialization cleanup failed", error);
      diagnostic(undefined, "initialization cleanup failed");
    });
    throw error;
  }
}
