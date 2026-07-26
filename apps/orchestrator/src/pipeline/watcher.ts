import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
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
 * so the Console gets pipeline state through the SSE machinery it already has.
 * Run cards and availability are durable decisions; step log bytes are live-only
 * (the log FILE under the no-mistakes home is already the durable artifact).
 *
 * Four rules govern this, because we are reading another tool's private state:
 *
 *  1. STRICTLY READ-ONLY w.r.t. the no-mistakes home — both halves:
 *     (a) never write under it and never exec `axi run`/`respond`/`abort`;
 *     (b) never read paths that resolve outside it. "Read-only" is not a
 *         license to open arbitrary absolute paths from state.sqlite and
 *         republish their contents over SSE. Step log_path values are jailed
 *         under the configured home before open/stat/read.
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
  profile?: () => { streamPipelineLogs: boolean; pipelineLogChars: number };
}

export interface PipelineCompatibility {
  ok: boolean;
  /** Human-readable reason when the schema could not be read. */
  reason: string | null;
  missingColumns: string[];
}

/** Bounded attach-time seed for the Console (not durable event-log catch-up). */
export interface PipelineLogTail {
  runId: string;
  step: string;
  text: string;
  truncated: boolean;
  /** Inclusive start byte offset of `text` in the step log file. */
  startOffset: number;
  /** Exclusive end byte offset of `text` in the step log file. */
  endOffset: number;
}

export interface PipelineLogTailsResult {
  streamPipelineLogs: boolean;
  pipelineLogChars: number;
  tails: PipelineLogTail[];
  /** Active step logs refused because their path escapes the no-mistakes home. */
  refusals: PipelineLogPathRefusal[];
}

/** A step log_path that was refused rather than opened. */
export interface PipelineLogPathRefusal {
  runId: string;
  step: string;
  logPath: string;
  reason: string;
}

/** Per-step unread log growth that exceeded the per-tick drain bound. */
export interface PipelineLogBehind {
  runId: string;
  step: string;
  unreadBytes: number;
}

/**
 * Resolve `logPath` and require it stays under the no-mistakes home before any
 * open/stat/read. Both absolute and home-relative paths are accepted; symlink
 * escape is defeated with realpath when the path already exists.
 */
export function confineLogPath(
  home: string,
  logPath: string,
): { ok: true; path: string } | { ok: false; reason: string; path: string } {
  const homeResolved = resolve(home);
  let homeRoot = homeResolved;
  try {
    if (existsSync(homeResolved)) homeRoot = realpathSync(homeResolved);
  } catch {
    homeRoot = homeResolved;
  }
  const candidate = isAbsolute(logPath) ? resolve(logPath) : resolve(homeRoot, logPath);
  let resolved = candidate;
  try {
    if (existsSync(candidate)) resolved = realpathSync(candidate);
  } catch {
    resolved = candidate;
  }
  const prefix = homeRoot.endsWith(sep) ? homeRoot : `${homeRoot}${sep}`;
  if (resolved !== homeRoot && !resolved.startsWith(prefix)) {
    return {
      ok: false,
      path: resolved,
      reason: `log_path is outside the no-mistakes home (${homeRoot})`,
    };
  }
  return { ok: true, path: resolved };
}

const MAX_STRUCTURED_READ_FAILURES = 3;
/** Per-frame log slice size (bytes). */
export const PIPELINE_LOG_CHUNK_MAX = 16_384;
/** Max frames drained from one step log in a single tick. */
export const PIPELINE_LOG_DRAIN_MAX_CHUNKS = 8;
/** Cap total log bytes drained per step per tick. */
export const PIPELINE_LOG_DRAIN_MAX_BYTES =
  PIPELINE_LOG_CHUNK_MAX * PIPELINE_LOG_DRAIN_MAX_CHUNKS;
/** Floor between WAL-driven ticks so dense notifications cannot storm the loop. */
const WAL_TICK_COALESCE_MS = 75;
const SQLITE_BUSY_TIMEOUT_MS = 250;
/** Recency window for completed/failed runs (seconds — matches no-mistakes storage). */
const RECENT_RUN_WINDOW_SEC = 6 * 60 * 60;

/** Transient open/lock blips — only these get multi-strike grace. */
function isTransientSqliteError(error: unknown): boolean {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|unable to open database file/i.test(msg);
}

/**
 * no-mistakes stores unix epoch *seconds* in INTEGER timestamp columns.
 * Convert once at the SQLite boundary; never treat the raw column as ms.
 */
function secondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Bytes to skip at the front of a mid-file read so decoding starts on a
 * complete UTF-8 character (not a continuation byte from a prior code point).
 */
export function utf8LeadingSkip(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let i = 0;
  while (i < Math.min(3, buffer.length) && (buffer[i]! & 0xc0) === 0x80) {
    i += 1;
  }
  return i;
}

/**
 * Length of the longest prefix of `buffer` that ends on a complete UTF-8
 * character boundary. Returns 0 when the whole buffer is an incomplete
 * multi-byte sequence (caller should wait for more file bytes).
 */
export function utf8CompletePrefixLength(buffer: Buffer): number {
  const n = buffer.length;
  if (n === 0) return 0;
  // Last byte is ASCII → whole buffer ends cleanly (reads start on a boundary).
  if ((buffer[n - 1]! & 0x80) === 0) return n;

  let cont = 0;
  while (cont < 3 && n - 1 - cont >= 0 && (buffer[n - 1 - cont]! & 0xc0) === 0x80) {
    cont += 1;
  }
  const leadIdx = n - 1 - cont;
  if (leadIdx < 0) return 0;
  const lead = buffer[leadIdx]!;
  let expected: number;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else if ((lead & 0x80) === 0) return n;
  else {
    // Invalid lead — include it so the stream still advances.
    return n;
  }
  const actual = cont + 1;
  if (actual < expected) return leadIdx;
  return n;
}

/**
 * Read the last `maxChars` UTF-16 code units (JS string length) of a log file,
 * reporting the file byte range that produced them. Matches Console retention
 * (`String.prototype.slice`) so attach seed and live window agree on characters.
 *
 * Always honor `readSync`'s byte count: a size measured before the open can
 * overstate the file (truncate/rotate), and decoding the full pre-alloc buffer
 * would inject NULs and desync every subsequent offset merge.
 */
export function readLogTailByChars(
  logPath: string,
  size: number,
  maxChars: number,
): { text: string; startOffset: number; endOffset: number; truncated: boolean } {
  if (size <= 0 || maxChars <= 0) {
    return { text: "", startOffset: size, endOffset: size, truncated: false };
  }
  // Over-read: UTF-8 uses at most 4 bytes per Unicode code point.
  const maxBytes = Math.min(size, maxChars * 4);
  const readStart = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(maxBytes);
  let bytesRead = 0;
  const fd = openSync(logPath, "r");
  try {
    bytesRead = readSync(fd, buffer, 0, maxBytes, readStart);
  } finally {
    closeSync(fd);
  }
  if (bytesRead <= 0) {
    return {
      text: "",
      startOffset: readStart,
      endOffset: readStart,
      truncated: readStart > 0,
    };
  }
  const actual = buffer.subarray(0, bytesRead);
  const readEnd = readStart + bytesRead;
  const leadSkip = readStart === 0 ? 0 : utf8LeadingSkip(actual);
  const slice = actual.subarray(leadSkip);
  let text = slice.toString("utf8");
  let startOffset = readStart + leadSkip;
  if (text.length > maxChars) {
    const dropped = text.slice(0, text.length - maxChars);
    startOffset += Buffer.byteLength(dropped, "utf8");
    text = text.slice(-maxChars);
  }
  return {
    text,
    startOffset,
    endOffset: readEnd,
    truncated: startOffset > 0,
  };
}

type OpenResult =
  | { kind: "ok"; db: Database.Database }
  | { kind: "missing" }
  | { kind: "error"; error: unknown };

export class PipelineWatcher {
  private readonly home: string;
  private pollMs: number;
  private readonly sink: (event: OrchestratorEvent) => void;
  private readonly profile: () => { streamPipelineLogs: boolean; pipelineLogChars: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private walWatcher: FSWatcher | null = null;
  /** At most one WAL-scheduled tick is outstanding at a time. */
  private pendingWalTick: ReturnType<typeof setTimeout> | null = null;
  private transport: PipelineTransport = "unavailable";
  private walWatchAttached = false;
  private compatibility: PipelineCompatibility = {
    ok: false,
    reason: "not started",
    missingColumns: [],
  };
  /** runId → last emitted fingerprint, so unchanged state emits nothing. */
  private readonly lastFingerprint = new Map<string, string>();
  /**
   * SQL-visible runs from the last successful structured tick. The REST API
   * serves this map so durable event-store history cannot resurrect ghosts that
   * have left the gate or fallen outside the recency window.
   */
  private liveSnapshotsById = new Map<string, PipelineRunSnapshot>();
  /** Log tail offsets, so each poll emits only newly appended bytes. */
  private readonly logOffsets = new Map<string, number>();
  /**
   * Active-step log paths from the last successful tick (`runId:step` → path).
   * Powers attach-time catch-up without replaying into the durable event log.
   */
  private readonly stepLogPaths = new Map<string, string>();
  /**
   * Steps whose file growth exceeded the per-tick drain bound — unread bytes
   * remain after the last emitLogTail. Cleared when the stream catches up.
   */
  private readonly logBehind = new Map<string, number>();
  /**
   * Active-step log paths refused by the home jail (`runId:step` → refusal).
   * Surfaced on status so a misconfigured path is diagnosable, not a quiet pane.
   */
  private readonly logPathRefusals = new Map<string, PipelineLogPathRefusal>();
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
    this.profile =
      options.profile ?? (() => ({ streamPipelineLogs: true, pipelineLogChars: 20_000 }));
  }

  private dbPath(): string {
    return join(this.home, "state.sqlite");
  }

  /**
   * Open the state DB read-only. Never creates a file that is not there.
   * Distinguishes missing path from a transient open failure so a busy or
   * permission blip cannot be reported as "state not found".
   */
  private tryOpen(): OpenResult {
    const path = this.dbPath();
    if (!existsSync(path)) return { kind: "missing" };
    try {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      return { kind: "ok", db };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  /**
   * Probe the schema before trusting any read. This is what turns a silent
   * "no runs" into an honest "unreadable on this version".
   */
  checkCompatibility(): PipelineCompatibility {
    const opened = this.tryOpen();
    if (opened.kind === "missing") {
      this.compatibility = {
        ok: false,
        reason: `no-mistakes state not found at ${this.dbPath()}`,
        missingColumns: [],
      };
      return this.compatibility;
    }
    if (opened.kind === "error") {
      this.compatibility = {
        ok: false,
        reason:
          opened.error instanceof Error
            ? `could not open no-mistakes state at ${this.dbPath()}: ${opened.error.message}`
            : `could not open no-mistakes state at ${this.dbPath()}`,
        missingColumns: [],
      };
      return this.compatibility;
    }
    const db = opened.db;
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
    /** Active steps whose log stream is behind the on-disk file. */
    logBehind: PipelineLogBehind[];
    /** Active step logs refused because path escapes the no-mistakes home. */
    logPathIssues: PipelineLogPathRefusal[];
  } {
    const logBehind: PipelineLogBehind[] = [];
    for (const [key, unreadBytes] of this.logBehind) {
      if (unreadBytes <= 0) continue;
      const colon = key.indexOf(":");
      if (colon === -1) continue;
      logBehind.push({
        runId: key.slice(0, colon),
        step: key.slice(colon + 1),
        unreadBytes,
      });
    }
    return {
      transport: this.transport,
      compatibility: this.compatibility,
      lagMs: this.lastPollAt === null ? null : Date.now() - this.lastPollAt,
      home: this.home,
      logBehind,
      logPathIssues: [...this.logPathRefusals.values()],
    };
  }

  /**
   * Current SQL-visible run cards from the last successful tick. Empty when the
   * view is unreadable or watching is disabled — never historical event-store
   * frames the gate no longer considers live.
   */
  liveSnapshots(): PipelineRunSnapshot[] {
    if (!this.compatibility.ok || this.transport === "unavailable") return [];
    return [...this.liveSnapshotsById.values()];
  }

  /**
   * Bounded tail of each currently active step log for Console attach-time
   * catch-up. Pure read — does not advance streaming logOffsets, so the SSE
   * path continues from its prior position. Overlap with live frames is
   * resolved by byte offset on the client.
   *
   * Under quiet (`streamPipelineLogs: false`) returns no tails so catch-up
   * cannot bypass the profile's deliberate log suppression.
   */
  activeLogTails(): PipelineLogTailsResult {
    const { streamPipelineLogs, pipelineLogChars } = this.profile();
    if (!streamPipelineLogs || pipelineLogChars <= 0) {
      return { streamPipelineLogs, pipelineLogChars, tails: [], refusals: [] };
    }
    if (!this.compatibility.ok || this.transport === "unavailable") {
      return { streamPipelineLogs, pipelineLogChars, tails: [], refusals: [] };
    }
    const tails: PipelineLogTail[] = [];
    const refusals: PipelineLogPathRefusal[] = [];
    for (const [key, logPath] of this.stepLogPaths) {
      const colon = key.indexOf(":");
      if (colon === -1) continue;
      const runId = key.slice(0, colon);
      const step = key.slice(colon + 1);
      if (!this.liveSnapshotsById.has(runId)) continue;
      const confined = confineLogPath(this.home, logPath);
      if (!confined.ok) {
        const refusal: PipelineLogPathRefusal = {
          runId,
          step,
          logPath: confined.path,
          reason: confined.reason,
        };
        refusals.push(refusal);
        this.logPathRefusals.set(key, refusal);
        continue;
      }
      this.logPathRefusals.delete(key);
      try {
        if (!existsSync(confined.path)) continue;
        const size = statSync(confined.path).size;
        const { text, startOffset, endOffset, truncated } = readLogTailByChars(
          confined.path,
          size,
          pipelineLogChars,
        );
        tails.push({
          runId,
          step,
          text,
          truncated,
          startOffset,
          endOffset,
        });
      } catch {
        // Best-effort; structured cards remain the source of truth.
      }
    }
    return { streamPipelineLogs, pipelineLogChars, tails, refusals };
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
    // Already running — refresh interval cadence and re-validate WAL assist.
    this.restartTimer();
    this.refreshWalAssist();
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
    // Drop the previous SQL-visible set until the first successful tick rebuilds
    // it; otherwise a re-attach could briefly serve cards the gate no longer has.
    this.liveSnapshotsById = new Map();
    // Drop prior log offsets so the next first-sight re-seeds to current size
    // instead of replaying every byte written while the watcher was stopped.
    this.logOffsets.clear();
    this.logBehind.clear();
    this.logPathRefusals.clear();
    this.stepLogPaths.clear();
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

    this.refreshWalAssist();
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
    this.clearPendingWalTick();
    this.detachWalWatch();
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

  private clearPendingWalTick(): void {
    if (this.pendingWalTick !== null) {
      clearTimeout(this.pendingWalTick);
      this.pendingWalTick = null;
    }
  }

  /**
   * Coalesce dense WAL notifications to at most one pending structured read.
   * The interval remains the miss floor; this only limits how often fs.watch
   * can force a full open+SELECT cycle under active gate work.
   */
  private scheduleWalTick(): void {
    if (this.pendingWalTick !== null) return;
    this.pendingWalTick = setTimeout(() => {
      this.pendingWalTick = null;
      this.tick();
    }, WAL_TICK_COALESCE_MS);
    this.pendingWalTick.unref?.();
  }

  private detachWalWatch(): void {
    if (this.walWatcher !== null) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
    this.walWatchAttached = false;
  }

  /**
   * Re-validate WAL presence and watch health every tick. Transport is an
   * observation, not a high-water mark — demote the moment the assist is gone.
   */
  private refreshWalAssist(): void {
    if (!this.compatibility.ok) {
      this.detachWalWatch();
      if (this.transport !== "unavailable") this.transport = "unavailable";
      return;
    }
    const wal = `${this.dbPath()}-wal`;
    const walPresent = existsSync(wal);
    if (!walPresent) {
      this.detachWalWatch();
      this.transport = "interval-only";
      return;
    }
    if (this.walWatchAttached && this.walWatcher !== null) {
      this.transport = "wal-assisted";
      return;
    }
    this.detachWalWatch();
    try {
      this.walWatcher = watch(wal, () => this.scheduleWalTick());
      this.walWatcher.on("error", () => {
        // Watch died mid-session — demote immediately; the next tick will
        // re-probe. Interval remains the floor.
        this.detachWalWatch();
        if (this.compatibility.ok && this.transport !== "unavailable") {
          this.transport = "interval-only";
        }
      });
      this.walWatchAttached = true;
      this.transport = "wal-assisted";
    } catch {
      // fs.watch is best-effort on some platforms; the interval still covers us.
      this.detachWalWatch();
      this.transport = "interval-only";
    }
  }

  private reportIncompatibility(): void {
    if (this.incompatibilityReported) return;
    // Sink-first: only mark reported AFTER the durable event lands. Same
    // pattern as run fingerprints and log offsets — never set progress before
    // the sink returns, or a throw leaves the Console without a retryable signal.
    try {
      this.sink({
        type: "pipeline.unavailable",
        payload: {
          reason: this.compatibility.reason ?? "no-mistakes state unreadable",
          missingColumns: this.compatibility.missingColumns,
          home: this.home,
        },
      });
      this.incompatibilityReported = true;
    } catch {
      // Leave unflagged so the next tick retries.
    }
  }

  /** Mark the view unreadable and emit once so nothing is shown as current. */
  private markUnavailable(reason: string, missingColumns: string[] = []): void {
    this.compatibility = {
      ok: false,
      reason,
      missingColumns,
    };
    this.transport = "unavailable";
    this.liveSnapshotsById = new Map();
    this.stepLogPaths.clear();
    this.detachWalWatch();
    this.incompatibilityReported = false;
    this.reportIncompatibility();
  }

  /**
   * Structured-read failures: schema/SQL drift blanks the view on the first
   * hit; only transient busy/open blips share multi-strike grace.
   */
  private markStructuredReadFailed(error: unknown): void {
    // Busy/open first — do not let a transient open failure poison
    // checkCompatibility into an immediate unreadable banner.
    if (isTransientSqliteError(error)) {
      this.structuredReadFailures += 1;
      if (this.structuredReadFailures < MAX_STRUCTURED_READ_FAILURES) return;
      this.markUnavailable(
        error instanceof Error
          ? `structured pipeline read failed repeatedly: ${error.message}`
          : "structured pipeline read failed repeatedly",
        this.compatibility.missingColumns,
      );
      return;
    }
    // Non-transient (e.g. no such column): re-probe so the reason names the
    // missing columns when possible, then blank on the first strike.
    const compat = this.checkCompatibility();
    if (!compat.ok) {
      this.markUnavailable(
        compat.reason ??
          (error instanceof Error
            ? `structured pipeline read failed: ${error.message}`
            : "structured pipeline read failed"),
        compat.missingColumns,
      );
      return;
    }
    this.markUnavailable(
      error instanceof Error
        ? `structured pipeline read failed: ${error.message}`
        : "structured pipeline read failed",
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
        this.refreshWalAssist();
        this.restartTimer();
      }
      const opened = this.tryOpen();
      if (opened.kind === "missing") {
        // File truly gone — blank the view. Open blips use the 3-strike path.
        this.markUnavailable(`no-mistakes state not found at ${this.dbPath()}`);
        return;
      }
      if (opened.kind === "error") {
        this.markStructuredReadFailed(opened.error);
        return;
      }
      db = opened.db;

      // updated_at is unix seconds (real no-mistakes schema), not ms.
      const runs = db
        .prepare(
          `SELECT id, branch, status, head_sha, pr_url, error, intent, updated_at
             FROM runs
            WHERE status IN ('running', 'pending')
               OR updated_at > ?
            ORDER BY updated_at DESC
            LIMIT 20`,
        )
        .all(nowUnixSeconds() - RECENT_RUN_WINDOW_SEC) as Array<{
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
      const nextLive = new Map<string, PipelineRunSnapshot>();
      const nextLogPaths = new Map<string, string>();

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
              row.last_activity_at === null ? null : secondsToIso(row.last_activity_at),
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
          updatedAt: secondsToIso(run.updated_at),
        };
        nextLive.set(run.id, snapshot);

        // Emit only on genuine change — a per-tick event for unchanged state
        // would bury the transitions that matter under its own noise.
        const fingerprint = JSON.stringify(snapshot);
        if (this.lastFingerprint.get(run.id) !== fingerprint) {
          try {
            this.sink({ type: "pipeline.run_updated", payload: snapshot });
            this.lastFingerprint.set(run.id, fingerprint);
          } catch {
            // Retry this frame on the next tick.
          }
        }

        // Always advance log offsets on the active step; streamPipelineLogs
        // only gates emission so a quiet→working flip does not re-seed and
        // swallow bytes appended while quiet.
        const active = rows.find((r) => r.status === "running" || r.status === "fixing");
        if (active?.log_path != null) {
          nextLogPaths.set(`${run.id}:${active.step_name}`, active.log_path);
          this.emitLogTail(run.id, active.step_name, active.log_path, streamLogs);
        }
      }

      // Drop runs that left the SQL-visible set (terminal + outside recency,
      // deleted, or aged out). Fingerprints for dropped ids would otherwise
      // suppress a re-appearance after a long gap.
      for (const id of this.lastFingerprint.keys()) {
        if (!nextLive.has(id)) this.lastFingerprint.delete(id);
      }
      for (const key of [...this.logOffsets.keys()]) {
        const colon = key.indexOf(":");
        const runId = colon === -1 ? key : key.slice(0, colon);
        if (!nextLive.has(runId)) {
          this.logOffsets.delete(key);
          this.logBehind.delete(key);
          this.logPathRefusals.delete(key);
        }
      }
      for (const key of [...this.logBehind.keys()]) {
        if (!nextLogPaths.has(key)) this.logBehind.delete(key);
      }
      for (const key of [...this.logPathRefusals.keys()]) {
        if (!nextLogPaths.has(key)) this.logPathRefusals.delete(key);
      }
      this.liveSnapshotsById = nextLive;
      this.stepLogPaths.clear();
      for (const [key, path] of nextLogPaths) this.stepLogPaths.set(key, path);

      this.structuredReadFailures = 0;
      this.lastPollAt = Date.now();
      // Re-validate WAL assist every successful tick: promote when the file
      // appears, demote when it is checkpointed away or the watch dies.
      this.refreshWalAssist();
    } catch (error) {
      // A read failure must never take the daemon with it; schema drift blanks
      // the view immediately, transient busy/open uses multi-strike grace.
      this.markStructuredReadFailed(error);
    } finally {
      db?.close();
    }
  }

  /**
   * Track the active step log offset every tick. When `emit` is false (quiet
   * profile), jump the offset to EOF in one step so a later profile flip cannot
   * replay residual quiet-period bytes. When emitting, drain in a bounded loop
   * (multiple chunks / bytes per tick), sink-before-offset each frame, and
   * record logBehind when unread growth still exceeds the per-tick bound.
   *
   * pipeline.log_appended is live-only (daemon routes it to emitLive); first-sight
   * bytes never emit — attach catch-up is activeLogTails().
   */
  private emitLogTail(runId: string, step: string, logPath: string, emit: boolean): void {
    const key = `${runId}:${step}`;
    try {
      const confined = confineLogPath(this.home, logPath);
      if (!confined.ok) {
        this.logPathRefusals.set(key, {
          runId,
          step,
          logPath: confined.path,
          reason: confined.reason,
        });
        this.logBehind.delete(key);
        return;
      }
      this.logPathRefusals.delete(key);
      const safePath = confined.path;
      if (!existsSync(safePath)) return;
      const size = statSync(safePath).size;
      const known = this.logOffsets.get(key);
      // First sight: seed to current size without emitting. Prior bytes are
      // served on Console attach via activeLogTails() (bounded by
      // pipelineLogChars). Live frames only cover post-sight growth.
      if (known === undefined) {
        this.logOffsets.set(key, size);
        this.logBehind.delete(key);
        return;
      }
      if (size <= known) {
        // Truncation or rotation — resync rather than emitting garbage.
        if (size < known) this.logOffsets.set(key, size);
        this.logBehind.delete(key);
        return;
      }
      // Non-streaming: snap to EOF immediately. Chunked catch-up here would leave
      // a residual unread region after multi-chunk growth that a later
      // firehose/working flip would dump onto the live path as a burst.
      if (!emit) {
        this.logOffsets.set(key, size);
        this.logBehind.delete(key);
        return;
      }

      let offset = known;
      let drained = 0;
      let chunks = 0;
      const fd = openSync(safePath, "r");
      try {
        while (
          offset < size &&
          chunks < PIPELINE_LOG_DRAIN_MAX_CHUNKS &&
          drained < PIPELINE_LOG_DRAIN_MAX_BYTES
        ) {
          const toRead = Math.min(
            PIPELINE_LOG_CHUNK_MAX,
            size - offset,
            PIPELINE_LOG_DRAIN_MAX_BYTES - drained,
          );
          if (toRead <= 0) break;
          const buffer = Buffer.alloc(toRead);
          const bytesRead = readSync(fd, buffer, 0, toRead, offset);
          if (bytesRead <= 0) break;
          const raw = buffer.subarray(0, bytesRead);
          // Keep multi-byte sequences intact: emit only a complete UTF-8 prefix
          // and leave a trailing partial sequence for the next read.
          const emitBytes = utf8CompletePrefixLength(raw);
          if (emitBytes <= 0) {
            // Incomplete multi-byte only — wait for more file bytes next tick.
            break;
          }
          const chunk = raw.subarray(0, emitBytes).toString("utf8");
          const endOffset = offset + emitBytes;
          // Sink before advancing: if fan-out fails, the next tick retries these bytes.
          // Whitespace-only chunks (\\n, \\r redraws) are real terminal output — emit them.
          this.sink({
            type: "pipeline.log_appended",
            payload: { runId, step, chunk, offset, endOffset },
          });
          offset = endOffset;
          drained += emitBytes;
          chunks += 1;
          this.logOffsets.set(key, offset);
        }
      } finally {
        closeSync(fd);
      }

      const unread = size - offset;
      if (unread > 0) {
        this.logBehind.set(key, unread);
      } else {
        this.logBehind.delete(key);
      }
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
