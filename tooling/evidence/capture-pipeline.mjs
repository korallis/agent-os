#!/usr/bin/env node
/**
 * Evidence capture for the live pipeline view (§11 Phase 9).
 *
 * Builds a FIXTURE no-mistakes home to the real schema so the capture never
 * touches the Captain's own gate state, then screenshots the live view in three
 * states: a running run with streaming log output, a run parked on a decision,
 * and the visible degradation when the gate's schema is unreadable.
 *
 * Usage: node tooling/evidence/capture-pipeline.mjs <outputDir>
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "screenshots"));
const PORT = 4700 + 970 + Math.floor(Math.random() * 25);
const CONSOLE_PORT = 3980 + Math.floor(Math.random() * 15);
const SOCK = `agentos-p9ev-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
let daemon, consoleServer, browser, db;

try {
  mkdirSync(OUT, { recursive: true });
  const gateHome = mkdtempSync(join(tmpdir(), "p9ev-gate-"));
  const home = mkdtempSync(join(tmpdir(), "p9ev-home-"));
  cleanups.push(gateHome, home);
  mkdirSync(join(gateHome, "logs"), { recursive: true });
  db = new Database(join(gateHome, "state.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT, branch TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT, status TEXT NOT NULL, pr_url TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, intent TEXT);
    CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL, step_order INTEGER NOT NULL, status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, log_path TEXT, findings_json TEXT, error TEXT, started_at INTEGER, completed_at INTEGER, last_activity_at INTEGER, last_activity TEXT, agent_pid INTEGER, auto_fix_limit INTEGER);`);

  const logPath = join(gateHome, "logs", "review.log");
  writeFileSync(logPath, "");
  const seed = (id, branch, status, steps) => {
    // Real no-mistakes stores unix seconds — keep the evidence fixture honest.
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT OR REPLACE INTO runs (id,repo_id,branch,head_sha,base_sha,status,pr_url,created_at,updated_at,intent) VALUES (?,'r',?,'8c4938f0a1',' ',?,?,?,?,?)`)
      .run(id, branch, status, branch.includes("hardening") ? "https://github.com/korallis/agent-os/pull/12" : null, now, now, "phase intent");
    steps.forEach((st, i) => db.prepare(`INSERT OR REPLACE INTO step_results (id,run_id,step_name,step_order,status,findings_json,log_path,last_activity,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${id}-${st.n}`, id, st.n, i, st.s, st.f ?? null, st.log ?? null, st.a ?? null, st.a ? now : null));
  };

  seed("01EVRUN0000000000000000001", "phase-9/live-pipeline-visibility", "running", [
    { n: "intent", s: "completed" }, { n: "rebase", s: "completed" },
    { n: "review", s: "running", log: logPath, a: "round 1" },
    { n: "test", s: "pending" }, { n: "document", s: "pending" }, { n: "lint", s: "pending" },
    { n: "push", s: "pending" }, { n: "pr", s: "pending" }, { n: "ci", s: "pending" },
  ]);
  seed("01EVRUN0000000000000000002", "phase-8/hardening", "running", [
    { n: "intent", s: "completed" }, { n: "rebase", s: "completed" },
    { n: "review", s: "awaiting_approval", a: "parked",
      f: JSON.stringify([
        { id: "handoff-model-not-durable", severity: "warning", action: "auto-fix", description: "handoffModel is process-local only" },
        { id: "g6-handoff-cooldown-race", severity: "warning", action: "auto-fix", description: "gate can pass in the cooldown branch" },
        { id: "handoff-cooldown-latches", severity: "warning", action: "ask-user", description: "cooldown latches on a failed start" },
      ]) },
    { n: "test", s: "pending" }, { n: "document", s: "pending" }, { n: "ci", s: "pending" },
  ]);

  daemon = spawn(process.execPath, [join(ROOT, "apps/orchestrator/dist/bin/agentosd.js")], {
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT), AGENTOS_TMUX_SOCKET: SOCK,
      AGENTOS_FAKE_PI: "1", AGENTOS_FAKE_BRAIN: "1", AGENTOS_NO_MISTAKES_HOME: gateHome }, stdio: "ignore" });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/v1/health`)).ok) break; } catch {} await sleep(150); }

  consoleServer = spawn(join(ROOT, "apps/console/node_modules/.bin/next"), ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    { cwd: join(ROOT, "apps/console"), env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${CONSOLE_PORT}/pipeline`)).status < 500) break; } catch {} await sleep(300); }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  // Stream real log output so the live pane is not empty.
  for (const line of [
    "[review] scanning 41 changed files",
    "[review] apps/orchestrator/src/pipeline/watcher.ts",
    "[review] apps/console/src/components/pipeline/PipelineView.tsx",
    "[review] 3 findings so far",
  ]) {
    appendFileSync(logPath, `${line}\n`);
    db.prepare("UPDATE step_results SET last_activity=? WHERE run_id=? AND step_name='review'").run(line, "01EVRUN0000000000000000001");
    db.prepare("UPDATE runs SET updated_at=? WHERE id=?").run(Math.floor(Date.now() / 1000), "01EVRUN0000000000000000001");
    await sleep(400);
  }
  await page.goto(`http://127.0.0.1:${CONSOLE_PORT}/pipeline`, { waitUntil: "networkidle" });
  await sleep(2000);
  await page.screenshot({ path: join(OUT, "pipeline-live.png"), fullPage: true });
  console.log("captured pipeline-live.png");

  // Degradation: rename a required column, restart, screenshot.
  db.exec("ALTER TABLE step_results RENAME COLUMN findings_json TO findings_blob");
  daemon.kill("SIGTERM"); await sleep(2500);
  daemon = spawn(process.execPath, [join(ROOT, "apps/orchestrator/dist/bin/agentosd.js")], {
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT), AGENTOS_TMUX_SOCKET: SOCK,
      AGENTOS_FAKE_PI: "1", AGENTOS_FAKE_BRAIN: "1", AGENTOS_NO_MISTAKES_HOME: gateHome }, stdio: "ignore" });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/v1/health`)).ok) break; } catch {} await sleep(150); }
  await sleep(1500);
  await page.goto(`http://127.0.0.1:${CONSOLE_PORT}/pipeline`, { waitUntil: "networkidle" });
  await sleep(1500);
  await page.screenshot({ path: join(OUT, "pipeline-schema-drift.png"), fullPage: true });
  console.log("captured pipeline-schema-drift.png");
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  try { await browser?.close(); } catch {}
  try { db?.close(); } catch {}
  for (const c of [consoleServer, daemon]) { try { c?.kill("SIGTERM"); } catch {} }
  spawnSync("tmux", ["-L", SOCK, "kill-server"]);
  for (const p of cleanups) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
}
