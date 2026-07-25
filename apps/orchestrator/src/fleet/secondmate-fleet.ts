import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import type { OrchestratorEvent, SecondmateBearings, SecondmateCharter } from "@agent-os/protocol";
import { secondmateCharterSchema } from "@agent-os/protocol";
import type { SecondmateRecord, SecondmateRegistry } from "./secondmates.js";

/**
 * Secondmate fleet operations (master plan §5.9, §11 Phase 7).
 *
 * A secondmate is a second Agent OS daemon on its own home and port, with its
 * own Brain, sharing exactly one thing with the primary: the Captain's Pi auth
 * store. Everything else — tasks, worktrees, event log, config — is separate.
 *
 * Three properties this module is responsible for:
 *   - the charter is CONFIG, so changing a secondmate's Brain or routing domains
 *     is a file edit that syncs, not a code change;
 *   - routing is by domain, and a task routed to a secondmate leaves the
 *     primary's fleet rather than being duplicated in both;
 *   - `/bearings` reports what each secondmate actually says about itself,
 *     including "unreachable", never a cached guess.
 */

export type SecondmateEventSink = (event: OrchestratorEvent) => void;

/** How long a bearings probe waits before calling a secondmate unreachable. */
const BEARINGS_TIMEOUT_MS = 5_000;

export class SecondmateFleet {
  private sink: SecondmateEventSink = () => undefined;

  constructor(private readonly registry: SecondmateRegistry) {}

  onEvent(sink: SecondmateEventSink): void {
    this.sink = sink;
  }

  private charterPath(record: SecondmateRecord): string {
    return join(record.home, "config", "charter.json5");
  }

  /**
   * Read a secondmate's charter from its own config layer. Missing or invalid
   * charters fall back to the provisioning record rather than throwing — a
   * malformed charter must not make the secondmate invisible to `/bearings`.
   */
  readCharter(record: SecondmateRecord): {
    charter: SecondmateCharter;
    source: "charter-file" | "provision-record";
    error: string | null;
  } {
    const path = this.charterPath(record);
    if (existsSync(path)) {
      try {
        const parsed = secondmateCharterSchema.parse(JSON5.parse(readFileSync(path, "utf8")));
        return { charter: parsed, source: "charter-file", error: null };
      } catch (error) {
        return {
          charter: this.charterFromRecord(record),
          source: "provision-record",
          error: error instanceof Error ? error.message : "invalid charter",
        };
      }
    }
    return { charter: this.charterFromRecord(record), source: "provision-record", error: null };
  }

  private charterFromRecord(record: SecondmateRecord): SecondmateCharter {
    return {
      name: record.name,
      domains: record.domain.length > 0 ? [record.domain] : [],
      brainModel: record.brainModel,
      maxConcurrentTasks: 2,
      acceptsRouting: true,
    };
  }

  /** Write a charter into the secondmate's own config layer (files are truth). */
  writeCharter(record: SecondmateRecord, charter: SecondmateCharter): void {
    const validated = secondmateCharterSchema.parse(charter);
    const dir = join(record.home, "config");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.charterPath(record),
      `// charter.json5 — secondmate ${record.name} (master plan §5.9)\n${JSON.stringify(validated, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.sink({
      type: "secondmate.charter_changed",
      payload: {
        name: record.name,
        brainModel: validated.brainModel,
        domains: validated.domains,
      },
    });
  }

  /**
   * Choose a secondmate for a domain. Returns null when none accepts it — the
   * caller must then keep the task on the primary rather than inventing a
   * destination.
   */
  routeFor(domain: string): SecondmateRecord | null {
    for (const record of this.registry.list()) {
      const { charter } = this.readCharter(record);
      if (!charter.acceptsRouting) continue;
      if (charter.domains.includes(domain)) return record;
    }
    return null;
  }

  /**
   * Ask every secondmate for its own status. A secondmate that does not answer
   * within the timeout is reported unreachable — never filled in from the last
   * known value, because a stale "healthy" is the one answer that matters.
   */
  async bearings(): Promise<SecondmateBearings[]> {
    const records = this.registry.list();
    return Promise.all(records.map((record) => this.bearingsFor(record)));
  }

  private async bearingsFor(record: SecondmateRecord): Promise<SecondmateBearings> {
    const { charter, source, error } = this.readCharter(record);
    const base = {
      name: record.name,
      home: record.home,
      port: record.port,
      domains: charter.domains,
      brainModel: charter.brainModel,
      charterSource: source,
      charterError: error,
    };
    const token = this.readToken(record);
    if (token === null) {
      return {
        ...base,
        reachable: false,
        reason: "no daemon token — secondmate has never started",
        active: null,
        queued: null,
        brainStatus: null,
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BEARINGS_TIMEOUT_MS);
      const response = await fetch(`http://127.0.0.1:${record.port}/v1/fleet`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        return {
          ...base,
          reachable: false,
          reason: `daemon responded ${response.status}`,
          active: null,
          queued: null,
          brainStatus: null,
        };
      }
      const body = (await response.json()) as {
        summary: { active: number; queued: number; brain: { status: string } };
      };
      return {
        ...base,
        reachable: true,
        reason: null,
        active: body.summary.active,
        queued: body.summary.queued,
        brainStatus: body.summary.brain.status,
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        reason: error instanceof Error ? error.message : "unreachable",
        active: null,
        queued: null,
        brainStatus: null,
      };
    }
  }

  private readToken(record: SecondmateRecord): string | null {
    const path = join(record.home, "daemon.token");
    if (!existsSync(path)) return null;
    try {
      const token = readFileSync(path, "utf8").trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
}
