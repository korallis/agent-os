import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  agentRoleSchema,
  type DaemonControlFrame,
  type ExtensionToDaemonFrame,
  type AgentRole,
} from "@agent-os/protocol";

/**
 * agent-os Pi extension (master plan §1.1, §4).
 *
 * Injected into every spawned Pi via `-e`. Streams lifecycle telemetry to
 * agentosd over a per-session Unix socket, receives control injections, and
 * carries the Brain's tool bridge (`ext.tool_call` → `ctl.tool_result`).
 * Telemetry-only in the model-visible sense: it injects nothing into context
 * that the daemon did not explicitly send.
 *
 * Pi's real extension API is adapter-shaped; this module exports a portable
 * host that both the real Pi entrypoint and our contract tests can drive.
 */

export const EXTENSION_VERSION = "0.2.0";

/** ULID-shaped id — the daemon's frame schemas reject anything else. */
function nextId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const hex = randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    const nibble = Number.parseInt(hex[i % hex.length] ?? "0", 16);
    out += alphabet[(nibble * 2 + i) % alphabet.length];
  }
  return out;
}

export interface ExtensionHostOptions {
  socketPath: string;
  sessionId: string;
  role: AgentRole;
  piVersion: string;
  /** Reconnect backoff; 0 disables retries (tests). */
  retryMs?: number;
  /** Max reconnect attempts before giving up on the daemon. */
  maxRetries?: number;
}

interface PendingToolCall {
  resolve: (result: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => void;
}

export class AgentOsExtensionHost {
  private socket: Socket | null = null;
  private buffer = "";
  private readonly pending: ExtensionToDaemonFrame[] = [];
  private readonly inflight = new Map<string, PendingToolCall>();
  private attempts = 0;
  private closed = false;
  onControl: ((frame: DaemonControlFrame) => void) | null = null;
  /** Messages the daemon injected (wake digests, verbatim gate FAILs, answers). */
  onInjectedMessage: ((message: string) => void) | null = null;

  constructor(private readonly options: ExtensionHostOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      socket.on("connect", () => {
        this.attempts = 0;
        this.socket = socket;
        this.sendHello();
        for (const frame of this.pending) {
          this.write(frame);
        }
        this.pending.length = 0;
        resolve();
      });
      socket.on("error", (error) => {
        if (this.socket === null) {
          reject(error);
        }
      });
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.scheduleReconnect();
        }
      });
      socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    });
  }

  /**
   * Connect, retrying while the daemon is starting or restarting. Pi must never
   * crash because agentosd is momentarily absent.
   */
  async connectWithRetry(): Promise<boolean> {
    const retryMs = this.options.retryMs ?? 250;
    const maxRetries = this.options.maxRetries ?? 20;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await this.connect();
        return true;
      } catch {
        if (retryMs === 0 || attempt === maxRetries) return false;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    return false;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const retryMs = this.options.retryMs ?? 250;
    if (retryMs === 0) return;
    this.attempts += 1;
    if (this.attempts > (this.options.maxRetries ?? 20)) return;
    setTimeout(() => {
      void this.connect().catch(() => undefined);
    }, retryMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let frame: DaemonControlFrame;
      try {
        frame = JSON.parse(line) as DaemonControlFrame;
      } catch {
        continue;
      }
      if (frame.type === "ctl.tool_result") {
        const waiter = this.inflight.get(frame.invocationId);
        if (waiter !== undefined) {
          this.inflight.delete(frame.invocationId);
          waiter.resolve({
            ok: frame.ok,
            ...(frame.data !== undefined ? { data: frame.data } : {}),
            ...(frame.error !== undefined ? { error: frame.error } : {}),
          });
        }
      } else if (frame.type === "ctl.injectMessage") {
        this.onInjectedMessage?.(frame.message);
      }
      this.onControl?.(frame);
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

  /** Ask the Captain/Brain a blocking question; the answer arrives as an injection. */
  ask(question: string): string {
    const questionId = nextId();
    this.write({
      type: "ext.question",
      sessionId: this.options.sessionId,
      questionId,
      question,
      ts: new Date().toISOString(),
    });
    return questionId;
  }

  /**
   * The Brain's tool bridge: call a daemon tool and await its typed result.
   * The daemon authorizes by session — a crewmate calling an orchestration tool
   * gets `UNAUTHORIZED_TOOL` back, not silence.
   */
  callTool(
    tool: string,
    input: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
    const invocationId = nextId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(invocationId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: `tool ${tool} timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);
      this.inflight.set(invocationId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      this.write({
        type: "ext.tool_call",
        sessionId: this.options.sessionId,
        invocationId,
        tool,
        input,
        ts: new Date().toISOString(),
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const [id, waiter] of this.inflight) {
      this.inflight.delete(id);
      waiter.resolve({
        ok: false,
        error: { code: "DISCONNECTED", message: "extension socket closed" },
      });
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Pi extension entry — Pi loads this when passed with `-e`.
 * Uses AGENTOS_SOCKET / AGENTOS_SESSION_ID / AGENTOS_ROLE from the scrubbed
 * spawn env. Returns the host so a Pi adapter can expose `callTool`/`ask` as
 * Pi tools for the Brain seat.
 */
export default function agentOsPiExtension(pi: {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  version?: string;
  sendUserMessage?: (message: string) => void;
}): AgentOsExtensionHost | undefined {
  const socketPath = process.env.AGENTOS_SOCKET;
  const sessionId = process.env.AGENTOS_SESSION_ID;
  if (socketPath === undefined || sessionId === undefined) {
    return undefined;
  }

  const parsedRole = agentRoleSchema.safeParse(process.env.AGENTOS_ROLE);
  const host = new AgentOsExtensionHost({
    socketPath,
    sessionId,
    role: parsedRole.success ? parsedRole.data : "builder",
    piVersion: pi.version ?? "unknown",
  });

  void host.connectWithRetry();

  // Daemon-side injections (wake digests, verbatim gate FAILs, answers) are the
  // only text that reaches the model, and only when the daemon sends it.
  host.onInjectedMessage = (message) => {
    pi.sendUserMessage?.(message);
  };

  pi.on?.("agent_start", () => host.lifecycle("session_start"));
  pi.on?.("turn_start", () => host.lifecycle("turn_start"));
  pi.on?.("turn_end", () => host.lifecycle("turn_end"));
  pi.on?.("agent_settled", () => host.lifecycle("agent_settled"));
  pi.on?.("tool_execution_start", () => host.lifecycle("tool_call"));
  pi.on?.("tool_execution_end", () => host.lifecycle("tool_result"));
  pi.on?.("agent_end", () => {
    host.lifecycle("session_end");
    host.close();
  });

  return host;
}
