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
import { afterEach, describe, expect, it } from "vitest";
import { observabilityConfigSchema, type OrchestratorEvent } from "@agent-os/protocol";
import { PipelineWatcher } from "../src/pipeline/watcher.js";
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
});
