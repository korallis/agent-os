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
import type { OrchestratorEvent } from "@agent-os/protocol";

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
 */

export interface SecondmateRecord {
  name: string;
  home: string;
  port: number;
  domain: string;
  brainModel: string | null;
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

export class SecondmateStartError extends Error {
  readonly code = "SECONDMATE_START_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecondmateStartError";
  }
}

export class SecondmateRegistry {
  private readonly root: string;
  private readonly runtimeRoot: string;
  private readonly primaryHome: string;
  private sink: SecondmateEventSink = () => undefined;
  private readonly children = new Map<string, ChildProcess>();

  constructor(agentosHome: string) {
    this.primaryHome = agentosHome;
    this.root = join(agentosHome, "secondmates");
    this.runtimeRoot = join(agentosHome, "runtime", "secondmates");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
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
        out.push(JSON.parse(readFileSync(metaPath, "utf8")) as SecondmateRecord);
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
   */
  provision(input: {
    name: string;
    domain: string;
    port?: number;
    brainModel?: string;
    maxConcurrentTasks?: number;
  }): SecondmateRecord {
    const safe = input.name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    if (safe.length === 0) {
      throw new Error("invalid secondmate name");
    }
    const home = join(this.root, safe);
    if (existsSync(home)) {
      throw new Error(`secondmate already exists: ${safe}`);
    }
    const existing = this.list();
    const port = input.port ?? 4710 + existing.length;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "runs"), { recursive: true, mode: 0o700 });
    const record: SecondmateRecord = {
      name: safe,
      home,
      port,
      domain: input.domain,
      brainModel: input.brainModel ?? null,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(home, "charter.json"), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    // Seed charter.json5 + brain cast so start() boots the intended Brain model.
    const charterPath = join(home, "config", "charter.json5");
    const charter = {
      name: safe,
      domains: [input.domain],
      brainModel: input.brainModel ?? null,
      maxConcurrentTasks: input.maxConcurrentTasks ?? 2,
      acceptsRouting: true,
    };
    writeFileSync(
      charterPath,
      `// charter.json5 — secondmate ${safe} (master plan §5.9)\n${JSON.stringify(charter, null, 2)}\n`,
      { mode: 0o600 },
    );
    const cast = input.brainModel ?? "auto";
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
  updateRecord(
    name: string,
    patch: Partial<Pick<SecondmateRecord, "brainModel" | "domain" | "port">>,
  ): SecondmateRecord {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
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
      this.children.delete(record.name);
      if (code !== 0 && code !== null) {
        try {
          rmSync(this.runtimeStatePath(record.name), { force: true });
        } catch {
          // ignore
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
      this.children.delete(record.name);
      try {
        rmSync(this.runtimeStatePath(record.name), { force: true });
      } catch {
        // ignore
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
      try {
        if (existsSync(tokenPath)) {
          const token = readFileSync(tokenPath, "utf8").trim();
          if (token.length > 0) {
            const res = await fetch(`http://127.0.0.1:${record.port}/v1/status`, {
              headers: { authorization: `Bearer ${token}` },
            });
            if (res.ok) {
              const body = (await res.json()) as { daemon?: { home?: string } };
              if (body.daemon?.home === record.home) return;
            }
          }
        }
      } catch {
        // not ready yet
      }
      await sleep(READY_POLL_MS);
    }
    throw new SecondmateStartError(
      `secondmate ${record.name} did not become ready within ${timeoutMs}ms`,
    );
  }

  /**
   * Stop a running secondmate process and wait for exit before clearing runtime
   * state, so a quick restart cannot race the still-held home lock.
   */
  async stop(name: string): Promise<{ stopped: boolean; name: string }> {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    const runtime = this.readRuntime(record.name);
    const child = this.children.get(record.name);
    let pid: number | null = null;
    if (child !== undefined && child.pid !== undefined) {
      pid = child.pid;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    } else if (runtime !== null && isProcessAlive(runtime.pid)) {
      pid = runtime.pid;
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // ignore
      }
    } else {
      try {
        rmSync(this.runtimeStatePath(record.name), { force: true });
      } catch {
        // ignore
      }
      return { stopped: false, name: record.name };
    }

    await waitForExit(pid, child, STOP_EXIT_TIMEOUT_MS);
    this.children.delete(record.name);
    try {
      rmSync(this.runtimeStatePath(record.name), { force: true });
    } catch {
      // ignore
    }
    return { stopped: true, name: record.name };
  }

  /** Stop every secondmate child owned by this registry (daemon shutdown). */
  async stopAll(): Promise<void> {
    const names = [...this.children.keys()];
    for (const name of names) {
      try {
        await this.stop(name);
      } catch {
        // best-effort
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(
  pid: number | null,
  child: ChildProcess | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (child !== undefined) {
    const exited = await new Promise<boolean>((resolve) => {
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
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
      };
      child.once("exit", onExit);
    });
    if (exited) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await sleep(100);
    return;
  }
  if (pid === null) return;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(READY_POLL_MS);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  await sleep(100);
}
