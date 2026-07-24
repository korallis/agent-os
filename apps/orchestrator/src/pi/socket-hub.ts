import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  extensionToDaemonFrameSchema,
  type DaemonControlFrame,
  type ExtensionToDaemonFrame,
  type OrchestratorEvent,
} from "@agent-os/protocol";

/**
 * Per-session Unix domain socket hub (master plan §2.1).
 * Extension streams NDJSON frames; daemon fans out as orchestrator events.
 */

export type ExtensionFrameHandler = (frame: ExtensionToDaemonFrame) => void;

const HUB_SOCK_MODE = 0o600;

export class SocketHub {
  private server: Server | null = null;
  private readonly sockets = new Map<string, Socket>();
  /** Per-session listeners, opened before a Pi spawn and closed on session end. */
  private readonly sessionServers = new Map<string, Server>();
  private onFrame: ExtensionFrameHandler = () => undefined;
  private eventSink: (event: OrchestratorEvent) => void = () => undefined;

  constructor(private readonly socketDir: string) {}

  onExtensionFrame(handler: ExtensionFrameHandler): void {
    this.onFrame = handler;
  }

  onEvent(sink: (event: OrchestratorEvent) => void): void {
    this.eventSink = sink;
  }

  /** Listen on a directory of session sockets: `${socketDir}/hub.sock` as accept path. */
  async listen(): Promise<string> {
    mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
    const path = `${this.socketDir}/hub.sock`;
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.on("error", reject);
      // Owner-only socket: restrict group/other access on multi-user hosts.
      server.listen({ path, readableAll: false, writableAll: false }, () => {
        try {
          chmodSync(path, HUB_SOCK_MODE);
        } catch {
          // Best-effort; parent dir is already 0o700.
        }
        this.server = server;
        resolve(path);
      });
    });
  }

  sessionSocketPath(sessionId: string): string {
    return `${this.socketDir}/${sessionId}.sock`;
  }

  /**
   * Open a dedicated 0600 listener for one session before its Pi is spawned.
   * Per-session sockets (rather than one shared hub) mean a session's control
   * channel cannot be claimed by another local process asserting a `sessionId`
   * in `ext.hello`. Idempotent.
   */
  async openSession(sessionId: string): Promise<string> {
    const existing = this.sessionServers.get(sessionId);
    const path = this.sessionSocketPath(sessionId);
    if (existing !== undefined) return path;

    mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // stale socket from a previous daemon life
      }
    }

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket, sessionId));
      server.on("error", reject);
      server.listen({ path, readableAll: false, writableAll: false }, () => {
        try {
          chmodSync(path, HUB_SOCK_MODE);
        } catch {
          // Best-effort; parent dir is already 0o700.
        }
        this.sessionServers.set(sessionId, server);
        resolve(path);
      });
    });
  }

  /** Tear down a session listener and its socket file. */
  async closeSession(sessionId: string): Promise<void> {
    this.sockets.get(sessionId)?.destroy();
    this.sockets.delete(sessionId);
    const server = this.sessionServers.get(sessionId);
    this.sessionServers.delete(sessionId);
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    try {
      unlinkSync(this.sessionSocketPath(sessionId));
    } catch {
      // already gone
    }
  }

  isSessionConnected(sessionId: string): boolean {
    return this.sockets.has(sessionId);
  }

  /**
   * @param boundSessionId when the connection arrived on a per-session
   * listener, the only `sessionId` this peer is allowed to claim.
   */
  private handleConnection(socket: Socket, boundSessionId?: string): void {
    let buffer = "";
    let sessionId: string | null = null;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const frame = extensionToDaemonFrameSchema.safeParse(parsed);
        if (!frame.success) continue;
        // A per-session peer may only speak for the session it connected as.
        if (boundSessionId !== undefined && frame.data.sessionId !== boundSessionId) {
          continue;
        }
        if (frame.data.type === "ext.hello") {
          sessionId = frame.data.sessionId;
          this.sockets.set(sessionId, socket);
          this.eventSink({
            type: "ext.hello",
            payload: {
              sessionId: frame.data.sessionId,
              role: frame.data.role,
              piVersion: frame.data.piVersion,
            },
          });
        } else if (frame.data.type === "ext.usage") {
          this.eventSink({
            type: "ext.usage",
            payload: {
              sessionId: frame.data.sessionId,
              provider: frame.data.provider,
              model: frame.data.model,
              inputTokens: frame.data.inputTokens,
              outputTokens: frame.data.outputTokens,
              costUsd: frame.data.costUsd,
            },
          });
        }
        this.onFrame(frame.data);
      }
    });

    socket.on("close", () => {
      if (sessionId !== null) this.sockets.delete(sessionId);
    });
  }

  sendControl(sessionId: string, frame: DaemonControlFrame): boolean {
    const socket = this.sockets.get(sessionId);
    if (socket === undefined) return false;
    socket.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.values()) {
      socket.destroy();
    }
    this.sockets.clear();
    for (const [id, server] of this.sessionServers) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        unlinkSync(this.sessionSocketPath(id));
      } catch {
        // already gone
      }
    }
    this.sessionServers.clear();
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

/** Ensure parent dir for a session socket path exists. */
export function ensureSocketParent(socketPath: string): void {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
}
