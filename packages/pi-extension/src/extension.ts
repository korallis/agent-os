import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 *
 * Path fencing here is defence-in-depth only: it reduces accidental and casual
 * access by intercepting Pi tool_call args. It is not a containment guarantee
 * against a determined adversary with arbitrary shell. Real guarantees must
 * come from the daemon side — RED proof held in daemon state and HMAC-verified
 * (never re-signed from seat-visible material), the event log never used as an
 * authorization oracle, and the signing key never present in any spawn env.
 * Do not remove daemon-side checks on the belief that this fence already covers them.
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
 * Canonicalize a path for fence comparison by realpath'ing existing components.
 * Symlinks inside a seat workspace that point outside it are followed so the
 * fence compares the true target. For a path that does not exist yet, realpath
 * the nearest existing ancestor and re-append the missing suffix. Throws when
 * no existing ancestor can be resolved (fail closed).
 */
export function realpathForFence(inputPath: string): string {
  const absolute = resolve(inputPath);
  if (existsSync(absolute)) {
    return realpathSync(absolute);
  }
  const segments: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`unresolvable path for fence: ${inputPath}`);
    }
    segments.unshift(basename(cursor));
    cursor = parent;
  }
  let real = realpathSync(cursor);
  for (const segment of segments) {
    real = join(real, segment);
    if (existsSync(real)) {
      real = realpathSync(real);
    }
  }
  return real;
}

/** True when already-canonical `target` lies inside already-canonical `root`. */
function pathInsideResolvedRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * True when `path` lies inside `root` after realpath canonicalization
 * (symlinks and ../ cannot walk out). Returns false if either side cannot
 * be realpath'd — callers that must fail closed should use realpathForFence
 * directly and treat throws as block.
 */
export function isPathInsideRoot(root: string, path: string): boolean {
  try {
    return pathInsideResolvedRoot(realpathForFence(root), realpathForFence(path));
  } catch {
    return false;
  }
}

/**
 * Expand ~ and every `$VAR` / `${VAR}` against the seat's real env, then resolve
 * against cwd. Missing or empty env vars fail closed (throw) so unknown tokens
 * are never treated as relative in-jail paths.
 */
export function resolveToolPath(
  candidate: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let token = candidate.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1);
  }

  const requireEnv = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`unset or empty environment variable: ${name}`);
    }
    return value;
  };

  if (token === "~") {
    token = requireEnv("HOME");
  } else if (token.startsWith("~/")) {
    token = `${requireEnv("HOME")}${token.slice(1)}`;
  }

  token = token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) =>
    requireEnv(name),
  );
  token = token.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) =>
    requireEnv(name),
  );

  return resolve(cwd, token);
}

/** True when `candidate` resolves inside `gateRoot` (../ cannot walk in). */
export function pathIsInsideGate(
  candidate: string,
  gateRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (candidate.length === 0) return false;
  try {
    const resolved = resolveToolPath(candidate, cwd, env);
    return isPathInsideRoot(gateRoot, resolved);
  } catch {
    return false;
  }
}

/**
 * Shell metacharacters that may precede a path token (whitespace, quotes,
 * assignment, redirections, pipes, grouping, sequencing). Without treating
 * `<` `>` etc. as delimiters, `cat</abs/path` yields no candidates.
 */
const SHELL_PATH_PREFIX = String.raw`\s"'=<>|()&;`;

/** Path-like shell tokens: absolute, ~/..., $VAR/..., relative with /. */
const SHELL_PATH_TOKEN_RE = new RegExp(
  `(?:^|[${SHELL_PATH_PREFIX}])((?:~|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?)(?:\\/[^${SHELL_PATH_PREFIX}\\\\]*)?|\\/[^${SHELL_PATH_PREFIX}\\\\]+|(?:\\.{1,2}\\/)?(?:[^${SHELL_PATH_PREFIX}\\\\]*\\/)+[^${SHELL_PATH_PREFIX}\\\\]*)`,
  "g",
);

/** Absolute-looking fragment after a shell delimiter (for fail-closed residue). */
const SHELL_ABS_LOOKING_RE = new RegExp(
  `(?:^|[${SHELL_PATH_PREFIX}\`])(?:\\/|~(?:\\/|$)|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?\\/)`,
);

/**
 * True when a shell command still has absolute-looking content after known
 * path tokens and simple quotes are stripped — treat as unparseable and
 * fail closed rather than as no-candidate (allow).
 */
export function shellCommandHasUnparseableAbs(
  command: string,
  extracted: readonly string[],
): boolean {
  if (command.length === 0) return false;
  let rest = command;
  for (const token of extracted) {
    if (token.length === 0) continue;
    rest = rest.split(token).join(" ");
  }
  rest = rest.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
  return SHELL_ABS_LOOKING_RE.test(rest);
}

/** Collect path-like arguments from a Pi tool call for seat path fencing. */
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
      for (const match of command.matchAll(SHELL_PATH_TOKEN_RE)) {
        const token = match[1];
        if (token !== undefined) push(token);
      }
    }
  }

  return paths;
}

/**
 * Default-deny seat fence: a non-Brain seat may touch ONLY its own workspace
 * plus neutral system/temp locations. Any path under AGENTOS_HOME that is not
 * the seat workspace is refused. Unresolvable env tokens and realpath failures
 * fail closed. This is defence-in-depth (see file header), not containment.
 */
export function seatFenceBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  seatWorkspace: string,
  agentosHome: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  roleLabel: string = "seat",
): string | null {
  let realSeat: string;
  let realHome: string;
  try {
    realSeat = realpathForFence(resolve(seatWorkspace));
    realHome = realpathForFence(resolve(agentosHome));
  } catch {
    return `${roleLabel} path fence: unresolvable seat/home root (fail closed)`;
  }

  const neutralRoots: string[] = [];
  for (const key of ["TMPDIR", "TMP", "TEMP"] as const) {
    const value = env[key];
    if (value !== undefined && value.length > 0) {
      try {
        neutralRoots.push(realpathForFence(resolve(value)));
      } catch {
        // Ignore unresolvable temp roots; they simply never match.
      }
    }
  }

  const candidates = collectToolPathCandidates(toolName, input);

  if (toolName === "bash" || toolName === "shell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (shellCommandHasUnparseableAbs(command, candidates)) {
      return `${roleLabel} path fence: unparseable absolute path in shell command (fail closed)`;
    }
  }

  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = resolveToolPath(candidate, cwd, env);
    } catch {
      return `${roleLabel} path fence: unresolvable path token (fail closed)`;
    }
    let realTarget: string;
    try {
      realTarget = realpathForFence(resolved);
    } catch {
      return `${roleLabel} path fence: unresolvable path (fail closed): ${resolved}`;
    }
    // Seat workspace is the only allowed root under AGENTOS_HOME.
    if (pathInsideResolvedRoot(realSeat, realTarget)) continue;
    // Default-deny anything else under Agent OS home (secrets, events, sibling
    // runs, gate dir for builders). Checked before neutral temps so a home
    // nested under TMPDIR (common in tests) is never fail-open.
    if (pathInsideResolvedRoot(realHome, realTarget)) {
      return `${roleLabel} is tool/fs-blocked outside its seat workspace (${realSeat}): refused path ${realTarget}`;
    }
    // Neutral system/temp paths outside AGENTOS_HOME.
    if (neutralRoots.some((root) => pathInsideResolvedRoot(root, realTarget))) continue;
  }
  return null;
}

/**
 * Builder denylist helper kept for tests: refuse paths inside the gate tree.
 * Production fencing uses {@link seatFenceBlockReason} (default-deny allowlist).
 */
export function gateWorkspaceBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  gateWorkspace: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let realGate: string;
  try {
    realGate = realpathForFence(resolve(gateWorkspace));
  } catch {
    return `builder is tool/fs-blocked from the gate workspace (${gateWorkspace}): unresolvable gate root`;
  }

  const candidates = collectToolPathCandidates(toolName, input);
  if (toolName === "bash" || toolName === "shell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (shellCommandHasUnparseableAbs(command, candidates)) {
      return `builder is tool/fs-blocked from the gate workspace (${realGate}): unparseable absolute path in shell command`;
    }
  }

  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = resolveToolPath(candidate, cwd, env);
    } catch {
      return `builder is tool/fs-blocked from the gate workspace (${realGate}): unresolvable path token`;
    }
    let realTarget: string;
    try {
      realTarget = realpathForFence(resolved);
    } catch {
      return `builder is tool/fs-blocked from the gate workspace (${realGate}): unresolvable path ${resolved}`;
    }
    if (pathInsideResolvedRoot(realGate, realTarget)) {
      return `builder is tool/fs-blocked from the gate workspace (${realGate}): refused path ${realTarget}`;
    }
  }
  return null;
}

/** True when `candidate` resolves inside `root` (../ cannot walk in). */
export function pathIsInsideRoot(
  candidate: string,
  root: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (candidate.length === 0) return false;
  try {
    const resolved = resolveToolPath(candidate, cwd, env);
    return isPathInsideRoot(root, resolved);
  } catch {
    return false;
  }
}

/**
 * Validator write-jail: allow only the seat workspace under AGENTOS_HOME.
 * Implemented as the default-deny seat fence with gate workspace as the seat.
 */
export function validatorJailBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  gateWorkspace: string,
  agentosHome: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const reason = seatFenceBlockReason(
    toolName,
    input,
    gateWorkspace,
    agentosHome,
    cwd,
    env,
    "validator",
  );
  if (reason === null) return null;
  if (reason.includes("unresolvable")) {
    return `validator write-jail: unresolvable path token (fail closed)`;
  }
  const gate = resolve(gateWorkspace);
  const refused = reason.match(/refused path (.+)$/)?.[1] ?? "";
  return `validator is write-jailed to the gate workspace (${gate}): refused path ${refused}`;
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

  // Seat path fence (defence-in-depth — see file header). Report via
  // ext.tool_blocked for audit. Builder/validator always install a handler:
  // when fence roots are missing, block every tool_call (fail closed) rather
  // than skipping registration (fail open).
  if (role === "builder" || role === "validator") {
    const roleLabel = role === "validator" ? "validator" : "builder";
    const configuredHome = process.env.AGENTOS_HOME;
    const configuredSeat =
      process.env.AGENTOS_SEAT_WORKSPACE ??
      process.env.AGENTOS_GATE_WORKSPACE ??
      "";
    const agentosHome =
      configuredHome !== undefined && configuredHome.length > 0
        ? configuredHome
        : null;
    const seatWorkspace = configuredSeat.length > 0 ? configuredSeat : null;

    pi.on?.("tool_call", (event: unknown) => {
      try {
        const toolName =
          event !== null &&
          typeof event === "object" &&
          typeof (event as { toolName?: unknown }).toolName === "string"
            ? (event as { toolName: string }).toolName
            : "unknown";

        if (agentosHome === null || seatWorkspace === null) {
          const reason = `${roleLabel} seat fence: missing fence roots (AGENTOS_HOME / AGENTOS_SEAT_WORKSPACE); all tools blocked`;
          try {
            host.toolBlocked(toolName.length > 0 ? toolName : "unknown", reason);
          } catch {
            // still block
          }
          return { block: true, reason };
        }

        if (event === null || typeof event !== "object") {
          const reason = `${roleLabel} seat fence: malformed tool_call event`;
          try {
            host.toolBlocked("unknown", reason);
          } catch {
            // still block
          }
          return { block: true, reason };
        }
        const rawInput = (event as { input?: unknown }).input;
        const input =
          rawInput !== null && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : {};
        const reason =
          role === "validator"
            ? validatorJailBlockReason(toolName, input, seatWorkspace, agentosHome)
            : seatFenceBlockReason(
                toolName,
                input,
                seatWorkspace,
                agentosHome,
                process.cwd(),
                process.env,
                "builder",
              );
        if (reason === null) return undefined;
        host.toolBlocked(toolName.length > 0 ? toolName : "unknown", reason);
        return { block: true, reason };
      } catch (err) {
        const reason =
          err instanceof Error
            ? `${roleLabel} seat fence error: ${err.message}`
            : `${roleLabel} seat fence error: unexpected failure`;
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
