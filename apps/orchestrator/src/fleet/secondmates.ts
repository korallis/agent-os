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
 * agentosd against the isolated home.
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
   * Daemon token is written under primary runtime/ (outside the audit tree).
   * Shared Pi auth store is pointed at the primary's managed pi home.
   */
  start(
    name: string,
    options: {
      agentosdBin: string;
      sharedPiHome: string;
      env?: Record<string, string | undefined>;
    },
  ): SecondmateRuntimeState {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    const existing = this.readRuntime(record.name);
    if (existing !== null && isProcessAlive(existing.pid)) {
      throw new Error(
        `secondmate ${record.name} already running (pid ${existing.pid})`,
      );
    }

    const runtimeDir = join(this.runtimeRoot, record.name);
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const tokenPath = this.runtimeTokenPath(record.name);

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
      throw new Error(`failed to spawn secondmate ${record.name}`);
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
    return state;
  }

  /** Stop a running secondmate process and clear its runtime record. */
  stop(name: string): { stopped: boolean; name: string } {
    const record = this.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    const runtime = this.readRuntime(record.name);
    const child = this.children.get(record.name);
    if (child !== undefined) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.children.delete(record.name);
    } else if (runtime !== null && isProcessAlive(runtime.pid)) {
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // ignore
      }
    } else {
      return { stopped: false, name: record.name };
    }
    try {
      rmSync(this.runtimeStatePath(record.name), { force: true });
    } catch {
      // ignore
    }
    return { stopped: true, name: record.name };
  }

  /** Stop every secondmate child owned by this registry (daemon shutdown). */
  stopAll(): void {
    for (const name of [...this.children.keys()]) {
      try {
        this.stop(name);
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
