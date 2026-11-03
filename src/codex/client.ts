import childProcess from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { EnhancementContext } from "issue-runner-core/terminal";

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
  private readonly proxy;
  private readonly stream;
  private readonly socket;
  private stopped = false;
  private readonly exited: Promise<void>;

  constructor(context: EnhancementContext) {
    this.proxy = childProcess.spawn("codex", ["app-server", "proxy"], {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      stdio: "pipe",
    });
    this.exited = new Promise((resolve) => {
      this.proxy.once("close", () => resolve());
    });
    this.stream = Duplex.from({
      readable: this.proxy.stdout,
      writable: this.proxy.stdin,
    });
    // The URL supplies only the HTTP upgrade authority; all bytes use the native proxy.
    this.socket = new WebSocket("ws://localhost/", {
      createConnection: () => this.stream,
      handshakeTimeout: requestTimeout,
      perMessageDeflate: false,
    });
    this.proxy.stderr.resume();
    this.proxy.on("error", () => this.disconnect());
    this.proxy.on("close", () => this.disconnect());
    this.stream.on("error", () => this.disconnect());
    this.socket.on("error", () => this.disconnect());
    this.socket.on("close", () => this.disconnect());
    this.socket.on("message", (data) => {
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
        this.socket.off("open", opened);
        this.disconnections.delete(failed);
      };
      this.disconnections.add(failed);
      this.socket.once("open", opened);
      if (!this.available) failed();
    });
    await this.request("initialize", {
      clientInfo: { name: "issue-runner-agent-codex", version: "0.0.0-dev.1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.socket.send(JSON.stringify({ method: "initialized" }));
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
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.disconnect();
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
    if (this.stopped) return this.exited;
    this.stopped = true;
    this.disconnect();
    this.notifications.clear();
    this.disconnections.clear();
    this.socket.terminate();
    this.stream.destroy();
    this.proxy.kill();
    return this.exited;
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
    await client.close();
    throw error;
  }
}
