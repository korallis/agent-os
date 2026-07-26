import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EventStore } from "@agent-os/event-store";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { observabilityConfigSchema, type OrchestratorEvent } from "@agent-os/protocol";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR, startDaemon } from "../src/daemon.js";
import {
  PIPELINE_LOG_CHUNK_MAX,
  PIPELINE_LOG_DRAIN_MAX_BYTES,
  PIPELINE_LOG_DRAIN_MAX_CHUNKS,
  PipelineWatcher,
  readLogTailByChars,
} from "../src/pipeline/watcher.js";
import { buildServer } from "../src/server/app.js";
import {
  eventMatchesSurface,
  eventMatchesWakeOn,
  resolveActiveProfile,
  wakeClassForEvent,
} from "../src/observability/profile.js";
import { pruneAppliedLogIds } from "../../console/src/lib/pipelineLogState.ts";

/** Real no-mistakes stores unix epoch seconds — fixtures must match or unit bugs pass. */
function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildGate(dir: string): Database.Database {
  mkdirSync(join(dir, "logs"), { recursive: true });
  const db = new Database(join(dir, "state.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT NOT NULL, head_sha TEXT NOT NULL,
      base_sha TEXT, status TEXT NOT NULL DEFAULT 'pending', pr_url TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, intent TEXT
    );
    CREATE TABLE step_results (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      exit_code INTEGER, duration_ms INTEGER, log_path TEXT, findings_json TEXT,
      error TEXT, started_at INTEGER, completed_at INTEGER,
      last_activity_at INTEGER, last_activity TEXT, agent_pid INTEGER, auto_fix_limit INTEGER
    );
  `);
  return db;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0, homes.length)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("observability profile matching", () => {
  it("treats * as wildcard and other entries as prefixes", () => {
    expect(eventMatchesSurface("pipeline.log_appended", ["pipeline."])).toBe(true);
    expect(eventMatchesSurface("pipeline.log_appended", ["pipeline.unavailable"])).toBe(false);
    expect(eventMatchesSurface("task.created", ["task.", "captain."])).toBe(true);
    expect(eventMatchesSurface("brain.handoff", ["brain.down"])).toBe(false);
    expect(eventMatchesSurface("anything", ["*"])).toBe(true);
    expect(eventMatchesWakeOn("captain.escalation", ["captain.escalation"])).toBe(true);
  });

  it("does not wake the Brain for informational escalations", () => {
    expect(
      wakeClassForEvent({
        type: "captain.escalation",
        payload: { taskId: null, summary: "provisioned", severity: "info" },
      }),
    ).toBeNull();
    expect(
      wakeClassForEvent({
        type: "captain.escalation",
        payload: { taskId: null, summary: "need a decision", severity: "warn" },
      }),
    ).toBe("NEEDS_INPUT");
    expect(
      wakeClassForEvent({
        type: "captain.escalation",
        payload: { taskId: null, summary: "blocked", severity: "critical" },
      }),
    ).toBe("BLOCKED");
    expect(
      wakeClassForEvent({
        type: "pipeline.unavailable",
        payload: { reason: "missing", missingColumns: [], home: "/tmp" },
      }),
    ).toBe("GATE_FAILED");
  });

  it("rejects empty wakeOn prefixes the same way as surface", () => {
    const base = {
      activeProfile: "quiet",
      profiles: {
        quiet: {
          surface: ["task."],
          streamPipelineLogs: false,
          pipelineLogChars: 0,
          wakeOn: ["captain.escalation"],
        },
      },
      watchPipeline: true,
      pipelinePollMs: 1000,
    };
    expect(observabilityConfigSchema.safeParse(base).success).toBe(true);
    expect(
      observabilityConfigSchema.safeParse({
        ...base,
        profiles: {
          quiet: { ...base.profiles.quiet, wakeOn: [""] },
        },
      }).success,
    ).toBe(false);
    expect(
      observabilityConfigSchema.safeParse({
        ...base,
        profiles: {
          quiet: { ...base.profiles.quiet, surface: [""] },
        },
      }).success,
    ).toBe(false);
  });

  it("resolves activeProfile with quiet fallback", () => {
    const config = {
      activeProfile: "missing",
      profiles: {
        quiet: {
          surface: ["task."],
          streamPipelineLogs: false,
          pipelineLogChars: 0,
          wakeOn: ["captain.escalation"],
        },
      },
      watchPipeline: true,
      pipelinePollMs: 1000,
    };
    expect(resolveActiveProfile(config).name).toBe("quiet");
  });
});

describe("PipelineWatcher", () => {
  it("tails pure log appends without structured column changes and uses offset reads", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-watch-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const logPath = join(gateHome, "logs", "review.log");
    writeFileSync(logPath, "line-one-preexisting\n");
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', ?, ?, 'round 1', ?, NULL, NULL)`,
    ).run(JSON.stringify([{ id: "f1", severity: "error", action: "ask-user", description: "decide" }]), logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    let streamLogs = true;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: streamLogs, pipelineLogChars: 20_000 }),
    });
    watcher.start();
    const firstRun = events.filter((e) => e.type === "pipeline.run_updated");
    expect(firstRun.length).toBe(1);
    const snap = firstRun[0];
    if (snap?.type !== "pipeline.run_updated") throw new Error("expected run_updated");
    expect(snap.payload.steps[0]?.findings).toEqual([
      { id: "f1", severity: "error", action: "ask-user", description: "decide" },
    ]);
    // Seconds-based timestamps must not render as 1970.
    expect(new Date(snap.payload.updatedAt).getUTCFullYear()).toBeGreaterThanOrEqual(2020);
    expect(watcher.status().transport === "wal-assisted" || watcher.status().transport === "interval-only").toBe(
      true,
    );
    // First sight seeds offset — preexisting log bytes are not replayed.
    expect(
      events
        .filter((e) => e.type === "pipeline.log_appended")
        .some((e) => e.type === "pipeline.log_appended" && e.payload.chunk.includes("line-one-preexisting")),
    ).toBe(false);

    events.length = 0;
    appendFileSync(logPath, "pure-append-marker\n");
    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs.length).toBe(1);
    if (logs[0]?.type === "pipeline.log_appended") {
      expect(logs[0].payload.chunk).toContain("pure-append-marker");
      expect(logs[0].payload.chunk).not.toContain("line-one-preexisting");
    }
    // No structured change → no extra run_updated.
    expect(events.filter((e) => e.type === "pipeline.run_updated")).toHaveLength(0);

    events.length = 0;
    streamLogs = false;
    appendFileSync(logPath, "quiet-should-not-stream\n");
    watcher.tick();
    expect(events.filter((e) => e.type === "pipeline.log_appended")).toHaveLength(0);

    // After quiet advances the offset, re-enabling stream must emit only new
    // bytes — not re-seed to EOF and swallow the first post-flip append.
    events.length = 0;
    streamLogs = true;
    appendFileSync(logPath, "post-quiet-stream\n");
    watcher.tick();
    const resumed = events.filter((e) => e.type === "pipeline.log_appended");
    expect(resumed.length).toBe(1);
    if (resumed[0]?.type === "pipeline.log_appended") {
      expect(resumed[0].payload.chunk).toContain("post-quiet-stream");
      expect(resumed[0].payload.chunk).not.toContain("quiet-should-not-stream");
    }

    watcher.stop();
  });

  it("does not replay multi-chunk quiet growth after flipping to firehose", () => {
    // LOG_CHUNK_MAX is 16KiB; growth above that used to leave residual unread
    // bytes when quiet walked in chunks — those bytes then polluted firehose.
    const QUIET_GROWTH = 20_000;
    const gateHome = mkdtempSync(join(tmpdir(), "p9-quiet-chunk-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const logPath = join(gateHome, "logs", "review.log");
    writeFileSync(logPath, "seed\n");
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    let streamLogs = false;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: streamLogs, pipelineLogChars: 20_000 }),
    });
    watcher.start();
    expect(events.filter((e) => e.type === "pipeline.log_appended")).toHaveLength(0);

    const quietMarker = "QUIET_ONLY_MARKER";
    const quietPayload = quietMarker + "x".repeat(QUIET_GROWTH - quietMarker.length);
    appendFileSync(logPath, quietPayload);
    events.length = 0;
    // One quiet tick must snap the offset to EOF, not leave residual chunks.
    watcher.tick();
    expect(events.filter((e) => e.type === "pipeline.log_appended")).toHaveLength(0);

    events.length = 0;
    streamLogs = true;
    appendFileSync(logPath, "FIREHOSE_ONLY\n");
    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs.length).toBe(1);
    if (logs[0]?.type === "pipeline.log_appended") {
      expect(logs[0].payload.chunk).toContain("FIREHOSE_ONLY");
      expect(logs[0].payload.chunk).not.toContain(quietMarker);
    }

    watcher.stop();
  });

  it("retries log_appended after a throwing sink instead of dropping bytes", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-log-sink-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const logPath = join(gateHome, "logs", "review.log");
    writeFileSync(logPath, "seed\n");
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    let failNextLog = true;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => {
        if (failNextLog && e.type === "pipeline.log_appended") {
          failNextLog = false;
          throw new Error("simulated log append failure");
        }
        events.push(e);
      },
    });
    watcher.start();
    events.length = 0;
    appendFileSync(logPath, "must-retry-after-sink-throw\n");
    watcher.tick();
    expect(events.filter((e) => e.type === "pipeline.log_appended")).toHaveLength(0);

    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs).toHaveLength(1);
    if (logs[0]?.type === "pipeline.log_appended") {
      expect(logs[0].payload.chunk).toContain("must-retry-after-sink-throw");
    }
    watcher.stop();
  });

  it("re-seeds log offsets on stop/start instead of replaying while stopped", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-log-restart-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const logPath = join(gateHome, "logs", "review.log");
    writeFileSync(logPath, "seed\n");
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    watcher.stop();

    appendFileSync(logPath, "written-while-stopped\n");
    events.length = 0;
    watcher.start();
    expect(
      events
        .filter((e) => e.type === "pipeline.log_appended")
        .some(
          (e) =>
            e.type === "pipeline.log_appended" && e.payload.chunk.includes("written-while-stopped"),
        ),
    ).toBe(false);

    events.length = 0;
    appendFileSync(logPath, "after-restart\n");
    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs).toHaveLength(1);
    if (logs[0]?.type === "pipeline.log_appended") {
      expect(logs[0].payload.chunk).toContain("after-restart");
      expect(logs[0].payload.chunk).not.toContain("written-while-stopped");
    }
    watcher.stop();
  });

  it("surfaces a recently completed run using unix-second timestamps", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-completed-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    // Completed (not running/pending) — only the 6h recency branch can surface it.
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('done1', 'r', 'b', 'abc', 'base', 'completed', ?, ?, 'shipped')`,
    ).run(now - 60, now - 30);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'done1', 'review', 0, 'passed', '[]', NULL, 'done', ?, 1200, NULL)`,
    ).run(now - 30);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    const runs = events.filter((e) => e.type === "pipeline.run_updated");
    expect(runs.length).toBe(1);
    if (runs[0]?.type === "pipeline.run_updated") {
      expect(runs[0].payload.runId).toBe("done1");
      expect(runs[0].payload.status).toBe("completed");
      const updatedMs = Date.parse(runs[0].payload.updatedAt);
      expect(Number.isNaN(updatedMs)).toBe(false);
      expect(updatedMs).toBeGreaterThan(Date.now() - 60_000);
      expect(updatedMs).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(runs[0].payload.steps[0]?.lastActivityAt).not.toBeNull();
      const activityMs = Date.parse(runs[0].payload.steps[0]!.lastActivityAt!);
      expect(activityMs).toBeGreaterThan(Date.now() - 60_000);
    }
    watcher.stop();
  });

  it("retries run_updated after a throwing sink instead of permanently suppressing", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-fp-sink-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    const events: OrchestratorEvent[] = [];
    let failNextRunUpdated = true;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => {
        if (failNextRunUpdated && e.type === "pipeline.run_updated") {
          failNextRunUpdated = false;
          throw new Error("simulated append failure");
        }
        events.push(e);
      },
    });
    // start() ticks once; sink throws so the frame must not be fingerprinted.
    watcher.start();
    expect(events.filter((e) => e.type === "pipeline.run_updated")).toHaveLength(0);

    // Same structured state — without the fix this would stay silent forever.
    watcher.tick();
    const runs = events.filter((e) => e.type === "pipeline.run_updated");
    expect(runs).toHaveLength(1);
    if (runs[0]?.type === "pipeline.run_updated") {
      expect(runs[0].payload.runId).toBe("run1");
    }
    watcher.stop();
  });

  it("marks compatibility failed when a selected column is missing", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-schema-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    db.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    const compat = watcher.checkCompatibility();
    expect(compat.ok).toBe(false);
    expect(compat.missingColumns.some((c) => c.includes("findings_json"))).toBe(true);
    watcher.start();
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);
    expect(watcher.status().transport).toBe("unavailable");
    watcher.stop();
  });

  it("marks the view unreadable when state.sqlite disappears mid-session", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-missing-db-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    expect(watcher.status().compatibility.ok).toBe(true);
    expect(events.some((e) => e.type === "pipeline.run_updated")).toBe(true);

    events.length = 0;
    rmSync(join(gateHome, "state.sqlite"), { force: true });
    rmSync(join(gateHome, "state.sqlite-wal"), { force: true });
    rmSync(join(gateHome, "state.sqlite-shm"), { force: true });
    watcher.tick();

    expect(watcher.status().compatibility.ok).toBe(false);
    expect(watcher.status().transport).toBe("unavailable");
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);
    watcher.stop();
  });

  it("on recovery force-emits current runs so the Console observes a frame", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-recover-"));
    homes.push(gateHome);
    let db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    expect(events.filter((e) => e.type === "pipeline.run_updated")).toHaveLength(1);

    // Break the schema so the view becomes unreadable.
    db = new Database(join(gateHome, "state.sqlite"));
    db.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
    db.close();
    events.length = 0;
    // Force a probe failure path: compatibility was ok; tick will eventually fail reads.
    // Directly re-check after the rename.
    watcher.checkCompatibility();
    expect(watcher.status().compatibility.ok).toBe(false);
    watcher.tick();
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);

    // Restore the column name and recover.
    db = new Database(join(gateHome, "state.sqlite"));
    db.exec("ALTER TABLE step_results RENAME COLUMN findings_blob TO findings_json");
    db.close();
    events.length = 0;
    watcher.tick();

    expect(watcher.status().compatibility.ok).toBe(true);
    expect(watcher.status().transport === "wal-assisted" || watcher.status().transport === "interval-only").toBe(
      true,
    );
    const recovered = events.filter((e) => e.type === "pipeline.run_updated");
    expect(recovered.length).toBe(1);
    if (recovered[0]?.type === "pipeline.run_updated") {
      expect(recovered[0].payload.runId).toBe("run1");
    }
    watcher.stop();
  });

  it("emits unavailable when watchPipeline is turned off", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-watch-off-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    expect(watcher.status().transport).not.toBe("unavailable");

    events.length = 0;
    watcher.applyConfig({ watchPipeline: false, pollMs: 1000 });
    expect(watcher.status().transport).toBe("unavailable");
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);
    watcher.stop();
  });

  it("does not promote transport on applyConfig while schema is unreadable", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-apply-unreadable-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    db.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
    });
    watcher.start();
    expect(watcher.status().compatibility.ok).toBe(false);
    expect(watcher.status().transport).toBe("unavailable");

    watcher.applyConfig({ watchPipeline: true, pollMs: 500 });
    expect(watcher.status().compatibility.ok).toBe(false);
    expect(watcher.status().transport).toBe("unavailable");
    watcher.stop();
  });

  it("re-attaches WAL watch on later ticks when the WAL appears after start", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-wal-late-"));
    homes.push(gateHome);
    // DELETE journal mode has no -wal file at attach time.
    mkdirSync(join(gateHome, "logs"), { recursive: true });
    const db = new Database(join(gateHome, "state.sqlite"));
    db.pragma("journal_mode = DELETE");
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT NOT NULL, head_sha TEXT NOT NULL,
        base_sha TEXT, status TEXT NOT NULL DEFAULT 'pending', pr_url TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, intent TEXT
      );
      CREATE TABLE step_results (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL,
        step_order INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER, duration_ms INTEGER, log_path TEXT, findings_json TEXT,
        error TEXT, started_at INTEGER, completed_at INTEGER,
        last_activity_at INTEGER, last_activity TEXT, agent_pid INTEGER, auto_fix_limit INTEGER
      );
    `);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
    });
    watcher.start();
    expect(watcher.status().transport).toBe("interval-only");

    // A later write under WAL creates the -wal file the honesty label needs.
    const writer = new Database(join(gateHome, "state.sqlite"));
    writer.pragma("journal_mode = WAL");
    writer
      .prepare(`UPDATE runs SET updated_at = ? WHERE id = 'run1'`)
      .run(nowUnixSeconds());
    writer.close();

    watcher.tick();
    expect(watcher.status().transport).toBe("wal-assisted");
    watcher.stop();
  });

  it("drops runs that leave the SQL-visible set from liveSnapshots", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-live-drop-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
    });
    watcher.start();
    expect(watcher.liveSnapshots().some((r) => r.runId === "run1")).toBe(true);

    // Age the run outside the recency window and mark terminal so SQL drops it.
    const writer = new Database(join(gateHome, "state.sqlite"));
    writer
      .prepare(
        `UPDATE runs SET status = 'completed', updated_at = ? WHERE id = 'run1'`,
      )
      .run(now - 7 * 60 * 60);
    writer.close();
    watcher.tick();

    expect(watcher.liveSnapshots()).toHaveLength(0);
    watcher.stop();
  });

  it("GET /v1/pipeline/runs does not report event-store ghosts outside the live set", async () => {
    // Fails on the pre-fix behaviour: rebuilding cards from durable
    // pipeline.run_updated frames resurrects non-terminal history the watcher
    // no longer considers live.
    const agentHome = mkdtempSync(join(tmpdir(), "p9-ghost-home-"));
    const gateHome = mkdtempSync(join(tmpdir(), "p9-ghost-gate-"));
    homes.push(agentHome, gateHome);
    mkdirSync(join(agentHome, "config"), { recursive: true });
    buildGate(gateHome).close();

    const { store } = EventStore.open(agentHome);
    store.append({
      type: "pipeline.run_updated",
      payload: {
        runId: "ghost-run-outside-window",
        branch: "phase-x/ghost",
        status: "running",
        headSha: "deadbeef",
        prUrl: null,
        error: null,
        intent: "should not appear",
        steps: [
          {
            step: "review",
            order: 0,
            status: "running",
            findingsCount: 0,
            findings: [],
            lastActivity: "stale",
            lastActivityAt: new Date().toISOString(),
            durationMs: null,
            agentPid: null,
          },
        ],
        updatedAt: new Date().toISOString(),
      },
    });

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (event) => {
        store.append(event);
      },
    });
    watcher.start();
    // Gate has no runs — live set is empty even though the durable log has a
    // non-terminal pipeline.run_updated frame.
    expect(watcher.liveSnapshots()).toHaveLength(0);
    expect(watcher.status().compatibility.ok).toBe(true);

    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(agentHome, "config"));
    config.installDefaults();
    const token = "ghost-test-token-0001";
    const app = buildServer({
      store,
      config,
      token,
      home: agentHome,
      port: 0,
      startedAt: new Date().toISOString(),
      logger: pino({ level: "silent" }),
      pipeline: watcher,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/pipeline/runs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runs: Array<{ runId: string; status: string }>;
      unavailable: boolean;
    };
    expect(body.unavailable).toBe(false);
    expect(body.runs.some((r) => r.runId === "ghost-run-outside-window")).toBe(false);
    expect(body.runs.some((r) => r.status === "running")).toBe(false);

    watcher.stop();
    await app.close();
  });

  it("keeps the view readable when sink throws on run_updated", () => {
    // Fails if a sink throw is counted as a structured-read failure: three
    // append blips would markUnavailable and blank liveSnapshots even though
    // the SELECT succeeded.
    const gateHome = mkdtempSync(join(tmpdir(), "p9-sink-throw-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    let sinkCalls = 0;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (event) => {
        if (event.type === "pipeline.run_updated") {
          sinkCalls += 1;
          throw new Error("event store full");
        }
      },
    });
    watcher.start();
    watcher.tick();
    watcher.tick();
    watcher.tick();

    expect(sinkCalls).toBeGreaterThanOrEqual(3);
    expect(watcher.status().compatibility.ok).toBe(true);
    expect(watcher.status().transport).not.toBe("unavailable");
    expect(watcher.liveSnapshots().some((r) => r.runId === "run1")).toBe(true);
    expect(watcher.status().compatibility.reason ?? "").not.toMatch(/structured pipeline read failed/);
    watcher.stop();
  });

  it("rides out a transient write lock without blanking the view", async () => {
    // Fails without busy_timeout: SQLITE_BUSY is immediate, three strikes mark
    // the view unreadable even though the gate DB is healthy. The lock must be
    // held on another thread/process so the event loop can release it while
    // better-sqlite3 blocks in busy_timeout.
    const gateHome = mkdtempSync(join(tmpdir(), "p9-busy-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
    });
    watcher.start();
    expect(watcher.status().compatibility.ok).toBe(true);
    expect(watcher.liveSnapshots()).toHaveLength(1);

    const { createRequire } = await import("node:module");
    const { Worker } = await import("node:worker_threads");
    const requireFromHere = createRequire(import.meta.url);
    const betterSqlitePath = requireFromHere.resolve("better-sqlite3");
    const dbPath = join(gateHome, "state.sqlite");

    const holder = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.betterSqlitePath);
      const db = new Database(workerData.dbPath);
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        try { db.exec("COMMIT"); } catch {}
        db.close();
        parentPort.postMessage("released");
      }, 100);
      `,
      {
        eval: true,
        workerData: { dbPath, betterSqlitePath },
      },
    );

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("holder did not lock")), 3000);
      holder.on("message", (msg: string) => {
        if (msg === "locked") {
          clearTimeout(t);
          resolve();
        }
      });
      holder.on("error", reject);
    });

    watcher.tick();
    watcher.tick();
    watcher.tick();

    expect(watcher.status().compatibility.ok).toBe(true);
    expect(watcher.status().transport).not.toBe("unavailable");
    expect(watcher.liveSnapshots().some((r) => r.runId === "run1")).toBe(true);

    await holder.terminate().catch(() => undefined);
    watcher.stop();
  });

  it("prunes logOffsets when a run leaves the live set", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-offset-prune-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 20_000 }),
    });
    watcher.start();
    // Seed offset via first sight, then append so a second tick stores a key.
    appendFileSync(logPath, "more log\n");
    watcher.tick();

    const offsets = (watcher as unknown as { logOffsets: Map<string, number> }).logOffsets;
    expect([...offsets.keys()].some((k) => k.startsWith("run1:"))).toBe(true);

    const writer = new Database(join(gateHome, "state.sqlite"));
    writer
      .prepare(`UPDATE runs SET status = 'completed', updated_at = ? WHERE id = 'run1'`)
      .run(now - 7 * 60 * 60);
    writer.close();
    watcher.tick();

    expect([...offsets.keys()].some((k) => k.startsWith("run1:"))).toBe(false);
    watcher.stop();
  });

  it("demotes transport to interval-only when WAL assist disappears mid-session", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-wal-demote-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.close();

    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => undefined,
    });
    watcher.start();
    expect(watcher.status().transport).toBe("wal-assisted");

    // Switch off WAL so the assist file is gone for good (a mere unlink is
    // recreated the next time better-sqlite3 opens a WAL-mode database).
    const writer = new Database(join(gateHome, "state.sqlite"));
    writer.pragma("journal_mode = DELETE");
    writer.close();
    rmSync(join(gateHome, "state.sqlite-wal"), { force: true });
    rmSync(join(gateHome, "state.sqlite-shm"), { force: true });

    watcher.tick();
    expect(watcher.status().transport).toBe("interval-only");
    expect(watcher.status().compatibility.ok).toBe(true);
    watcher.stop();
  });

  it("marks unavailable on the first mid-session schema error while busy stays graceful", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-schema-first-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', NULL, 'round 1', ?, NULL, NULL)`,
    ).run(now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
    });
    watcher.start();
    expect(watcher.status().compatibility.ok).toBe(true);
    expect(watcher.liveSnapshots()).toHaveLength(1);

    // Drop a selected column mid-session — first structured failure must blank.
    const writer = new Database(join(gateHome, "state.sqlite"));
    writer.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
    writer.close();
    events.length = 0;
    watcher.tick();

    expect(watcher.status().compatibility.ok).toBe(false);
    expect(watcher.status().transport).toBe("unavailable");
    expect(watcher.liveSnapshots()).toHaveLength(0);
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);
    watcher.stop();
  });

  it("retries pipeline.unavailable when the sink throws before the flag sticks", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-unavail-retry-"));
    homes.push(gateHome);
    // Missing state.sqlite → start reports unavailable.
    mkdirSync(gateHome, { recursive: true });

    let failUnavailable = true;
    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => {
        if (failUnavailable && e.type === "pipeline.unavailable") {
          throw new Error("event store full");
        }
        events.push(e);
      },
    });
    watcher.start();
    // First report threw — flag must not stick.
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(false);

    failUnavailable = false;
    watcher.tick();
    expect(events.some((e) => e.type === "pipeline.unavailable")).toBe(true);
    watcher.stop();
  });

  it("activeLogTails seeds recent log text under streaming profiles and not under quiet", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-catchup-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "prior-line-one\nprior-line-two\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    let streamLogs = true;
    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: streamLogs, pipelineLogChars: 20_000 }),
    });
    watcher.start();
    // First sight seeds offset to EOF without emitting — catch-up is the only
    // way to see prior-line-* on attach.
    expect(events.filter((e) => e.type === "pipeline.log_appended")).toHaveLength(0);

    const seeded = watcher.activeLogTails();
    expect(seeded.streamPipelineLogs).toBe(true);
    expect(seeded.tails).toHaveLength(1);
    expect(seeded.tails[0]?.text).toContain("prior-line-one");
    expect(seeded.tails[0]?.text).toContain("prior-line-two");
    expect(typeof seeded.tails[0]?.startOffset).toBe("number");
    expect(typeof seeded.tails[0]?.endOffset).toBe("number");

    // First-sight offset already sits at EOF; pure-read catch-up leaves it there
    // so a subsequent append still emits only new bytes.
    events.length = 0;
    appendFileSync(logPath, "after-seed\n");
    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs).toHaveLength(1);
    if (logs[0]?.type === "pipeline.log_appended") {
      expect(logs[0].payload.chunk).toContain("after-seed");
      expect(logs[0].payload.chunk).not.toContain("prior-line-one");
      expect(typeof logs[0].payload.offset).toBe("number");
    }

    streamLogs = false;
    const quiet = watcher.activeLogTails();
    expect(quiet.streamPipelineLogs).toBe(false);
    expect(quiet.tails).toHaveLength(0);
    watcher.stop();
  });

  it("activeLogTails does not advance logOffsets so unread SSE region still streams", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-pure-tail-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 20_000 }),
    });
    watcher.start();
    const offsets = (watcher as unknown as { logOffsets: Map<string, number> }).logOffsets;
    const key = "run1:review";
    const offsetBeforeGrowth = offsets.get(key);
    expect(offsetBeforeGrowth).toBeDefined();

    appendFileSync(logPath, "UNREAD_BY_SSE_YET\n");
    const offsetBeforeTails = offsets.get(key);
    expect(offsetBeforeTails).toBe(offsetBeforeGrowth);

    const tails = watcher.activeLogTails();
    expect(tails.tails.some((t) => t.text.includes("UNREAD_BY_SSE_YET"))).toBe(true);
    expect(offsets.get(key)).toBe(offsetBeforeTails);

    events.length = 0;
    watcher.tick();
    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const joined = logs
      .map((e) => (e.type === "pipeline.log_appended" ? e.payload.chunk : ""))
      .join("");
    expect(joined).toContain("UNREAD_BY_SSE_YET");
    watcher.stop();
  });

  it("drains multi-chunk log growth within a bounded number of ticks", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-multichunk-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 200_000 }),
    });
    watcher.start();

    // Two full chunks plus a marker — one-chunk-per-tick would need 3 ticks.
    const burst = "A".repeat(PIPELINE_LOG_CHUNK_MAX * 2) + "MULTI_CHUNK_END\n";
    appendFileSync(logPath, burst);
    events.length = 0;
    watcher.tick();
    const firstTickLogs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(firstTickLogs.length).toBeGreaterThan(1);
    expect(firstTickLogs.length).toBeLessThanOrEqual(PIPELINE_LOG_DRAIN_MAX_CHUNKS);

    let joined = firstTickLogs
      .map((e) => (e.type === "pipeline.log_appended" ? e.payload.chunk : ""))
      .join("");
    // Full drain of ~2 chunks fits one tick's bound; if not, finish within bound ticks.
    let ticks = 1;
    const maxTicks =
      Math.ceil(burst.length / PIPELINE_LOG_CHUNK_MAX) + 1;
    while (!joined.includes("MULTI_CHUNK_END") && ticks < maxTicks) {
      events.length = 0;
      watcher.tick();
      const more = events.filter((e) => e.type === "pipeline.log_appended");
      joined += more
        .map((e) => (e.type === "pipeline.log_appended" ? e.payload.chunk : ""))
        .join("");
      ticks += 1;
    }
    expect(joined).toContain("MULTI_CHUNK_END");
    expect(ticks).toBeLessThanOrEqual(Math.ceil(burst.length / PIPELINE_LOG_CHUNK_MAX));
    watcher.stop();
  });

  it("reports logBehind when unread growth exceeds the per-tick drain bound", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-log-behind-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 200_000 }),
    });
    watcher.start();

    const overflow = PIPELINE_LOG_DRAIN_MAX_BYTES + PIPELINE_LOG_CHUNK_MAX;
    appendFileSync(logPath, "B".repeat(overflow));
    watcher.tick();

    const status = watcher.status();
    expect(status.logBehind.length).toBe(1);
    expect(status.logBehind[0]?.runId).toBe("run1");
    expect(status.logBehind[0]?.step).toBe("review");
    expect(status.logBehind[0]?.unreadBytes ?? 0).toBeGreaterThan(0);

    // Catch up fully over subsequent ticks; behind clears when drained.
    for (let i = 0; i < 8; i += 1) {
      watcher.tick();
      if (watcher.status().logBehind.length === 0) break;
    }
    expect(watcher.status().logBehind).toEqual([]);
    watcher.stop();
  });

  it("GET /v1/pipeline/log-tails returns bounded catch-up for active steps", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "p9-logtail-home-"));
    const gateHome = mkdtempSync(join(tmpdir(), "p9-logtail-gate-"));
    homes.push(agentHome, gateHome);
    mkdirSync(join(agentHome, "config"), { recursive: true });
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seeded-from-api\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const { store } = EventStore.open(agentHome);
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (event) => {
        store.append(event);
      },
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 20_000 }),
    });
    watcher.start();

    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(agentHome, "config"));
    config.installDefaults();
    const token = "logtail-test-token-0001";
    const app = buildServer({
      store,
      config,
      token,
      home: agentHome,
      port: 0,
      startedAt: new Date().toISOString(),
      logger: pino({ level: "silent" }),
      pipeline: watcher,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/pipeline/log-tails",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      streamPipelineLogs: boolean;
      tails: Array<{ runId: string; step: string; text: string }>;
    };
    // Profile comes from the watcher callback (streaming), not the default quiet config.
    expect(body.streamPipelineLogs).toBe(true);
    expect(body.tails.some((t) => t.text.includes("seeded-from-api"))).toBe(true);

    watcher.stop();
    await app.close();
  });

  it("carries multi-byte UTF-8 across chunk boundaries with authoritative endOffset", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-utf8-boundary-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 200_000 }),
    });
    watcher.start();

    // Place a 3-byte euro so its first byte is the last byte of chunk 1.
    const pad = "x".repeat(PIPELINE_LOG_CHUNK_MAX - 1);
    const euro = "€";
    const suffix = "AFTER\n";
    appendFileSync(logPath, pad + euro + suffix);
    events.length = 0;
    watcher.tick();
    // Drain any residual incomplete sequence left for the next tick.
    for (let i = 0; i < 4; i += 1) {
      watcher.tick();
    }

    const logs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const joined = logs
      .map((e) => (e.type === "pipeline.log_appended" ? e.payload.chunk : ""))
      .join("");
    expect(joined).toContain(euro);
    expect(joined).toContain("AFTER");
    expect(joined).not.toContain("\uFFFD");

    // Server-measured endOffset must match file progress; client must not
    // recompute end from Buffer.byteLength of a lossy decode.
    let clientEnd = -1;
    for (const e of logs) {
      if (e.type !== "pipeline.log_appended") continue;
      const { offset, endOffset, chunk } = e.payload;
      expect(typeof endOffset).toBe("number");
      expect(endOffset).toBeGreaterThan(offset);
      expect(endOffset - offset).toBe(Buffer.byteLength(chunk, "utf8"));
      if (clientEnd < 0) clientEnd = offset;
      expect(offset).toBe(clientEnd);
      clientEnd = endOffset;
    }
    // Following chunk continuity: last end equals current file size.
    const finalSize = Buffer.byteLength("seed\n" + pad + euro + suffix, "utf8");
    expect(clientEnd).toBe(finalSize);
    watcher.stop();
  });

  it("emits whitespace-only log appends (newline and CR redraw)", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-ws-log-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    writeFileSync(logPath, "seed\n");
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const events: OrchestratorEvent[] = [];
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: (e) => events.push(e),
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: 20_000 }),
    });
    watcher.start();

    events.length = 0;
    appendFileSync(logPath, "\n");
    watcher.tick();
    const newlineLogs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(newlineLogs).toHaveLength(1);
    if (newlineLogs[0]?.type === "pipeline.log_appended") {
      expect(newlineLogs[0].payload.chunk).toBe("\n");
    }

    events.length = 0;
    appendFileSync(logPath, "\r");
    watcher.tick();
    const crLogs = events.filter((e) => e.type === "pipeline.log_appended");
    expect(crLogs).toHaveLength(1);
    if (crLogs[0]?.type === "pipeline.log_appended") {
      expect(crLogs[0].payload.chunk).toBe("\r");
    }
    watcher.stop();
  });

  it("activeLogTails and Console retention agree on character window for non-ASCII", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-logchars-"));
    homes.push(gateHome);
    const db = buildGate(gateHome);
    const now = nowUnixSeconds();
    const logPath = join(gateHome, "logs", "run1", "review.log");
    mkdirSync(join(gateHome, "logs", "run1"), { recursive: true });
    // α is 2 UTF-8 bytes and 1 JS character — byte budget would under-fill.
    const body = "α".repeat(100);
    writeFileSync(logPath, body);
    db.prepare(
      `INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
       VALUES ('run1', 'r', 'b', 'abc', 'base', 'running', ?, ?, 'i')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at, duration_ms, agent_pid)
       VALUES ('s1', 'run1', 'review', 0, 'running', '[]', ?, 'round 1', ?, NULL, NULL)`,
    ).run(logPath, now);
    db.close();

    const retention = 10;
    const watcher = new PipelineWatcher({
      home: gateHome,
      pollMs: 10_000,
      sink: () => {},
      profile: () => ({ streamPipelineLogs: true, pipelineLogChars: retention }),
    });
    watcher.start();

    const tails = watcher.activeLogTails();
    expect(tails.tails).toHaveLength(1);
    const tail = tails.tails[0]!;
    const consoleWindow = body.slice(-retention);
    expect(tail.text).toBe(consoleWindow);
    expect(tail.text.length).toBe(retention);
    expect(tail.endOffset - tail.startOffset).toBe(Buffer.byteLength(tail.text, "utf8"));
    expect(tail.truncated).toBe(true);
    // Byte-budget read of `retention` bytes would yield only 5 α's — not 10.
    expect(tail.text).not.toBe("α".repeat(Math.floor(retention / 2)));
    watcher.stop();
  });

  it("readLogTailByChars ignores unread buffer bytes after a short read (truncate race)", () => {
    const gateHome = mkdtempSync(join(tmpdir(), "p9-short-read-"));
    homes.push(gateHome);
    const logPath = join(gateHome, "truncated.log");
    // Actual file is short; size claims a larger window so readSync returns short.
    writeFileSync(logPath, "hello-world");
    const claimedSize = 64;
    const result = readLogTailByChars(logPath, claimedSize, 100);
    expect(result.text.includes("\0")).toBe(false);
    expect(result.text).toBe("hello-world");
    expect(result.endOffset).toBe(Buffer.byteLength("hello-world", "utf8"));
    expect(result.endOffset).toBe(result.startOffset + Buffer.byteLength(result.text, "utf8"));
  });
});

describe("wakeOn subscription order", () => {
  it("delivers pipeline.unavailable wake on cold start under firehose", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentos-wakeon-boot-"));
    homes.push(home);
    const missingGate = mkdtempSync(join(tmpdir(), "agentos-missing-gate-"));
    homes.push(missingGate);
    mkdirSync(join(home, "config"), { recursive: true });
    // Layer override only — ships quiet by default; firehose opts into gate wakes.
    writeFileSync(
      join(home, "config", "observability.json5"),
      `{ activeProfile: "firehose" }\n`,
      { mode: 0o600 },
    );

    const prevGate = process.env.AGENTOS_NO_MISTAKES_HOME;
    process.env.AGENTOS_NO_MISTAKES_HOME = missingGate;
    process.env.AGENTOS_FAKE_TMUX = "1";
    process.env.AGENTOS_FAKE_PI = "1";
    process.env.AGENTOS_FAKE_BRAIN = "1";

    const daemon = await startDaemon({ home, port: 0, stdout: false });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/wakes`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        wakes: Array<{
          class: string;
          summary: string;
          detail?: { eventType?: string; source?: string };
        }>;
      };
      const bootWake = body.wakes.find(
        (w) =>
          w.detail?.source === "observability.wakeOn" &&
          w.detail?.eventType === "pipeline.unavailable",
      );
      expect(bootWake).toBeDefined();
      expect(bootWake?.class).toBe("GATE_FAILED");
      expect(bootWake?.summary).toMatch(/pipeline unreadable/i);
    } finally {
      await daemon.close();
      if (prevGate === undefined) delete process.env.AGENTOS_NO_MISTAKES_HOME;
      else process.env.AGENTOS_NO_MISTAKES_HOME = prevGate;
      delete process.env.AGENTOS_FAKE_TMUX;
      delete process.env.AGENTOS_FAKE_PI;
      delete process.env.AGENTOS_FAKE_BRAIN;
    }
  });
});

describe("Console appliedLogIds growth", () => {
  it("prunes ids that have left the live SSE ring", () => {
    const applied = new Set(["old-1", "old-2", "still-live"]);
    pruneAppliedLogIds(applied, ["still-live", "fresh"]);
    expect(applied.has("old-1")).toBe(false);
    expect(applied.has("old-2")).toBe(false);
    expect(applied.has("still-live")).toBe(true);
    expect(applied.size).toBe(1);

    // Simulate many historical frames leaving a fixed-size ring.
    for (let i = 0; i < 10_000; i += 1) applied.add(`hist-${i}`);
    const ring = Array.from({ length: 50 }, (_, i) => `ring-${i}`);
    for (const id of ring) applied.add(id);
    pruneAppliedLogIds(applied, ring);
    expect(applied.size).toBe(ring.length);
    for (const id of ring) expect(applied.has(id)).toBe(true);
  });
});
