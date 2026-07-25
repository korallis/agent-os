import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { OrchestratorEvent, PipelineRunSnapshot, PipelineStepSnapshot } from "@agent-os/protocol";

/**
 * Live view of the `no-mistakes` gate (master plan §11 Phase 9, [R7]).
 *
 * When work enters no-mistakes, Agent OS has until now gone blind — the only
 * way to know what was happening was to poll `axi status`. This watcher closes
 * that gap by translating no-mistakes' own state into typed `pipeline.*` events
 * on Agent OS's append-only log, so the Console gets pipeline state through the
 * SSE + projection machinery it already has. One event log, one stream.
 *
 * Four rules govern this, because we are reading another tool's private state:
 *
 *  1. STRICTLY READ-ONLY. The watcher never writes under the no-mistakes home
 *     and never execs `axi run`/`respond`/`abort`. Driving the pipeline stays
 *     an explicit act by the Captain or the Brain, never a side effect of
 *     watching it.
 *  2. The transport in use is REPORTED AS FACT. A "live" view that is silently
 *     seconds behind misleads exactly the way a `$0.00` cost estimate would.
 *  3. Version drift is expected, not exceptional. no-mistakes is a separate
 *     product on its own release train; an unrecognised schema DEGRADES
 *     VISIBLY rather than rendering stale rows as current.
 *  4. It must never wedge the daemon. All reads are bounded and failures are
 *     absorbed into a reported status, never thrown into the event loop.
 */

/** Columns this watcher depends on. A missing one means the schema moved. */
const REQUIRED_RUN_COLUMNS = ["id", "branch", "status", "head_sha", "updated_at"] as const;
const REQUIRED_STEP_COLUMNS = [
  "run_id",
  "step_name",
  "step_order",
  "status",
  "findings_json",
  "log_path",
  "last_activity",
] as const;

export type PipelineTransport = "live" | "polled" | "unavailable";

export interface PipelineWatcherOptions {
  /** no-mistakes home; defaults to ~/.no-mistakes. */
  home?: string;
  /** Poll cadence for the structured read. */
  pollMs?: number;
  /** Emit events into the daemon's log. */
  sink: (event: OrchestratorEvent) => void;
}

export interface PipelineCompatibility {
  ok: boolean;
  /** Human-readable reason when the schema could not be read. */
  reason: string | null;
  missingColumns: string[];
}

export class PipelineWatcher {
  private readonly home: string;
  private readonly pollMs: number;
  private readonly sink: (event: OrchestratorEvent) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private walWatcher: FSWatcher | null = null;
  private transport: PipelineTransport = "unavailable";
  private compatibility: PipelineCompatibility = {
    ok: false,
    reason: "not started",
    missingColumns: [],
  };
  /** runId → last emitted fingerprint, so unchanged state emits nothing. */
  private readonly lastFingerprint = new Map<string, string>();
  /** Log tail offsets, so each poll emits only newly appended bytes. */
  private readonly logOffsets = new Map<string, number>();
  private lastPollAt: number | null = null;
  /** Emitted once per incompatibility, not once per tick. */
  private incompatibilityReported = false;

  constructor(options: PipelineWatcherOptions) {
    // Explicit option wins, then the env override (gates and fixtures point
    // this at a throwaway gate home so a test never reads — or is blamed for
    // touching — the Captain's real one), then the conventional location.
    const envHome = process.env.AGENTOS_NO_MISTAKES_HOME;
    this.home =
      options.home ?? (envHome !== undefined && envHome.length > 0 ? envHome : join(homedir(), ".no-mistakes"));
    this.pollMs = options.pollMs ?? 1000;
    this.sink = options.sink;
  }

  private dbPath(): string {
    return join(this.home, "state.sqlite");
  }

  /** Open the state DB read-only. Never creates a file that is not there. */
  private open(): Database.Database | null {
    const path = this.dbPath();
    if (!existsSync(path)) return null;
    try {
      return new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
  }

  /**
   * Probe the schema before trusting any read. This is what turns a silent
   * "no runs" into an honest "unreadable on this version".
   */
  checkCompatibility(): PipelineCompatibility {
    const db = this.open();
    if (db === null) {
      this.compatibility = {
        ok: false,
        reason: `no-mistakes state not found at ${this.dbPath()}`,
        missingColumns: [],
      };
      return this.compatibility;
    }
    try {
      const runCols = new Set(
        (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      const stepCols = new Set(
        (db.prepare("PRAGMA table_info(step_results)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      const missing = [
        ...REQUIRED_RUN_COLUMNS.filter((c) => !runCols.has(c)).map((c) => `runs.${c}`),
        ...REQUIRED_STEP_COLUMNS.filter((c) => !stepCols.has(c)).map((c) => `step_results.${c}`),
      ];
      this.compatibility = {
        ok: missing.length === 0,
        reason:
          missing.length === 0
            ? null
            : `no-mistakes state schema is not readable by this build — missing ${missing.join(", ")}`,
        missingColumns: missing,
      };
    } catch (error) {
      this.compatibility = {
        ok: false,
        reason: error instanceof Error ? error.message : "schema probe failed",
        missingColumns: [],
      };
    } finally {
      db.close();
    }
    return this.compatibility;
  }

  status(): {
    transport: PipelineTransport;
    compatibility: PipelineCompatibility;
    /** ms since the last successful structured read; null when never read. */
    lagMs: number | null;
    home: string;
  } {
    return {
      transport: this.transport,
      compatibility: this.compatibility,
      lagMs: this.lastPollAt === null ? null : Date.now() - this.lastPollAt,
      home: this.home,
    };
  }

  /**
   * Start watching. The WAL file changes on every no-mistakes write, so an
   * fs watch on it turns a fixed poll into near-immediate reaction while the
   * interval remains as the floor for anything the watch misses.
   */
  start(): void {
    this.stop();
    const compat = this.checkCompatibility();
    if (!compat.ok) {
      this.transport = "unavailable";
      this.reportIncompatibility();
      // Keep the timer: no-mistakes may be installed or upgraded later, and a
      // watcher that gives up permanently would need a daemon restart to see it.
      this.timer = setInterval(() => this.tick(), Math.max(this.pollMs, 5000));
      this.timer.unref?.();
      return;
    }

    this.transport = "polled";
    const wal = `${this.dbPath()}-wal`;
    if (existsSync(wal)) {
      try {
        this.walWatcher = watch(wal, () => this.tick());
      } catch {
        // fs.watch is best-effort on some platforms; the interval still covers us.
      }
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.walWatcher !== null) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
  }

  private reportIncompatibility(): void {
    if (this.incompatibilityReported) return;
    this.incompatibilityReported = true;
    this.sink({
      type: "pipeline.unavailable",
      payload: {
        reason: this.compatibility.reason ?? "no-mistakes state unreadable",
        missingColumns: this.compatibility.missingColumns,
        home: this.home,
      },
    });
  }

  /** One structured read. Bounded, absorbing, and silent when nothing moved. */
  tick(): void {
    let db: Database.Database | null = null;
    try {
      if (!this.compatibility.ok) {
        const compat = this.checkCompatibility();
        if (!compat.ok) {
          this.reportIncompatibility();
          return;
        }
        // Recovered — a later no-mistakes version restored what we need.
        this.incompatibilityReported = false;
        this.transport = "polled";
      }
      db = this.open();
      if (db === null) return;

      const runs = db
        .prepare(
          `SELECT id, branch, status, head_sha, pr_url, error, intent, updated_at
             FROM runs
            WHERE status IN ('running', 'pending')
               OR updated_at > ?
            ORDER BY updated_at DESC
            LIMIT 20`,
        )
        .all(Date.now() - 6 * 60 * 60 * 1000) as Array<{
        id: string;
        branch: string;
        status: string;
        head_sha: string;
        pr_url: string | null;
        error: string | null;
        intent: string | null;
        updated_at: number;
      }>;

      const stepStmt = db.prepare(
        `SELECT step_name, step_order, status, findings_json, log_path, last_activity,
                last_activity_at, duration_ms, agent_pid
           FROM step_results
          WHERE run_id = ?
          ORDER BY step_order`,
      );

      for (const run of runs) {
        const rows = stepStmt.all(run.id) as Array<{
          step_name: string;
          step_order: number;
          status: string;
          findings_json: string | null;
          log_path: string | null;
          last_activity: string | null;
          last_activity_at: number | null;
          duration_ms: number | null;
          agent_pid: number | null;
        }>;

        const steps: PipelineStepSnapshot[] = rows.map((row) => ({
          step: row.step_name,
          order: row.step_order,
          status: row.status,
          findingsCount: countFindings(row.findings_json),
          lastActivity: row.last_activity,
          lastActivityAt:
            row.last_activity_at === null ? null : new Date(row.last_activity_at).toISOString(),
          durationMs: row.duration_ms,
          agentPid: row.agent_pid,
        }));

        const snapshot: PipelineRunSnapshot = {
          runId: run.id,
          branch: run.branch,
          status: run.status,
          headSha: run.head_sha,
          prUrl: run.pr_url,
          error: run.error,
          intent: run.intent,
          steps,
          updatedAt: new Date(run.updated_at).toISOString(),
        };

        // Emit only on genuine change — a per-tick event for unchanged state
        // would bury the transitions that matter under its own noise.
        const fingerprint = JSON.stringify(snapshot);
        if (this.lastFingerprint.get(run.id) === fingerprint) continue;
        this.lastFingerprint.set(run.id, fingerprint);
        this.sink({ type: "pipeline.run_updated", payload: snapshot });

        // Stream newly appended log bytes for the active step.
        const active = rows.find((r) => r.status === "running" || r.status === "fixing");
        if (active?.log_path != null) this.emitLogTail(run.id, active.step_name, active.log_path);
      }

      this.lastPollAt = Date.now();
    } catch {
      // A read failure must never take the daemon with it; the next tick retries
      // and `status()` continues to report the last successful read time.
    } finally {
      db?.close();
    }
  }

  /** Emit only the bytes appended since the last read of this step's log. */
  private emitLogTail(runId: string, step: string, logPath: string): void {
    try {
      if (!existsSync(logPath)) return;
      const size = statSync(logPath).size;
      const key = `${runId}:${step}`;
      const previous = this.logOffsets.get(key) ?? Math.max(0, size - 4096);
      if (size <= previous) {
        // Truncation or rotation — resync rather than emitting garbage.
        if (size < previous) this.logOffsets.set(key, size);
        return;
      }
      const buffer = readFileSync(logPath);
      const chunk = buffer.subarray(previous, Math.min(size, previous + 16_384)).toString("utf8");
      this.logOffsets.set(key, Math.min(size, previous + 16_384));
      if (chunk.trim().length === 0) return;
      this.sink({
        type: "pipeline.log_appended",
        payload: { runId, step, chunk: chunk.slice(0, 16_384) },
      });
    } catch {
      // Log tailing is best-effort; structured state is the source of truth.
    }
  }
}

/** Findings are stored as a JSON blob; count defensively. */
function countFindings(raw: string | null): number {
  if (raw === null || raw.length === 0) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown[] }).findings)) {
      return ((parsed as { findings: unknown[] }).findings).length;
    }
    return 0;
  } catch {
    return 0;
  }
}
