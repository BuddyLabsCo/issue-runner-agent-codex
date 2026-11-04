import childProcess from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { EnhancementContext } from "issue-runner-core/terminal";
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

export class NativeClient {
  readonly notifications = new Set<(notification: Notification) => void>();
  readonly disconnections = new Set<() => void>();
  available = true;
  readonly configurationWarnings: Record<string, unknown>[] = [];
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

  constructor(context: EnhancementContext) {
    this.context = context;
  }

  private open(): void {
    const context = this.context;
    const proxy = childProcess.spawn("codex", ["app-server", "proxy"], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: "pipe",
    });
    let closed = false;
    const exited = new Promise<void>((resolve) => {
      proxy.once("close", () => {
        closed = true;
        resolve();
      });
    });
    this.releases.add(async () => {
      if (!proxy.kill() && !closed)
        throw new Error("Codex proxy release failed");
      await exited;
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
    proxy.stderr.resume();
    proxy.on("error", disconnected);
    proxy.on("close", disconnected);
    stream.on("error", disconnected);
    socket.on("error", disconnected);
    socket.on("close", disconnected);
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
          if (notification.method === "configWarning")
            this.configurationWarnings.push(notification.params);
          for (const listener of this.notifications) listener(notification);
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error !== undefined)
            pending.reject(new Error("Codex RPC request failed"));
          else pending.resolve(message.result);
        } else {
          throw new Error("Invalid Codex message");
        }
      } catch {
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
      clientInfo: { name: "issue-runner-agent-codex", version: "0.0.0-dev.1" },
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

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.available || this.stopped)
      return Promise.reject(new Error("Codex observation unavailable"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC request timed out"));
      }, requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      const socket = this.socket;
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error && socket === this.socket) this.disconnect();
      });
    });
  }

  private disconnect(): void {
    if (!this.available) return;
    this.available = false;
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
): Promise<NativeClient> {
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
    starter.stdout.resume();
    starter.stderr.resume();
    const timer = setTimeout(() => {
      starter.kill();
      reject(new Error("Codex daemon startup timed out"));
    }, requestTimeout);
    starter.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Codex daemon startup failed"));
    });
    starter.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Codex daemon startup failed"));
    });
  });
  const client = new NativeClient(context);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close().catch(() => {
      diagnostic(undefined, "initialization cleanup failed");
    });
    throw error;
  }
}
