#!/usr/bin/env node
/**
 * Capture every panel a Captain escalation surfaces in.
 *
 * Boots a real `agentosd`, drives a task to the point where the Brain genuinely
 * escalates (through `escalate_to_captain` on the tool surface, not a seeded
 * row), then screenshots each place that escalation shows up:
 *
 *   /fleet          NEEDS YOU tile + the wake-queue Quick Action
 *   /notifications  tasks parked in NEEDS_CAPTAIN, plus the Brain wake queue
 *   /alerts         the escalation frame itself, via type-filtered replay
 *   /tasks/:id      the amber banner carrying the escalation's own text
 *
 * Usage: node tooling/evidence/capture-escalations.mjs <outputDir>
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "screenshots"));
const DAEMON_PORT = 4700 + 700 + Math.floor(Math.random() * 60);
const CONSOLE_PORT = 3000 + 700 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;
const TMUX_SOCKET = `agentos-esc-${process.pid}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
let daemon;
let consoleServer;
let browser;

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-esc-repo-"));
  cleanups.push(dir);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "esc@agent-os.local");
  git("config", "user.name", "Escalation Capture");
  writeFileSync(join(dir, "README.md"), "# escalation fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

try {
  mkdirSync(OUT, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "agentos-esc-home-"));
  cleanups.push(home);

  daemon = spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(DAEMON_PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(`${BASE}/v1/health`, 30_000);

  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })
    ).json();
  const tool = async (name, input, { expectFailure = false } = {}) => {
    const res = await post("/v1/tools/call", { tool: name, input });
    if (!expectFailure && res.ok !== true) {
      throw new Error(`tool ${name} failed: ${res.error?.code} ${res.error?.message}`);
    }
    return res;
  };
  const setGateOutcome = (outcome) => writeFileSync(join(home, "fake-gate-outcome"), outcome);

  const projectId = (
    await post("/v1/projects", {
      name: "agent-os",
      path: fixtureRepo(),
      mode: "local-only",
      trusted: true,
    })
  ).project.id;

  // Drive a task to a genuine escalation: prove RED, spawn the builder, then
  // let the candidate gate FAIL twice — the real situation where the Brain has
  // to stop and ask the Captain rather than keep burning attempts.
  const taskId = (
    await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title: "Add retry budget to the fetch client",
        intent: "Bound transient network failures without masking real errors",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    })
  ).task.id;

  await tool("resolve_cast", {
    taskId,
    roles: [
      { role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true },
      { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
    ],
    familyCheckOverride: false,
  });
  await tool("author_gate", {
    taskId,
    validatorCast: {
      role: "validator",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      family: "anthropic",
      cleanRoom: true,
    },
  });
  setGateOutcome("EXPECTED_RED");
  await tool("run_gate", { taskId, target: "baseline" });
  await tool("spawn_crewmate", {
    taskId,
    role: "builder",
    model: "openai/gpt-5.6-sol",
    thinking: "medium",
    vars: {},
    redBaselineOverride: false,
  });
  setGateOutcome("FAIL");
  await tool("run_gate", { taskId, target: "candidate" });
  await tool("run_gate", { taskId, target: "candidate" });
  rmSync(join(home, "fake-gate-outcome"), { force: true });

  // The escalation itself — this is what every captured panel is showing.
  await tool("escalate_to_captain", {
    taskId,
    summary:
      "Candidate gate FAILed twice on the same assertion — the retry budget changes the error surface. Need a decision on scope before I spend another attempt.",
    severity: "warn",
  });

  // A second, task-less escalation so the panels show more than one row.
  await tool("notify_captain", {
    summary: "Anthropic weekly window passed 80% — Brain handoff target is configured but idle.",
    severity: "info",
  });

  consoleServer = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(DAEMON_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitFor(`${CONSOLE}/fleet`, 90_000);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const shots = [
    ["panel-escalation-alerts", "/alerts", "Recent Alerts — the escalation frames themselves"],
    ["panel-escalation-notifications", "/notifications", "Needs-you queue + Brain wake queue"],
    ["panel-escalation-fleet", "/fleet", "NEEDS YOU tile and the wake-queue Quick Action"],
    ["panel-escalation-task-detail", `/tasks/${taskId}`, "The banner carrying the escalation text"],
  ];
  for (const [name, path, note] of shots) {
    const res = await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
    await sleep(900);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    console.log(`captured ${name}.png (${path}) status=${res?.status() ?? 0} — ${note}`);
  }
  console.log(`\n${shots.length} screenshots written to ${OUT}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
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
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
