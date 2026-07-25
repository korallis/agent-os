import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorEvent } from "@agent-os/protocol";

/**
 * Secondmates registry (Phase 7 / v1.x — master plan §5.9).
 * Isolated homes under ~/.agentos/secondmates/<name>/ — no auth material.
 * Full routing + auth-broker serialization lands with Phase 7 gates.
 */

export interface SecondmateRecord {
  name: string;
  home: string;
  port: number;
  domain: string;
  brainModel: string | null;
  createdAt: string;
}

export type SecondmateEventSink = (event: OrchestratorEvent) => void;

export class SecondmateRegistry {
  private readonly root: string;
  private sink: SecondmateEventSink = () => undefined;

  constructor(agentosHome: string) {
    this.root = join(agentosHome, "secondmates");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
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
    // Explicitly no auth/ or secrets/ directories — broker grants only.
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
    // Event reserved for Phase 7 full protocol; use captain.escalation as notice for now.
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

  /** Fs-scan: no auth.json / credentials under secondmate homes. */
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
