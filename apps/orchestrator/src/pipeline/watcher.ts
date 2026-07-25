import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  OrchestratorEvent,
  PipelineFinding,
  PipelineRunSnapshot,
  PipelineStepSnapshot,
} from "@agent-os/protocol";

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

/** Every column tick() SELECTs — a missing one means the schema moved. */
const REQUIRED_RUN_COLUMNS = [
  "id",
  "branch",
  "status",
  "head_sha",
  "pr_url",
  "error",
  "intent",
  "updated_at",
] as const;
const REQUIRED_STEP_COLUMNS = [
  "run_id",
  "step_name",
  "step_order",
  "status",
  "findings_json",
  "log_path",
  "last_activity",
  "last_activity_at",
  "duration_ms",
  "agent_pid",
] as const;

/**
 * Honest transport labels for what this adapter actually does today.
 * `live` is reserved for a true push path (e.g. no-mistakes socket subscribe)
 * and is intentionally not used until that path exists.
 */
export type PipelineTransport = "wal-assisted" | "interval-only" | "unavailable";

export interface PipelineWatcherOptions {
  /** no-mistakes home; defaults to ~/.no-mistakes. */
  home?: string;
  /** Poll cadence for the structured read. */
  pollMs?: number;
  /** Emit events into the daemon's log. */
  sink: (event: OrchestratorEvent) => void;
  /**
   * Live knobs from the active observability profile. Read each tick so a
   * hot-reloaded profile is observed without restarting the watcher.
   */
  profile?: () => { streamPipelineLogs: boolean };
}

export interface PipelineCompatibility {
  ok: boolean;
  /** Human-readable reason when the schema could not be read. */
  reason: string | null;
  missingColumns: string[];
}

const MAX_STRUCTURED_READ_FAILURES = 3;
const LOG_CHUNK_MAX = 16_384;

export class PipelineWatcher {
  private readonly home: string;
  private pollMs: number;
  private readonly sink: (event: OrchestratorEvent) => void;
  private readonly profile: () => { streamPipelineLogs: boolean };
  private timer: ReturnType<typeof setInterval> | null = null;
  private walWatcher: FSWatcher | null = null;
  private transport: PipelineTransport = "unavailable";
  private walWatchAttached = false;
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
  private structuredReadFailures = 0;
  private started = false;

  constructor(options: PipelineWatcherOptions) {
    // Explicit option wins, then the env override (gates and fixtures point
    // this at a throwaway gate home so a test never reads — or is blamed for
    // touching — the Captain's real one), then the conventional location.
    const envHome = process.env.AGENTOS_NO_MISTAKES_HOME;
    this.home =
      options.home ?? (envHome !== undefined && envHome.length > 0 ? envHome : join(homedir(), ".no-mistakes"));
    this.pollMs = options.pollMs ?? 1000;
    this.sink = options.sink;
    this.profile = options.profile ?? (() => ({ streamPipelineLogs: true }));
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
   * Apply hot-reloaded knobs. Starts/stops watching and rebuilds the interval
   * when the poll cadence changes — no daemon restart required.
   */
  applyConfig(options: { watchPipeline: boolean; pollMs: number }): void {
    this.pollMs = options.pollMs;
    if (!options.watchPipeline) {
      const wasReading = this.started || this.transport !== "unavailable";
      this.stop();
      this.transport = "unavailable";
      // Drop any claim that prior snapshots are still current, and wake the
      // Console so it stops painting last-known rows under UNAVAILABLE.
      if (wasReading) {
        this.markUnavailable("pipeline watching is disabled");
      }
      return;
    }
    if (!this.started) {
      this.start();
      return;
    }
    // Already running — refresh interval cadence and re-attach WAL watch.
    this.restartTimer();
    this.attachWalWatch();
    this.transport = this.walWatchAttached ? "wal-assisted" : "interval-only";
  }

  /**
   * Start watching. The WAL file changes on every no-mistakes write, so an
   * fs watch on it turns a fixed poll into near-immediate reaction while the
   * interval remains as the floor for anything the watch misses.
   */
  start(): void {
    this.stop();
    this.started = true;
    // A (re)start must re-project current runs — fingerprints from a prior
    // session would suppress the frames the Console needs to leave unreadable.
    this.lastFingerprint.clear();
    this.incompatibilityReported = false;
    this.structuredReadFailures = 0;
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

    this.attachWalWatch();
    this.transport = this.walWatchAttached ? "wal-assisted" : "interval-only";
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.walWatcher !== null) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
    this.walWatchAttached = false;
  }

  private restartTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const cadence = this.compatibility.ok ? this.pollMs : Math.max(this.pollMs, 5000);
    this.timer = setInterval(() => this.tick(), cadence);
    this.timer.unref?.();
  }

  private attachWalWatch(): void {
    if (this.walWatcher !== null) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
    this.walWatchAttached = false;
    const wal = `${this.dbPath()}-wal`;
    if (!existsSync(wal)) return;
    try {
      this.walWatcher = watch(wal, () => this.tick());
      this.walWatchAttached = true;
    } catch {
      // fs.watch is best-effort on some platforms; the interval still covers us.
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

  /** Mark the view unreadable and emit once so nothing is shown as current. */
  private markUnavailable(reason: string, missingColumns: string[] = []): void {
    this.compatibility = {
      ok: false,
      reason,
      missingColumns,
    };
    this.transport = "unavailable";
    this.incompatibilityReported = false;
    this.reportIncompatibility();
  }

  private markStructuredReadFailed(error: unknown): void {
    this.structuredReadFailures += 1;
    if (this.structuredReadFailures < MAX_STRUCTURED_READ_FAILURES) return;
    this.markUnavailable(
      error instanceof Error
        ? `structured pipeline read failed repeatedly: ${error.message}`
        : "structured pipeline read failed repeatedly",
      this.compatibility.missingColumns,
    );
  }

  /** One structured read. Bounded, absorbing, and silent when nothing moved. */
  tick(): void {
    let db: Database.Database | null = null;
    try {
      if (!this.compatibility.ok) {
        const compat = this.checkCompatibility();
        if (!compat.ok) {
          this.transport = "unavailable";
          this.reportIncompatibility();
          return;
        }
        // Recovered — restore transport and force-emit current runs so the
        // Console observes a frame and leaves the unreadable banner.
        this.incompatibilityReported = false;
        this.structuredReadFailures = 0;
        this.lastFingerprint.clear();
        this.attachWalWatch();
        this.transport = this.walWatchAttached ? "wal-assisted" : "interval-only";
        this.restartTimer();
      }
      db = this.open();
      if (db === null) {
        // After a healthy period, a missing or unopenable DB must not leave
        // last-known rows serving under a quietly growing lag.
        this.markUnavailable(`no-mistakes state not found at ${this.dbPath()}`);
        return;
      }

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

      const streamLogs = this.profile().streamPipelineLogs;

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

        const steps: PipelineStepSnapshot[] = rows.map((row) => {
          const findings = parseFindings(row.findings_json);
          return {
            step: row.step_name,
            order: row.step_order,
            status: row.status,
            findingsCount: findings.length,
            findings,
            lastActivity: row.last_activity,
            lastActivityAt:
              row.last_activity_at === null ? null : new Date(row.last_activity_at).toISOString(),
            durationMs: row.duration_ms,
            agentPid: row.agent_pid,
          };
        });

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
        if (this.lastFingerprint.get(run.id) !== fingerprint) {
          this.lastFingerprint.set(run.id, fingerprint);
          this.sink({ type: "pipeline.run_updated", payload: snapshot });
        }

        // Pure log appends must stream even when structured columns are unchanged.
        if (streamLogs) {
          const active = rows.find((r) => r.status === "running" || r.status === "fixing");
          if (active?.log_path != null) this.emitLogTail(run.id, active.step_name, active.log_path);
        }
      }

      this.structuredReadFailures = 0;
      this.lastPollAt = Date.now();
      // A gate that was idle at first attach may not have a WAL yet. Re-try
      // while interval-only so the honesty label can upgrade to wal-assisted
      // once no-mistakes creates the file.
      if (!this.walWatchAttached) {
        this.attachWalWatch();
        if (this.walWatchAttached) {
          this.transport = "wal-assisted";
        } else if (this.transport !== "unavailable") {
          this.transport = "interval-only";
        }
      }
    } catch (error) {
      // A read failure must never take the daemon with it; repeated failures
      // mark compatibility failed so the UI cannot keep showing last-known rows.
      this.markStructuredReadFailed(error);
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
      const known = this.logOffsets.get(key);
      // First sight: seed to current size without emitting. Catch-up of prior
      // bytes belongs in the UI; replaying into the durable event log on every
      // daemon restart would bloat it monotonically.
      if (known === undefined) {
        this.logOffsets.set(key, size);
        return;
      }
      if (size <= known) {
        // Truncation or rotation — resync rather than emitting garbage.
        if (size < known) this.logOffsets.set(key, size);
        return;
      }
      const toRead = Math.min(LOG_CHUNK_MAX, size - known);
      const buffer = Buffer.alloc(toRead);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buffer, 0, toRead, known);
      } finally {
        closeSync(fd);
      }
      const chunk = buffer.toString("utf8");
      this.logOffsets.set(key, known + toRead);
      if (chunk.trim().length === 0) return;
      this.sink({
        type: "pipeline.log_appended",
        payload: { runId, step, chunk },
      });
    } catch {
      // Log tailing is best-effort; structured state is the source of truth.
    }
  }
}

/** Project findings_json into the decision table the Console renders. */
function parseFindings(raw: string | null): PipelineFinding[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { findings?: unknown[] }).findings)
        ? ((parsed as { findings: unknown[] }).findings)
        : [];
    const out: PipelineFinding[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (item === null || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === "string" && row.id.length > 0 ? row.id : `finding-${i + 1}`;
      const severity = typeof row.severity === "string" ? row.severity : "info";
      const action = typeof row.action === "string" ? row.action : "ask-user";
      const description =
        typeof row.description === "string"
          ? row.description
          : typeof row.message === "string"
            ? row.message
            : "";
      out.push({ id, severity, action, description });
    }
    return out;
  } catch {
    return [];
  }
}
