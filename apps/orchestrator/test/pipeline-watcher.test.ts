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
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { PipelineWatcher } from "../src/pipeline/watcher.js";
import { buildServer } from "../src/server/app.js";
import {
  eventMatchesSurface,
  eventMatchesWakeOn,
  resolveActiveProfile,
  wakeClassForEvent,
} from "../src/observability/profile.js";

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
      profile: () => ({ streamPipelineLogs: streamLogs }),
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
      profile: () => ({ streamPipelineLogs: streamLogs }),
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
      profile: () => ({ streamPipelineLogs: true }),
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
});
