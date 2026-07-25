import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import {
  agentRoleSchema,
  BRAIN_TOOL_NAMES,
  type DaemonControlFrame,
  type ExtensionToDaemonFrame,
  type AgentRole,
} from "@agent-os/protocol";

/**
 * agent-os Pi extension (master plan §1.1, §4).
 *
 * Injected into every spawned Pi via `-e`. Streams lifecycle telemetry to
 * agentosd over a per-session Unix socket, receives control injections, and
 * captures assistant output for fusion side artifacts. The Brain seat alone
 * also gets the tool bridge (`ext.tool_call` → `ctl.tool_result`) registered
 * as model-visible Pi tools; clean-room crewmates load this extension for
 * telemetry and output capture only — nothing model-visible is injected.
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

/** Minimal Pi extension API surface we depend on (real Pi 0.82+ plus contract hosts). */
export interface PiExtensionApi {
  on?: (
    event: string,
    handler: (...args: unknown[]) => unknown,
  ) => void;
  version?: string;
  registerTool?: (definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: unknown,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  }) => void;
  sendMessage?: (
    message: { customType: string; content: string; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => void;
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

/** Loose object schema for proxy tools — daemon validates the real input. */
const proxyParams = Type.Object({}, { additionalProperties: true });

function registerAgentOsTools(pi: PiExtensionApi, host: AgentOsExtensionHost): void {
  if (typeof pi.registerTool !== "function") {
    return;
  }

  for (const toolName of BRAIN_TOOL_NAMES) {
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: `Agent OS substrate tool \`${toolName}\`. Proxied to agentosd; authorization is by session.`,
      parameters: proxyParams,
      async execute(_toolCallId, params) {
        const result = await host.callTool(toolName, params);
        if (result.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.data ?? null),
              },
            ],
            details: { ok: true },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: result.error ?? { code: "INTERNAL", message: "tool failed" },
              }),
            },
          ],
          details: { ok: false },
        };
      },
    });
  }

  pi.registerTool({
    name: "agent_os_ask",
    label: "agent_os_ask",
    description:
      "Ask the Captain or Brain a blocking question. Returns a questionId; the answer arrives as an injected message.",
    parameters: Type.Object({
      question: Type.String({ description: "Question for the Captain or Brain" }),
    }),
    async execute(_toolCallId, params) {
      const question =
        typeof params.question === "string" ? params.question : String(params.question ?? "");
      const questionId = host.ask(question);
      return {
        content: [{ type: "text", text: JSON.stringify({ questionId }) }],
        details: { questionId },
      };
    },
  });
}

/**
 * Extract plain-text blocks from a finalized Pi assistant message.
 * Best-effort: unknown shapes yield an empty string rather than throwing.
 */
export function extractAssistantText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("");
}

/**
 * Map a Pi assistant message's usage into the extension frame shape.
 * Returns null when the message is not an assistant turn with usable totals.
 */
export function usageFromAssistantMessage(message: unknown): {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  contextUsedPct: number | null;
} | null {
  if (message === null || typeof message !== "object") return null;
  const m = message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cost?: { total?: unknown };
    };
  };
  if (m.role !== "assistant" || m.usage === undefined) return null;
  return {
    provider: typeof m.provider === "string" ? m.provider : "unknown",
    model: typeof m.model === "string" ? m.model : "unknown",
    inputTokens: typeof m.usage.input === "number" ? m.usage.input : null,
    outputTokens: typeof m.usage.output === "number" ? m.usage.output : null,
    costUsd:
      typeof m.usage.cost?.total === "number" ? m.usage.cost.total : null,
    contextUsedPct: null,
  };
}

function messageFromEvent(event: unknown): unknown {
  if (event !== null && typeof event === "object" && "message" in event) {
    return (event as { message: unknown }).message;
  }
  return event;
}

/**
 * Expand ~ / $HOME / ${HOME} / $AGENTOS_GATE_WORKSPACE then resolve against cwd.
 * Used so bash tokens cannot walk into the gate tree via relative or home paths.
 */
export function resolveToolPath(
  candidate: string,
  cwd: string,
  home: string = process.env.HOME ?? "",
  gateWorkspace: string = process.env.AGENTOS_GATE_WORKSPACE ?? "",
): string {
  let token = candidate.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1);
  }
  if (token === "~") {
    token = home;
  } else if (token.startsWith("~/")) {
    token = `${home}${token.slice(1)}`;
  } else if (token.startsWith("${HOME}")) {
    token = `${home}${token.slice("${HOME}".length)}`;
  } else if (token.startsWith("$HOME")) {
    token = `${home}${token.slice("$HOME".length)}`;
  } else if (gateWorkspace.length > 0) {
    if (token.startsWith("${AGENTOS_GATE_WORKSPACE}")) {
      token = `${gateWorkspace}${token.slice("${AGENTOS_GATE_WORKSPACE}".length)}`;
    } else if (token.startsWith("$AGENTOS_GATE_WORKSPACE")) {
      token = `${gateWorkspace}${token.slice("$AGENTOS_GATE_WORKSPACE".length)}`;
    }
  }
  return resolve(cwd, token);
}

/** True when `candidate` resolves inside `gateRoot` (../ cannot walk in). */
export function pathIsInsideGate(
  candidate: string,
  gateRoot: string,
  cwd: string,
  home: string = process.env.HOME ?? "",
): boolean {
  if (candidate.length === 0) return false;
  const resolved = resolveToolPath(candidate, cwd, home, gateRoot);
  const gate = resolve(gateRoot);
  const rel = relative(gate, resolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Collect path-like arguments from a Pi tool call for gate-workspace denial. */
export function collectToolPathCandidates(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) paths.push(value);
  };

  push(input.path);
  push(input.file);
  push(input.filepath);
  push(input.file_path);
  push(input.filePath);
  push(input.target);
  push(input.target_path);
  push(input.targetPath);

  if (Array.isArray(input.paths)) {
    for (const p of input.paths) push(p);
  }
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit !== null && typeof edit === "object") {
        push((edit as { path?: unknown }).path);
      }
    }
  }

  if (toolName === "bash" || toolName === "shell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.length > 0) {
      // Path-like tokens: absolute, ~/..., $HOME/..., ${HOME}/..., relative with /.
      const tokenRe =
        /(?:^|[\s"'=])((?:~|\$\{?HOME\}?|\$\{?AGENTOS_GATE_WORKSPACE\}?)(?:\/[^\s"'\\;|&<>]*)?|(?:\.{1,2}\/)?(?:[^\s"'\\;|&<>]*\/)+[^\s"'\\;|&<>]*)/g;
      for (const match of command.matchAll(tokenRe)) {
        const token = match[1];
        if (token !== undefined) push(token);
      }
    }
  }

  return paths;
}

/**
 * If any resolved path falls inside the gate workspace, return a block reason.
 * Otherwise null. Paths are expanded (~, $HOME) and resolved against cwd so
 * relative and home-relative bash argv cannot bypass the fence.
 */
export function gateWorkspaceBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  gateWorkspace: string,
  cwd: string = process.cwd(),
  home: string = process.env.HOME ?? "",
): string | null {
  const gate = resolve(gateWorkspace);
  for (const candidate of collectToolPathCandidates(toolName, input)) {
    if (pathIsInsideGate(candidate, gate, cwd, home)) {
      const resolved = resolveToolPath(candidate, cwd, home, gate);
      return `builder is tool/fs-blocked from the gate workspace (${gate}): refused path ${resolved}`;
    }
  }
  return null;
}

/** True when `candidate` resolves inside `root` (../ cannot walk in). */
export function pathIsInsideRoot(
  candidate: string,
  root: string,
  cwd: string,
  home: string = process.env.HOME ?? "",
  gateWorkspace: string = process.env.AGENTOS_GATE_WORKSPACE ?? "",
): boolean {
  if (candidate.length === 0) return false;
  const resolved = resolveToolPath(candidate, cwd, home, gateWorkspace);
  const base = resolve(root);
  const rel = relative(base, resolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Validator write-jail: allow paths inside the gate workspace; deny anything
 * else that resolves under AGENTOS_HOME. Fail closed when resolution fails.
 */
export function validatorJailBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  gateWorkspace: string,
  agentosHome: string,
  cwd: string = process.cwd(),
  home: string = process.env.HOME ?? "",
): string | null {
  const gate = resolve(gateWorkspace);
  const agentHome = resolve(agentosHome);
  for (const candidate of collectToolPathCandidates(toolName, input)) {
    let resolved: string;
    try {
      resolved = resolveToolPath(candidate, cwd, home, gate);
    } catch {
      return `validator write-jail: failed to resolve path token (fail closed)`;
    }
    const insideGate =
      relative(gate, resolved) === "" ||
      (() => {
        const rel = relative(gate, resolved);
        return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
      })();
    if (insideGate) continue;
    const insideAgentHome =
      relative(agentHome, resolved) === "" ||
      (() => {
        const rel = relative(agentHome, resolved);
        return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
      })();
    if (insideAgentHome) {
      return `validator is write-jailed to the gate workspace (${gate}): refused path ${resolved}`;
    }
  }
  return null;
}

/**
 * Pi extension entry — Pi loads this when passed with `-e`.
 * Uses AGENTOS_SOCKET / AGENTOS_SESSION_ID / AGENTOS_ROLE / AGENTOS_SESSION_DIR
 * from the scrubbed spawn env. Registers the agent-os tool surface only for
 * the Brain seat (`AGENTOS_ROLE=brain`); clean-room sides get lifecycle
 * telemetry and output capture only. Persists assistant text to
 * `$AGENTOS_SESSION_DIR/outputs/$AGENTOS_SESSION_ID.md` for fusion side
 * artifacts (per-session file so sequential runs never share a path).
 */
export default function agentOsPiExtension(pi: PiExtensionApi): AgentOsExtensionHost | undefined {
  const socketPath = process.env.AGENTOS_SOCKET;
  const sessionId = process.env.AGENTOS_SESSION_ID;
  if (socketPath === undefined || sessionId === undefined) {
    return undefined;
  }

  const sessionDir = process.env.AGENTOS_SESSION_DIR;
  const assistantChunks: string[] = [];

  const persistOutput = (): void => {
    if (sessionDir === undefined || sessionDir.length === 0) return;
    const text = assistantChunks.join("\n\n");
    // Absent model work must look absent — do not invent empty answer files.
    if (text.trim().length === 0) return;
    try {
      const outputsDir = join(sessionDir, "outputs");
      mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(outputsDir, `${sessionId}.md`), text, {
        mode: 0o600,
      });
    } catch {
      // Best-effort: never throw into Pi.
    }
  };

  const parsedRole = agentRoleSchema.safeParse(process.env.AGENTOS_ROLE);
  const role: AgentRole = parsedRole.success ? parsedRole.data : "builder";
  const host = new AgentOsExtensionHost({
    socketPath,
    sessionId,
    role,
    piVersion: pi.version ?? "unknown",
  });

  void host.connectWithRetry();

  // Daemon-side injections (wake digests, verbatim gate FAILs, answers) are the
  // only text that reaches the model, and only when the daemon sends it.
  host.onInjectedMessage = (message) => {
    pi.sendMessage?.(
      { customType: "agent-os", content: message, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  // Clean-room invariant: crewmates (including /opinion sides) must not see
  // orchestration tools in the model-visible catalogue. Brain only.
  if (role === "brain") {
    registerAgentOsTools(pi, host);
  }

  // Path fences: report via ext.tool_blocked for audit. Fail closed on error.
  const gateWorkspace = process.env.AGENTOS_GATE_WORKSPACE;
  const agentosHome = process.env.AGENTOS_HOME;
  if (role === "builder" && gateWorkspace !== undefined && gateWorkspace.length > 0) {
    pi.on?.("tool_call", (event: unknown) => {
      try {
        if (event === null || typeof event !== "object") {
          const reason = "builder gate-dir fence: malformed tool_call event";
          try {
            host.toolBlocked("unknown", reason);
          } catch {
            // still block
          }
          return { block: true, reason };
        }
        const toolName =
          typeof (event as { toolName?: unknown }).toolName === "string"
            ? (event as { toolName: string }).toolName
            : "";
        const rawInput = (event as { input?: unknown }).input;
        const input =
          rawInput !== null && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : {};
        const reason = gateWorkspaceBlockReason(toolName, input, gateWorkspace);
        if (reason === null) return undefined;
        host.toolBlocked(toolName.length > 0 ? toolName : "unknown", reason);
        return { block: true, reason };
      } catch (err) {
        const reason =
          err instanceof Error
            ? `builder gate-dir fence error: ${err.message}`
            : "builder gate-dir fence error: unexpected failure";
        try {
          host.toolBlocked("unknown", reason);
        } catch {
          // still block even if audit emit fails
        }
        return { block: true, reason };
      }
    });
  }

  // Validator write-jail: allow only the gate workspace under AGENTOS_HOME.
  if (
    role === "validator" &&
    gateWorkspace !== undefined &&
    gateWorkspace.length > 0 &&
    agentosHome !== undefined &&
    agentosHome.length > 0
  ) {
    pi.on?.("tool_call", (event: unknown) => {
      try {
        if (event === null || typeof event !== "object") {
          const reason = "validator write-jail: malformed tool_call event";
          try {
            host.toolBlocked("unknown", reason);
          } catch {
            // still block
          }
          return { block: true, reason };
        }
        const toolName =
          typeof (event as { toolName?: unknown }).toolName === "string"
            ? (event as { toolName: string }).toolName
            : "";
        const rawInput = (event as { input?: unknown }).input;
        const input =
          rawInput !== null && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : {};
        const reason = validatorJailBlockReason(
          toolName,
          input,
          gateWorkspace,
          agentosHome,
        );
        if (reason === null) return undefined;
        host.toolBlocked(toolName.length > 0 ? toolName : "unknown", reason);
        return { block: true, reason };
      } catch (err) {
        const reason =
          err instanceof Error
            ? `validator write-jail error: ${err.message}`
            : "validator write-jail error: unexpected failure";
        try {
          host.toolBlocked("unknown", reason);
        } catch {
          // still block even if audit emit fails
        }
        return { block: true, reason };
      }
    });
  }

  pi.on?.("agent_start", () => host.lifecycle("session_start"));
  pi.on?.("turn_start", () => host.lifecycle("turn_start"));
  pi.on?.("turn_end", () => host.lifecycle("turn_end"));
  pi.on?.("tool_execution_start", () => host.lifecycle("tool_call"));
  pi.on?.("tool_execution_end", () => host.lifecycle("tool_result"));

  // Pi 0.82+: message_end carries the finalized assistant message (text + usage).
  pi.on?.("message_end", (event: unknown) => {
    try {
      const message = messageFromEvent(event);
      const text = extractAssistantText(message);
      if (text.length > 0) {
        assistantChunks.push(text);
      }
      const usage = usageFromAssistantMessage(message);
      if (usage !== null) {
        host.usage(usage);
      }
    } catch {
      // Best-effort: never throw into Pi.
    }
  });

  pi.on?.("agent_settled", () => {
    try {
      persistOutput();
    } catch {
      // Best-effort.
    }
    host.lifecycle("agent_settled");
  });

  pi.on?.("agent_end", () => {
    try {
      persistOutput();
    } catch {
      // Best-effort.
    }
    host.lifecycle("session_end");
    host.close();
  });

  return host;
}
