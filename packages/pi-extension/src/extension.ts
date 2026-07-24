import { createConnection, type Socket } from "node:net";
import {
  type DaemonControlFrame,
  type ExtensionToDaemonFrame,
  type AgentRole,
} from "@agent-os/protocol";

/**
 * agent-os Pi extension (master plan §1.1, §4).
 *
 * Injected into every spawned Pi via `-e`. Streams lifecycle telemetry to
 * agentosd over a per-session Unix socket and receives control injections.
 * Telemetry-only: injects nothing model-visible.
 *
 * Pi's real extension API is adapter-shaped; this module exports a portable
 * host that both the real Pi entrypoint and our contract tests can drive.
 */

export const EXTENSION_VERSION = "0.1.0";

export interface ExtensionHostOptions {
  socketPath: string;
  sessionId: string;
  role: AgentRole;
  piVersion: string;
}

export class AgentOsExtensionHost {
  private socket: Socket | null = null;
  private buffer = "";
  private readonly pending: ExtensionToDaemonFrame[] = [];
  onControl: ((frame: DaemonControlFrame) => void) | null = null;

  constructor(private readonly options: ExtensionHostOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      socket.on("connect", () => {
        this.socket = socket;
        for (const frame of this.pending) {
          this.write(frame);
        }
        this.pending.length = 0;
        this.sendHello();
        resolve();
      });
      socket.on("error", reject);
      socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        const frame = JSON.parse(line) as DaemonControlFrame;
        this.onControl?.(frame);
      } catch {
        // ignore
      }
    }
  }

  private write(frame: ExtensionToDaemonFrame): void {
    if (this.socket === null) {
      this.pending.push(frame);
      return;
    }
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  sendHello(): void {
    this.write({
      type: "ext.hello",
      sessionId: this.options.sessionId,
      role: this.options.role,
      piVersion: this.options.piVersion,
      extensionVersion: EXTENSION_VERSION,
      ts: new Date().toISOString(),
    });
  }

  lifecycle(
    phase: Extract<ExtensionToDaemonFrame, { type: "ext.lifecycle" }>["phase"],
    detail: string | null = null,
  ): void {
    this.write({
      type: "ext.lifecycle",
      sessionId: this.options.sessionId,
      phase,
      detail,
      ts: new Date().toISOString(),
    });
  }

  usage(input: {
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    contextUsedPct: number | null;
  }): void {
    this.write({
      type: "ext.usage",
      sessionId: this.options.sessionId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd,
      contextUsedPct: input.contextUsedPct,
      ts: new Date().toISOString(),
    });
  }

  toolBlocked(toolName: string, reason: string): void {
    this.write({
      type: "ext.tool_blocked",
      sessionId: this.options.sessionId,
      toolName,
      reason,
      ts: new Date().toISOString(),
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Pi extension entry — Pi loads this when passed with `-e`.
 * Uses AGENTOS_SOCKET + AGENTOS_SESSION_ID from the scrubbed spawn env.
 */
export default function agentOsPiExtension(pi: {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  version?: string;
}): void {
  const socketPath = process.env.AGENTOS_SOCKET;
  const sessionId = process.env.AGENTOS_SESSION_ID;
  if (socketPath === undefined || sessionId === undefined) {
    return;
  }

  const host = new AgentOsExtensionHost({
    socketPath,
    sessionId,
    role: "builder",
    piVersion: pi.version ?? "unknown",
  });

  void host.connect().catch(() => {
    // Extension is best-effort; Pi must not crash if daemon is down.
  });

  pi.on?.("agent_start", () => host.lifecycle("session_start"));
  pi.on?.("turn_start", () => host.lifecycle("turn_start"));
  pi.on?.("turn_end", () => host.lifecycle("turn_end"));
  pi.on?.("agent_settled", () => host.lifecycle("agent_settled"));
  pi.on?.("agent_end", () => {
    host.lifecycle("session_end");
    host.close();
  });
}
