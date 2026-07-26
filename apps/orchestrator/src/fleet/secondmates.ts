import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  provisionSecondmateInputSchema,
  type OrchestratorEvent,
  type ProvisionSecondmateInput,
} from "@agent-os/protocol";

/**
 * Secondmates registry (Phase 7 — master plan §5.9).
 *
 * Isolated homes under ~/.agentos/secondmates/<name>/ hold config, tasks, and
 * state. Auth material (Pi store, daemon tokens) lives outside those homes:
 *   - shared Pi auth store: primary's managed pi home (AGENTOS_PI_HOME)
 *   - daemon tokens for bearings: primary runtime/secondmates/<name>/daemon.token
 *
 * A provisioned directory is not a secondmate; start() launches a real
 * agentosd against the isolated home and waits until it is healthy.
 *
 * Lifecycle invariant: runtime.json and the children map describe exactly the
 * process that is actually running, at every instant, and only the owner of a
 * pid may clear that pid's record.
 *
 * Registry mutation ownership: every check-then-act that mutates shared
 * registry state (provision, updateRecord, start, stop, stopAll, orphan
 * reaping) runs on one serial mutation chain. Public mutators enqueue;
 * exclusive helpers run only while that chain entry is held. Do not mutate
 * registry state from outside enqueueMutation.
 */

export interface SecondmateRecord {
  name: string;
  home: string;
  port: number;
  domain: string;
  brainModel: string | null;
  /** Durable capacity cap from provision; used when charter.json5 is missing. */
  maxConcurrentTasks: number;
  createdAt: string;
}

export interface SecondmateRuntimeState {
  name: string;
  pid: number;
  port: number;
  tokenPath: string;
  startedAt: string;
}

export type SecondmateEventSink = (event: OrchestratorEvent) => void;

const START_READY_TIMEOUT_MS = 25_000;
const STOP_EXIT_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

/**
 * Per-secondmate tmux server name. Must never equal the primary's socket —
 * sharing would let BrainManager.teardownPriorBrain kill the primary Brain.
 */
export function secondmateTmuxSocket(name: string): string {
  return `agentos-${name}`;
}

export class SecondmateStartError extends Error {
  readonly code = "SECONDMATE_START_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecondmateStartError";
  }
}

export class SecondmateStopError extends Error {
  readonly code = "SECONDMATE_STOP_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecondmateStopError";
  }
}

export class SecondmateRegistry {
  private readonly root: string;
  private readonly runtimeRoot: string;
  private readonly primaryHome: string;
  private primaryPort: number | null;
  private sink: SecondmateEventSink = () => undefined;
  private readonly children = new Map<string, ChildProcess>();
  /**
   * Single serial owner for all registry mutations (provision / updateRecord /
   * start / stop / stopAll / orphan reaping). Concurrent ops never interleave
   * port allocation, spawn, kill, or bookkeeping.
   */
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(agentosHome: string, options?: { primaryPort?: number }) {
    this.primaryHome = agentosHome;
    this.primaryPort = options?.primaryPort ?? resolvePrimaryPortFromEnv();
    this.root = join(agentosHome, "secondmates");
    this.runtimeRoot = join(agentosHome, "runtime", "secondmates");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
  }

  /** Record the primary daemon's actual bound listen port (after listen). */
  setPrimaryPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid primary port: ${port}`);
    }
    this.primaryPort = port;
  }

  onEvent(sink: SecondmateEventSink): void {
    this.sink = sink;
  }

  list(): SecondmateRecord[] {
    if (!existsSync(this.root)) return [];
    const out: SecondmateRecord[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(this.root, entry.name, "charter.json");
      if (!existsSync(metaPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SecondmateRecord>;
        if (
          typeof raw.name !== "string" ||
          typeof raw.home !== "string" ||
          typeof raw.port !== "number" ||
          typeof raw.domain !== "string"
        ) {
          continue;
        }
        out.push({
          name: raw.name,
          home: raw.home,
          port: raw.port,
          domain: raw.domain,
          brainModel: raw.brainModel ?? null,
          maxConcurrentTasks:
            typeof raw.maxConcurrentTasks === "number" &&
            Number.isInteger(raw.maxConcurrentTasks) &&
            raw.maxConcurrentTasks >= 1
              ? raw.maxConcurrentTasks
              : Number.NaN,
          createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        });
      } catch {
        // skip
      }
    }
    return out;
  }

  get(name: string): SecondmateRecord | null {
    const safe = name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    return this.list().find((r) => r.name === safe) ?? null;
  }

  /**
   * Provision an isolated secondmate home. Refuses if name exists.
   * Does NOT copy auth material (fs scan gate).
   * Validates with provisionSecondmateInputSchema so charter fields
   * (e.g. maxConcurrentTasks 1..32) cannot fail-close admission later.
   * Serialized on the registry mutation chain (port allocation is exclusive).
   */
  async provision(input: ProvisionSecondmateInput): Promise<SecondmateRecord> {
    const validated = provisionSecondmateInputSchema.parse(input);
    return this.enqueueMutation(() => this.provisionExclusive(validated));
  }

  private provisionExclusive(validated: ProvisionSecondmateInput): SecondmateRecord {
    const safe = validated.name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    if (safe.length === 0) {
      throw new Error("invalid secondmate name");
    }
    const home = join(this.root, safe);
    if (existsSync(home)) {
      throw new Error(`secondmate already exists: ${safe}`);
    }
    const existing = this.list();
    const port = validated.port ?? this.nextFreePort(existing);
    this.assertPortAvailable(port, existing);
    const maxConcurrentTasks = validated.maxConcurrentTasks ?? 2;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "runs"), { recursive: true, mode: 0o700 });
    const record: SecondmateRecord = {
      name: safe,
      home,
      port,
      domain: validated.domain,
      brainModel: validated.brainModel ?? null,
      maxConcurrentTasks,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(home, "charter.json"), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    // Seed charter.json5 + brain cast so start() boots the intended Brain model.
    const charterPath = join(home, "config", "charter.json5");
    const charter = {
      name: safe,
      domains: [validated.domain],
      brainModel: validated.brainModel ?? null,
      maxConcurrentTasks,
      acceptsRouting: true,
    };
    writeFileSync(
      charterPath,
      `// charter.json5 — secondmate ${safe} (master plan §5.9)\n${JSON.stringify(charter, null, 2)}\n`,
      { mode: 0o600 },
    );
    const cast = validated.brainModel ?? "auto";
    writeFileSync(
      join(home, "config", "brain.json5"),
      `// brain.json5 — driven by secondmate charter\n{\n  cast: ${JSON.stringify(cast)},\n}\n`,
      { mode: 0o600 },
    );
    this.sink({
      type: "captain.escalation",
      payload: {
        taskId: null,
        summary: `secondmate provisioned: ${safe} on :${port}`,
        severity: "info",
      },
    });
    return record;
  }

  /** Update persisted provision-record fields after a charter edit. */
  async updateRecord(
    name: string,
    patch: Partial<
      Pick<SecondmateRecord, "brainModel" | "domain" | "port" | "maxConcurrentTasks">
    >,
  ): Promise<SecondmateRecord> {
    return this.enqueueMutation(() => this.updateRecordExclusive(name, patch));
  }

  private updateRecordExclusive(
    name: string,
    patch: Partial<
      Pick<SecondmateRecord, "brainModel" | "domain" | "port" | "maxConcurrentTasks">
    >,
  ): SecondmateRecord {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    if (patch.port !== undefined && patch.port !== record.port) {
      this.assertPortAvailable(
        patch.port,
        this.list().filter((r) => r.name !== record.name),
      );
    }
    const next: SecondmateRecord = {
      ...record,
      ...patch,
    };
    writeFileSync(join(record.home, "charter.json"), `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    return next;
  }

  /** Refuse a port already claimed by another secondmate or the primary. */
  private assertPortAvailable(port: number, existing: SecondmateRecord[]): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid secondmate port: ${port}`);
    }
    if (this.primaryPort !== null && port === this.primaryPort) {
      throw new Error(`secondmate port ${port} collides with the primary daemon`);
    }
    const clash = existing.find((r) => r.port === port);
    if (clash !== undefined) {
      throw new Error(`secondmate port ${port} already used by ${clash.name}`);
    }
  }

  private nextFreePort(existing: SecondmateRecord[]): number {
    const used = new Set(existing.map((r) => r.port));
    if (this.primaryPort !== null) used.add(this.primaryPort);
    let port = 4710;
    while (used.has(port)) port += 1;
    if (port > 65535) {
      throw new Error("no free secondmate port available");
    }
    return port;
  }

  /** Path to the daemon token for a secondmate — always outside the audited home. */
  runtimeTokenPath(name: string): string {
    return join(this.runtimeRoot, name, "daemon.token");
  }

  runtimeStatePath(name: string): string {
    return join(this.runtimeRoot, name, "runtime.json");
  }

  readRuntimeToken(name: string): string | null {
    const path = this.runtimeTokenPath(name);
    if (!existsSync(path)) return null;
    try {
      const token = readFileSync(path, "utf8").trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  readRuntime(name: string): SecondmateRuntimeState | null {
    const path = this.runtimeStatePath(name);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SecondmateRuntimeState;
    } catch {
      return null;
    }
  }

  /**
   * Start a secondmate agentosd with AGENTOS_HOME set to its isolated home.
   * Waits until the runtime token exists and /v1/status is healthy before
   * returning. Daemon token is written under primary runtime/ (outside audit).
   * Serialized on the registry mutation chain with provision/stop.
   */
  async start(
    name: string,
    options: {
      agentosdBin: string;
      sharedPiHome: string;
      env?: Record<string, string | undefined>;
      readyTimeoutMs?: number;
    },
  ): Promise<SecondmateRuntimeState> {
    const safe = name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    return this.enqueueMutation(() => this.startExclusive(safe, options));
  }

  /**
   * Queue a registry mutation so only one runs at a time. Failures on prior
   * ops do not block the next.
   */
  private enqueueMutation<T>(op: () => Promise<T> | T): Promise<T> {
    const run = this.mutationChain.then(
      () => Promise.resolve().then(op),
      () => Promise.resolve().then(op),
    );
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startExclusive(
    name: string,
    options: {
      agentosdBin: string;
      sharedPiHome: string;
      env?: Record<string, string | undefined>;
      readyTimeoutMs?: number;
    },
  ): Promise<SecondmateRuntimeState> {
    const record = this.get(name);
    if (record === null) {
      throw new SecondmateStartError(`no secondmate named ${name}`);
    }
    const existing = this.readRuntime(record.name);
    if (existing !== null && isProcessAlive(existing.pid)) {
      throw new SecondmateStartError(
        `secondmate ${record.name} already running (pid ${existing.pid})`,
      );
    }

    const runtimeDir = join(this.runtimeRoot, record.name);
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const tokenPath = this.runtimeTokenPath(record.name);
    // Clear a stale token from a prior crash so readiness waits for a fresh write.
    try {
      rmSync(tokenPath, { force: true });
    } catch {
      // ignore
    }

    const child = spawn(process.execPath, [options.agentosdBin], {
      env: {
        ...process.env,
        ...(options.env ?? {}),
        AGENTOS_HOME: record.home,
        AGENTOS_PORT: String(record.port),
        AGENTOS_TOKEN_PATH: tokenPath,
        AGENTOS_PI_HOME: options.sharedPiHome,
        // Non-copy grant path: API keys resolve from the primary secrets tree.
        AGENTOS_SECRETS_HOME: this.primaryHome,
        // Own tmux server after env spread — primary AGENTOS_TMUX_SOCKET must
        // not be inherited (would share session/window namespace with the primary).
        AGENTOS_TMUX_SOCKET: secondmateTmuxSocket(record.name),
      },
      // Ignore stdio so a chatty child cannot fill pipe buffers and stall.
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });

    if (child.pid === undefined) {
      throw new SecondmateStartError(`failed to spawn secondmate ${record.name}`);
    }

    this.children.set(record.name, child);
    child.on("exit", (code, signal) => {
      const tracked = this.children.get(record.name);
      if (tracked === child) {
        this.children.delete(record.name);
      }
      if (code !== 0 && code !== null) {
        const runtime = this.readRuntime(record.name);
        if (runtime !== null && runtime.pid === child.pid) {
          try {
            rmSync(this.runtimeStatePath(record.name), { force: true });
          } catch {
            // ignore
          }
        }
      }
      void signal;
    });

    const state: SecondmateRuntimeState = {
      name: record.name,
      pid: child.pid,
      port: record.port,
      tokenPath,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(this.runtimeStatePath(record.name), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });

    const readyTimeout = options.readyTimeoutMs ?? START_READY_TIMEOUT_MS;
    try {
      await this.waitUntilReady(record, tokenPath, child, readyTimeout);
    } catch (error) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Reap before clearing bookkeeping — same as stopExclusive. Erasing
      // runtime.json while the child still holds the home lock/port orphans it.
      let reaped = false;
      try {
        await waitForExit(child.pid ?? null, child, STOP_EXIT_TIMEOUT_MS);
        reaped = true;
      } catch {
        // Still alive after SIGKILL window — keep tracking so stop/stopAll can reap.
        reaped = false;
      }
      if (reaped) {
        const tracked = this.children.get(record.name);
        if (tracked === child) {
          this.children.delete(record.name);
        }
        const runtime = this.readRuntime(record.name);
        if (runtime !== null && runtime.pid === child.pid) {
          try {
            rmSync(this.runtimeStatePath(record.name), { force: true });
          } catch {
            // ignore
          }
        }
      }
      throw error instanceof SecondmateStartError
        ? error
        : new SecondmateStartError(
            error instanceof Error ? error.message : "secondmate failed to become ready",
          );
    }

    return state;
  }

  private async waitUntilReady(
    record: SecondmateRecord,
    tokenPath: string,
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new SecondmateStartError(
          `secondmate ${record.name} exited before ready (code ${child.exitCode})`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        if (existsSync(tokenPath)) {
          const token = readFileSync(tokenPath, "utf8").trim();
          if (token.length > 0) {
            const res = await fetchWithTimeout(
              `http://127.0.0.1:${record.port}/v1/status`,
              { headers: { authorization: `Bearer ${token}` } },
              remaining,
            );
            if (res.ok) {
              const body = (await res.json()) as { daemon?: { home?: string } };
              if (body.daemon?.home === record.home) return;
            }
          }
        }
      } catch {
        // not ready yet (including per-attempt timeout)
      }
      await sleep(READY_POLL_MS);
    }
    throw new SecondmateStartError(
      `secondmate ${record.name} did not become ready within ${timeoutMs}ms`,
    );
  }

  /**
   * Stop a running secondmate process and wait for exit before clearing runtime
   * state, so a quick restart cannot race the still-held home lock. Serialized
   * on the registry mutation chain with provision/start; only clears bookkeeping
   * that still names the pid this stop targeted.
   */
  async stop(name: string): Promise<{ stopped: boolean; name: string }> {
    const safe = name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    return this.enqueueMutation(() => this.stopExclusive(safe));
  }

  private async stopExclusive(name: string): Promise<{ stopped: boolean; name: string }> {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    const runtime = this.readRuntime(record.name);
    const child = this.children.get(record.name);
    let targetPid: number | null = null;
    let targetChild: ChildProcess | undefined;
    if (child !== undefined && child.pid !== undefined) {
      targetPid = child.pid;
      targetChild = child;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    } else if (runtime !== null && isProcessAlive(runtime.pid)) {
      targetPid = runtime.pid;
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // ignore
      }
    } else {
      // Stale bookkeeping with no live process — drop only records for a dead
      // runtime pid (or missing runtime), never a newer tracked child.
      if (child !== undefined && (child.pid === undefined || !isProcessAlive(child.pid))) {
        this.children.delete(record.name);
      }
      if (runtime !== null && !isProcessAlive(runtime.pid)) {
        try {
          rmSync(this.runtimeStatePath(record.name), { force: true });
        } catch {
          // ignore
        }
      }
      return { stopped: false, name: record.name };
    }

    await waitForExit(targetPid, targetChild, STOP_EXIT_TIMEOUT_MS);

    // Only the owner of a pid may clear that pid's record.
    const tracked = this.children.get(record.name);
    if (
      tracked !== undefined &&
      (tracked === targetChild ||
        (tracked.pid !== undefined && tracked.pid === targetPid))
    ) {
      this.children.delete(record.name);
    }
    const currentRuntime = this.readRuntime(record.name);
    if (currentRuntime !== null && currentRuntime.pid === targetPid) {
      try {
        rmSync(this.runtimeStatePath(record.name), { force: true });
      } catch {
        // ignore
      }
    }
    return { stopped: true, name: record.name };
  }

  /**
   * Stop every secondmate this primary knows about: live children, provisioned
   * homes, and runtime.json orphans left after a primary crash/restart (those
   * are not re-adopted into `children` and would otherwise keep homes/ports).
   *
   * Runs as one mutation-chain entry so concurrent start/provision cannot
   * resurrect a just-stopped secondmate or sneak past a name snapshot. Re-checks
   * for late arrivals before releasing the chain.
   */
  async stopAll(): Promise<void> {
    return this.enqueueMutation(() => this.stopAllExclusive());
  }

  private async stopAllExclusive(): Promise<void> {
    const processed = new Set<string>();
    for (;;) {
      let foundNew = false;
      for (const name of this.discoverSecondmateNames()) {
        if (processed.has(name)) continue;
        foundNew = true;
        processed.add(name);
        try {
          if (this.get(name) !== null) {
            await this.stopExclusive(name);
          } else {
            await this.stopOrphanRuntime(name);
          }
        } catch {
          // best-effort — still try to kill a runtime-only orphan
          try {
            await this.stopOrphanRuntime(name);
          } catch {
            // ignore
          }
        }
      }
      if (!foundNew) return;
    }
  }

  /** Names known via children, charters, or runtime/ bookkeeping. */
  private discoverSecondmateNames(): Set<string> {
    const names = new Set<string>();
    for (const name of this.children.keys()) names.add(name);
    for (const record of this.list()) names.add(record.name);
    if (existsSync(this.runtimeRoot)) {
      for (const entry of readdirSync(this.runtimeRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
    return names;
  }

  /**
   * Kill a secondmate known only via runtime.json (no charter / children entry).
   * Caller must already hold the registry mutation chain.
   */
  private async stopOrphanRuntime(name: string): Promise<void> {
    const runtime = this.readRuntime(name);
    if (runtime === null || !isProcessAlive(runtime.pid)) {
      try {
        rmSync(this.runtimeStatePath(name), { force: true });
      } catch {
        // ignore
      }
      return;
    }
    try {
      process.kill(runtime.pid, "SIGTERM");
    } catch {
      // ignore
    }
    try {
      await waitForExit(runtime.pid, undefined, STOP_EXIT_TIMEOUT_MS);
    } catch {
      // Orphan reaping is best-effort; leave runtime.json if the pid survived.
      return;
    }
    const still = this.readRuntime(name);
    if (still !== null && still.pid === runtime.pid) {
      try {
        rmSync(this.runtimeStatePath(name), { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Fs-scan of secondmate homes: no Pi auth material and no daemon.token under
   * the audited tree. Runtime tokens live under primary runtime/, not here.
   */
  auditNoAuthMaterial(): { ok: boolean; offenders: string[] } {
    const offenders: string[] = [];
    for (const sm of this.list()) {
      const banned = [
        join(sm.home, "auth.json"),
        join(sm.home, "pi", "agent", "auth.json"),
        join(sm.home, "secrets"),
        join(sm.home, "daemon.token"),
      ];
      for (const path of banned) {
        if (existsSync(path)) offenders.push(path);
      }
    }
    return { ok: offenders.length === 0, offenders };
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolvePrimaryPortFromEnv(): number | null {
  const env = process.env.AGENTOS_PORT;
  if (env === undefined || env.length === 0) return null;
  const parsed = Number(env);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bound a single readiness probe so a hung TCP connect cannot outlive the deadline. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for a soft exit; if the bound expires, SIGKILL and wait (bounded) until
 * the pid is genuinely reaped. Throws SecondmateStopError if still alive.
 */
async function waitForExit(
  pid: number | null,
  child: ChildProcess | undefined,
  timeoutMs: number,
): Promise<void> {
  const softDeadline = Date.now() + timeoutMs;

  if (child !== undefined) {
    const exited = await waitChildExit(child, timeoutMs);
    if (exited) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  } else if (pid !== null) {
    while (Date.now() < softDeadline) {
      if (!isProcessAlive(pid)) return;
      await sleep(READY_POLL_MS);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  } else {
    return;
  }

  // Post-SIGKILL: must confirm reaping before callers clear runtime/port state.
  const hardDeadline = Date.now() + timeoutMs;
  if (child !== undefined) {
    const reaped = await waitChildExit(child, timeoutMs);
    if (reaped) return;
  }
  if (pid !== null) {
    while (Date.now() < hardDeadline) {
      if (!isProcessAlive(pid)) return;
      if (child !== undefined && child.exitCode !== null) return;
      await sleep(READY_POLL_MS);
    }
    if (isProcessAlive(pid) || (child !== undefined && child.exitCode === null)) {
      throw new SecondmateStopError(
        `secondmate pid ${pid} still alive after SIGKILL within ${timeoutMs}ms`,
      );
    }
    return;
  }
  if (child !== undefined && child.exitCode === null) {
    throw new SecondmateStopError(
      `secondmate child still running after SIGKILL within ${timeoutMs}ms`,
    );
  }
}

function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, Math.max(1, timeoutMs));
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
