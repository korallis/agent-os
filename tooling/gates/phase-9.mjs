#!/usr/bin/env node
/**
 * Phase 9 executable gates (master plan §11 Phase 9, [R7]) — live pipeline
 * visibility and configurable observability.
 *
 *   G1  a run appears in the Console within 1 s of a state change
 *   G2  step log output streams incrementally, not as a replay
 *   G3  a run parked on a gate is unmistakably "needs a decision", with findings
 *   G4  schema drift degrades VISIBLY — never stale rows rendered as current
 *   G5  the transport in use is reported as fact (live vs polled), with lag
 *   G6  read-only proof: zero writes anywhere under the no-mistakes home
 *   G7  visibility profiles change what reaches the Console, hot-reloaded
 *   G8  unchanged state emits nothing — no per-tick event spam
 *
 * The watcher is pointed at a FIXTURE no-mistakes home built to the real
 * schema, so the gate never touches the Captain's actual gate state or depends
 * on a run being in flight.
 *
 * Usage: node tooling/gates/phase-9.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p9-${process.pid}`;
const PORT = 4700 + 950 + Math.floor(Math.random() * 40);
const CONSOLE_PORT = 3900 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a fixture no-mistakes home matching the real v1.40 schema. */
function buildFixtureGate(dir) {
  mkdirSync(join(dir, "logs"), { recursive: true });
  const db = new Database(join(dir, "state.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT);
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

function seedRun(db, runId, branch, steps) {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at, intent)
     VALUES (?, 'repo1', ?, 'abc1234def', 'base', 'running', ?, ?, 'fixture intent')`,
  ).run(runId, branch, now, now);
  steps.forEach((step, index) => {
    db.prepare(
      `INSERT OR REPLACE INTO step_results
         (id, run_id, step_name, step_order, status, findings_json, log_path, last_activity, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${runId}-${step.name}`,
      runId,
      step.name,
      index,
      step.status,
      step.findings ?? null,
      step.logPath ?? null,
      step.lastActivity ?? null,
      step.lastActivity != null ? Date.now() : null,
    );
  });
  db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(Date.now(), runId);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Snapshot path → (size, mtimeMs) so any write anywhere is detectable. */
function snapshotTree(dir) {
  const map = new Map();
  for (const file of walk(dir)) {
    try {
      const s = statSync(file);
      map.set(file, `${s.size}:${s.mtimeMs}`);
    } catch {
      // vanished mid-walk
    }
  }
  return map;
}

const cleanups = [];
let daemon;
let consoleServer;
let browser;
let fixtureDb;

try {
  const gateHome = mkdtempSync(join(tmpdir(), "agentos-p9-gate-"));
  const home = mkdtempSync(join(tmpdir(), "agentos-p9-home-"));
  cleanups.push(gateHome, home);
  fixtureDb = buildFixtureGate(gateHome);

  const logPath = join(gateHome, "logs", "run1-review.log");
  writeFileSync(logPath, "starting review\n");
  seedRun(fixtureDb, "01RUNFIXTURE0000000000001", "phase-x/demo", [
    { name: "intent", status: "completed" },
    { name: "rebase", status: "completed" },
    { name: "review", status: "running", logPath, lastActivity: "round 1" },
    { name: "test", status: "pending" },
  ]);

  daemon = spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
      // Point the watcher at the fixture gate, never the Captain's real one.
      AGENTOS_NO_MISTAKES_HOME: gateHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 30_000;
  let token = null;
  while (Date.now() < deadline && token === null) {
    try {
      const candidate = readFileSync(join(home, "daemon.token"), "utf8").trim();
      const res = await fetch(`${BASE}/v1/health`);
      if (res.ok) token = candidate;
    } catch {
      // not up
    }
    if (token === null) await sleep(150);
  }
  if (token === null) throw new Error("daemon did not start");
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async (path) => (await fetch(`${BASE}${path}`, { headers: auth })).json();

  // Baseline the gate home so any write by Agent OS is visible later (G6).
  await sleep(1500);
  const before = snapshotTree(gateHome);

  // ── G5 — transport reported as fact ───────────────────────────────────
  {
    const status = (await get("/v1/pipeline/status")).pipeline;
    // Only modes that can actually occur today: WAL-assisted (fs.watch attached)
    // or interval-only. `live` is reserved for a true push path that does not
    // exist yet and must not appear on the wire.
    gate(
      "G5",
      "the transport in use is reported as fact, with observed lag",
      (status.transport === "wal-assisted" || status.transport === "interval-only") &&
        status.compatibility.ok === true &&
        typeof status.lagMs === "number",
      `transport=${status.transport} compatible=${status.compatibility.ok} lagMs=${status.lagMs}`,
    );
  }

  // ── G1 — a state change reaches the API within 1 s ────────────────────
  {
    const started = Date.now();
    seedRun(fixtureDb, "01RUNFIXTURE0000000000002", "phase-x/second", [
      { name: "intent", status: "completed" },
      { name: "review", status: "running", lastActivity: "auto-fix 1/3" },
    ]);
    let seen = false;
    while (Date.now() - started < 3000) {
      const runs = (await get("/v1/pipeline/runs")).runs ?? [];
      if (runs.some((r) => r.runId === "01RUNFIXTURE0000000000002")) {
        seen = true;
        break;
      }
      await sleep(50);
    }
    const elapsed = Date.now() - started;
    gate(
      "G1",
      "a pipeline state change is visible within 1 s",
      seen && elapsed <= 1000,
      `seen=${seen} in ${elapsed}ms`,
    );
  }

  // ── G8 — unchanged state emits nothing ────────────────────────────────
  {
    const countPipelineEvents = async () => {
      const replay = await get("/v1/events/replay?types=pipeline.run_updated&limit=10000");
      return (replay.events ?? []).length;
    };
    const first = await countPipelineEvents();
    await sleep(2500); // several poll cycles with no state change
    const second = await countPipelineEvents();
    gate(
      "G8",
      "unchanged pipeline state emits no events — no per-tick spam",
      second === first,
      `events ${first} → ${second} across ~2.5 s of idle ticks`,
    );
  }

  // ── G2 — log output streams incrementally ─────────────────────────────
  // Pure log append: do NOT touch any structured column. The real-world case is
  // a step writing to its log without updating last_activity / updated_at.
  // First opt into a profile that streams logs (shipped default is quiet).
  {
    const configPath = join(home, "config", "observability.json5");
    const raw = readFileSync(configPath, "utf8");
    const overridden = raw.replace(/\{\s*\}\s*$/, '{\n  activeProfile: "working",\n}\n');
    if (overridden === raw) {
      throw new Error("G2 could not write working profile override");
    }
    writeFileSync(configPath, overridden);
    const profileDeadline = Date.now() + 15_000;
    while (Date.now() < profileDeadline) {
      const probe = await get("/v1/config/effective");
      if (probe.config?.observability?.activeProfile === "working") break;
      await sleep(250);
    }

    const marker = `LIVE-LINE-${Date.now()}`;
    appendFileSync(logPath, `${marker}\n`);

    const started = Date.now();
    let streamed = false;
    while (Date.now() - started < 4000) {
      const replay = await get("/v1/events/replay?types=pipeline.log_appended&limit=1000");
      const frames = replay.events ?? [];
      if (frames.some((e) => (e.event?.payload?.chunk ?? "").includes(marker))) {
        streamed = true;
        break;
      }
      await sleep(100);
    }
    gate(
      "G2",
      "newly appended step-log output streams incrementally without structured column changes",
      streamed,
      `marker=${marker} streamed=${streamed} in ${Date.now() - started}ms`,
    );
  }

  // ── G6 — read-only proof ──────────────────────────────────────────────
  {
    const after = snapshotTree(gateHome);
    const changed = [];
    for (const [path, stamp] of after) {
      // The fixture DB is written by the GATE itself, not by Agent OS.
      if (path.includes("state.sqlite") || path.endsWith(logPath)) continue;
      if (before.get(path) !== stamp) changed.push(path.slice(gateHome.length + 1));
    }
    const added = [...after.keys()].filter(
      (p) => !before.has(p) && !p.includes("state.sqlite") && p !== logPath,
    );
    gate(
      "G6",
      "Agent OS never writes anywhere under the no-mistakes home",
      changed.length === 0 && added.length === 0,
      `modified=${changed.length} added=${added.length}${added.length > 0 ? ` (${added.slice(0, 3).join(", ")})` : ""}`,
    );
  }

  // ── Console-side gates ────────────────────────────────────────────────
  consoleServer = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  {
    const upDeadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < upDeadline && !up) {
      try {
        up = (await fetch(`${CONSOLE}/pipeline`)).status < 500;
      } catch {
        // not up
      }
      if (!up) await sleep(300);
    }
    if (!up) throw new Error("console did not start");
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  // ── G3 — a parked gate is unmistakably a decision point ───────────────
  {
    seedRun(fixtureDb, "01RUNFIXTURE0000000000003", "phase-x/parked", [
      { name: "intent", status: "completed" },
      {
        name: "review",
        status: "awaiting_approval",
        findings: JSON.stringify([
          { id: "f1", severity: "error", action: "ask-user", description: "needs a call" },
          { id: "f2", severity: "warning", action: "auto-fix", description: "mechanical" },
        ]),
        lastActivity: "parked",
      },
    ]);
    await sleep(1500);
    await page.goto(`${CONSOLE}/pipeline`, { waitUntil: "networkidle" });
    await sleep(1200);
    const text = (await page.textContent("body")) ?? "";
    gate(
      "G3",
      "a run parked on a gate renders as needing a decision, with findings table and actions",
      text.includes("NEEDS A DECISION") &&
        text.includes("2 findings") &&
        text.includes("ask-user") &&
        text.includes("auto-fix") &&
        text.includes("needs a call"),
      `needsDecision=${text.includes("NEEDS A DECISION")} findingsTable=${text.includes("ask-user") && text.includes("auto-fix")}`,
    );
  }

  // ── G5b — the Console states the transport, not just the daemon ───────
  {
    const text = (await page.textContent("body")) ?? "";
    const statesTransport =
      (text.includes("WAL-ASSISTED") || text.includes("INTERVAL-ONLY")) &&
      text.includes("read-only") &&
      !text.includes("LIVE STREAM");
    gate(
      "G5b",
      "the Console states which transport is in use rather than implying live",
      statesTransport,
      `statesTransport=${statesTransport}`,
    );
  }

  // ── G4 — schema drift degrades visibly ────────────────────────────────
  {
    // Rename a column the watcher depends on — exactly what a no-mistakes
    // upgrade could do. The surface must SAY it cannot read, not go quiet.
    fixtureDb.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
    // Force a re-probe by restarting the watcher through a daemon bounce.
    daemon.kill("SIGTERM");
    await sleep(2500);
    daemon = spawn(process.execPath, [DAEMON_BIN], {
      env: {
        ...process.env,
        AGENTOS_HOME: home,
        AGENTOS_PORT: String(PORT),
        AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
        AGENTOS_FAKE_PI: "1",
        AGENTOS_FAKE_BRAIN: "1",
        AGENTOS_FAKE_GATE: "1",
        AGENTOS_FAKE_GIT: "1",
        AGENTOS_NO_MISTAKES_HOME: gateHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const upDeadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < upDeadline && !up) {
      try {
        up = (await fetch(`${BASE}/v1/health`)).ok;
      } catch {
        // not up
      }
      if (!up) await sleep(150);
    }
    await sleep(1500);

    const status = (await get("/v1/pipeline/status")).pipeline;
    await page.goto(`${CONSOLE}/pipeline`, { waitUntil: "networkidle" });
    await sleep(1200);
    const text = (await page.textContent("body")) ?? "";
    gate(
      "G4",
      "schema drift degrades visibly — stated as unreadable, never rendered stale",
      status.compatibility.ok === false &&
        status.compatibility.missingColumns.some((c) => c.includes("findings_json")) &&
        text.includes("Pipeline state unreadable"),
      `compatible=${status.compatibility.ok} missing=${status.compatibility.missingColumns.join(",")} uiStates=${text.includes("Pipeline state unreadable")}`,
    );
  }

  // ── G7 — visibility profiles change BEHAVIOUR, hot-reloaded ───────────
  // Shape checks alone are false confidence. Prove all three profile axes
  // end-to-end: streamPipelineLogs emission, surface filtering on SSE, and
  // wakeOn delivery into the wake history.
  {
    const post = async (path, body) =>
      (
        await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        })
      ).json();
    const tool = (name, input) => post("/v1/tools/call", { tool: name, input });

    /** Collect live SSE frames until predicate or timeout (not durable replay). */
    const readSse = async (until, timeoutMs = 5000) => {
      const controller = new AbortController();
      const response = await fetch(`${BASE}/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const frames = [];
      let buffer = "";
      let pending = null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        pending ??= reader.read();
        const race = await Promise.race([pending, sleep(100).then(() => "timeout")]);
        if (race === "timeout") {
          if (until(frames)) break;
          continue;
        }
        pending = null;
        if (race.done) break;
        buffer += decoder.decode(race.value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              frames.push(JSON.parse(dataLine.slice(6)));
            } catch {
              // ignore malformed frame
            }
          }
          sep = buffer.indexOf("\n\n");
        }
        if (until(frames)) break;
      }
      controller.abort();
      try {
        reader.cancel();
      } catch {
        // ignore
      }
      return frames;
    };

    const setActiveProfile = async (name) => {
      const configPath = join(home, "config", "observability.json5");
      const raw = readFileSync(configPath, "utf8");
      let next = raw.replace(/activeProfile:\s*"[^"]+"/, `activeProfile: "${name}"`);
      if (next === raw) {
        next = raw.replace(/\{\s*\}\s*$/, `{\n  activeProfile: "${name}",\n}\n`);
      }
      if (next === raw && !raw.includes(`activeProfile: "${name}"`)) {
        throw new Error(`G7 could not set activeProfile to ${name}`);
      }
      writeFileSync(configPath, next);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const probe = await get("/v1/config/effective");
        if (probe.config?.observability?.activeProfile === name) return;
        await sleep(250);
      }
      throw new Error(`G7 timed out waiting for activeProfile=${name}`);
    };

    const effective = await get("/v1/config/effective");
    const observability = effective.config?.observability;
    const profiles = Object.keys(observability?.profiles ?? {});
    const quiet = observability?.profiles?.quiet;
    const firehose = observability?.profiles?.firehose;
    // Shipped default must be quiet (depth is opted into). The live active
    // profile may have been switched earlier in this gate; check the profile
    // table and the on-disk shipped file.
    const shippedRaw = readFileSync(
      join(ROOT, "apps", "orchestrator", "defaults", "observability.json5"),
      "utf8",
    );
    const shippedDefaultIsQuiet =
      /activeProfile:\s*"quiet"/.test(shippedRaw) && quiet?.streamPipelineLogs === false;

    await setActiveProfile("quiet");

    // ── axis 1: streamPipelineLogs ─────────────────────────────────────
    const countLogFrames = async () => {
      const replay = await get("/v1/events/replay?types=pipeline.log_appended&limit=10000");
      return (replay.events ?? []).length;
    };
    const beforeQuiet = await countLogFrames();
    const quietMarker = `QUIET-LINE-${Date.now()}`;
    appendFileSync(logPath, `${quietMarker}\n`);
    await sleep(2500);
    const afterQuiet = await countLogFrames();
    const quietBlocks = afterQuiet === beforeQuiet;

    // ── axis 2: surface — SSE under quiet must filter pipeline.* ────────
    // Quiet surfaces task./captain./brain.down/pipeline.unavailable only.
    // A live pipeline.run_updated must not reach the Console SSE path; a
    // captain.escalation must. Collect a fixed window (do not wait for the
    // blocked type — it must never arrive).
    const quietEscalationSummary = `G7-quiet-surface-${Date.now()}`;
    const quietRunId = `01RUNG7QUIET${String(Date.now()).slice(-10)}`;
    const quietSsePromise = readSse(() => false, 4000);
    await sleep(300);
    seedRun(fixtureDb, quietRunId, "phase-x/g7-quiet", [
      { name: "review", status: "running", lastActivity: "g7 quiet surface" },
    ]);
    await tool("escalate_to_captain", {
      summary: quietEscalationSummary,
      severity: "warn",
    });
    const quietFrames = await quietSsePromise;
    const quietSurfacesEscalation = quietFrames.some(
      (f) =>
        f.event?.type === "captain.escalation" &&
        f.event?.payload?.summary === quietEscalationSummary,
    );
    const quietBlocksPipelineSse = !quietFrames.some(
      (f) => f.event?.type === "pipeline.run_updated",
    );
    // Durable store still has the run update — filtering is live-path only.
    const durableHasQuietRun = (
      (await get("/v1/events/replay?types=pipeline.run_updated&limit=200")).events ?? []
    ).some((e) => e.event?.payload?.runId === quietRunId);

    // ── axis 3: wakeOn under quiet ─────────────────────────────────────
    // Matching warn escalation wakes; info does not (noise, not a decision);
    // pipeline.run_updated is not in quiet.wakeOn and must not wake.
    const wakesAfterQuiet = (await get("/v1/wakes")).wakes ?? [];
    const quietWarnWoke = wakesAfterQuiet.some(
      (w) =>
        w.summary === quietEscalationSummary &&
        w.class === "NEEDS_INPUT" &&
        w.absorbed === false,
    );
    const infoSummary = `G7-info-no-wake-${Date.now()}`;
    await tool("notify_captain", { summary: infoSummary, severity: "info" });
    await sleep(300);
    const wakesAfterInfo = (await get("/v1/wakes")).wakes ?? [];
    const infoDidNotWake = !wakesAfterInfo.some((w) => w.summary === infoSummary);
    const pipelineDidNotWake = !wakesAfterQuiet.some(
      (w) =>
        typeof w.detail?.eventType === "string" &&
        w.detail.eventType === "pipeline.run_updated" &&
        w.detail.source === "observability.wakeOn",
    );

    // ── firehose: logs stream + surface admits pipeline.* ──────────────
    await setActiveProfile("firehose");
    const firehoseMarker = `FIREHOSE-LINE-${Date.now()}`;
    appendFileSync(logPath, `${firehoseMarker}\n`);
    const started = Date.now();
    let firehoseStreams = false;
    while (Date.now() - started < 4000) {
      const replay = await get("/v1/events/replay?types=pipeline.log_appended&limit=1000");
      if ((replay.events ?? []).some((e) => (e.event?.payload?.chunk ?? "").includes(firehoseMarker))) {
        firehoseStreams = true;
        break;
      }
      await sleep(100);
    }

    const firehoseRunId = `01RUNG7FIRE${String(Date.now()).slice(-10)}`;
    const firehoseSsePromise = readSse(
      (frames) => frames.some((f) => f.event?.type === "pipeline.run_updated"),
      6000,
    );
    await sleep(200);
    seedRun(fixtureDb, firehoseRunId, "phase-x/g7-firehose", [
      { name: "review", status: "running", lastActivity: "g7 firehose surface" },
    ]);
    const firehoseFrames = await firehoseSsePromise;
    const firehoseSurfacesPipeline = firehoseFrames.some(
      (f) =>
        f.event?.type === "pipeline.run_updated" && f.event?.payload?.runId === firehoseRunId,
    );

    // firehose wakeOn includes pipeline.unavailable — turning watch off raises it.
    const wakesBeforeUnavail = ((await get("/v1/wakes")).wakes ?? []).length;
    const unavailConfigPath = join(home, "config", "observability.json5");
    const unavailRaw = readFileSync(unavailConfigPath, "utf8");
    writeFileSync(
      unavailConfigPath,
      unavailRaw.replace(/watchPipeline:\s*true/, "watchPipeline: false"),
    );
    let firehoseWakeOnUnavailable = false;
    const unavailDeadline = Date.now() + 10_000;
    while (Date.now() < unavailDeadline) {
      const wakes = (await get("/v1/wakes")).wakes ?? [];
      if (
        wakes.length > wakesBeforeUnavail &&
        wakes.some(
          (w) =>
            w.class === "GATE_FAILED" &&
            w.detail?.eventType === "pipeline.unavailable" &&
            w.detail?.source === "observability.wakeOn",
        )
      ) {
        firehoseWakeOnUnavailable = true;
        break;
      }
      await sleep(200);
    }
    // Restore watch so later cleanup is clean.
    writeFileSync(
      unavailConfigPath,
      readFileSync(unavailConfigPath, "utf8").replace(
        /watchPipeline:\s*false/,
        "watchPipeline: true",
      ),
    );
    await sleep(500);

    const reloaded = (await get("/v1/config/effective")).config?.observability?.activeProfile;

    gate(
      "G7",
      "visibility profiles change what reaches the live path and hot-reload",
      profiles.length >= 3 &&
        quiet?.streamPipelineLogs === false &&
        firehose?.streamPipelineLogs === true &&
        shippedDefaultIsQuiet &&
        quietBlocks &&
        firehoseStreams &&
        quietSurfacesEscalation &&
        quietBlocksPipelineSse &&
        durableHasQuietRun &&
        firehoseSurfacesPipeline &&
        quietWarnWoke &&
        infoDidNotWake &&
        pipelineDidNotWake &&
        firehoseWakeOnUnavailable &&
        reloaded === "firehose",
      [
        `profiles=${profiles.join(",")}`,
        `quietBlocks=${quietBlocks}`,
        `firehoseStreams=${firehoseStreams}`,
        `quietSseEscalation=${quietSurfacesEscalation}`,
        `quietSseBlocksPipeline=${quietBlocksPipelineSse}`,
        `durableQuietRun=${durableHasQuietRun}`,
        `firehoseSsePipeline=${firehoseSurfacesPipeline}`,
        `quietWarnWoke=${quietWarnWoke}`,
        `infoDidNotWake=${infoDidNotWake}`,
        `pipelineDidNotWake=${pipelineDidNotWake}`,
        `firehoseWakeOnUnavailable=${firehoseWakeOnUnavailable}`,
        `reloadedTo=${reloaded}`,
      ].join(" "),
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  try {
    await browser?.close();
  } catch {
    // ignore
  }
  try {
    fixtureDb?.close();
  } catch {
    // ignore
  }
  for (const child of [consoleServer, daemon]) {
    try {
      child?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
