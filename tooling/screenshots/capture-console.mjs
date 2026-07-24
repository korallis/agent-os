#!/usr/bin/env node
/**
 * Capture Console screenshots against a REAL running stack.
 *
 * Boots a real agentosd on a scratch home, seeds a real git project and a few
 * tasks through the tool surface, serves the production Console build, and
 * screenshots every page. The images are evidence for the PR: they show the
 * product working, not a mockup.
 *
 * Only the model is simulated (`AGENTOS_FAKE_PI` / `AGENTOS_FAKE_BRAIN`) —
 * a screenshot run must not spend a subscription.
 *
 * Usage: node tooling/screenshots/capture-console.mjs [outDir]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = resolve(process.argv[2] ?? join(ROOT, "docs", "screenshots"));
const DAEMON_PORT = Number(process.env.SHOT_DAEMON_PORT ?? 4712);
const CONSOLE_PORT = Number(process.env.SHOT_CONSOLE_PORT ?? 3112);
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const CONSOLE_BASE = `http://127.0.0.1:${CONSOLE_PORT}`;
const TMUX_SOCKET = `agentos-shots-${process.pid}`;

const PAGES = [
  { path: "/fleet", name: "01-fleet-dashboard" },
  { path: "/tasks", name: "02-tasks-board" },
  { path: "/projects", name: "03-projects" },
  { path: "/providers", name: "04-providers-quota" },
  { path: "/runs", name: "05-runs-live-log" },
  { path: "/analytics", name: "06-analytics" },
  { path: "/policies", name: "07-policies" },
  { path: "/settings", name: "08-settings" },
  { path: "/onboarding", name: "09-onboarding-wizard" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
let daemon;
let consoleServer;

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function fixtureRepo() {
  const dir = temp("agentos-shot-repo-");
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "captain@agent-os.local");
  git("config", "user.name", "Captain");
  writeFileSync(join(dir, "README.md"), "# agent-os demo project\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

async function waitFor(url, timeoutMs, init = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  const home = temp("agentos-shot-home-");
  mkdirSync(OUT_DIR, { recursive: true });

  daemon = spawn(process.execPath, [join(ROOT, "apps/orchestrator/dist/bin/agentosd.js")], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(DAEMON_PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(`${DAEMON_BASE}/v1/health`, 20_000);
  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const post = async (path, body) => {
    const res = await fetch(`${DAEMON_BASE}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const tool = (name, input) => post("/v1/tools/call", { tool: name, input });

  // Seed a real project + a few tasks so the pages show live fleet state.
  const project = await post("/v1/projects", {
    name: "agent-os",
    path: fixtureRepo(),
    mode: "local-only",
    trusted: true,
  });
  const projectId = project.project.id;

  const seed = async (spec, roles, opts = {}) => {
    const created = await post("/v1/tasks", { spec: { ...spec, projectId } });
    const taskId = created.task.id;
    await tool("resolve_cast", { taskId, roles, familyCheckOverride: false });
    if (opts.spawn !== false) {
      const first = roles[0];
      await tool("spawn_crewmate", {
        taskId,
        role: first.role,
        model: first.model,
        thinking: first.thinking,
        vars: {},
      });
    }
    if (opts.deliver === true) await tool("deliver_task", { taskId });
    return taskId;
  };

  await seed(
    {
      shape: "SHIP",
      title: "Add quota card grid to Providers",
      intent: "Render the live quota grid per the Figma spec.",
      mode: "local-only",
      yolo: true,
    },
    [
      { role: "builder", model: "openai/gpt-5.6-sol", thinking: "high", cleanRoom: true },
      { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
    ],
  );
  await seed(
    {
      shape: "SCOUT",
      title: "Survey the event-store hot path",
      intent: "Read-only survey of NDJSON replay cost at 100k events.",
      mode: "local-only",
    },
    [{ role: "scout", model: "anthropic/claude-fable-5", thinking: "medium", cleanRoom: true }],
  );
  await seed(
    {
      shape: "SHIP",
      title: "Wire ticketed terminal attach",
      intent: "Single-use ticket for PTY attach from the Console.",
      mode: "local-only",
      yolo: false,
    },
    [{ role: "builder", model: "xai/grok-4.5", thinking: "medium", cleanRoom: true }],
    { deliver: true },
  );

  consoleServer = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(DAEMON_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitFor(`${CONSOLE_BASE}/fleet`, 40_000);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  const captured = [];
  for (const target of PAGES) {
    const response = await page.goto(`${CONSOLE_BASE}${target.path}`, {
      waitUntil: "networkidle",
    });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`${target.path} returned HTTP ${status}`);
    }
    // Let SSE-driven panels take their first frame and reveals settle.
    await sleep(1200);
    const file = join(OUT_DIR, `${target.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    captured.push({ path: target.path, status, file });
    console.log(`captured ${target.path} → ${file} (HTTP ${status})`);
  }

  await browser.close();
  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), pages: captured }, null, 2)}\n`,
  );
  console.log(`\n${captured.length} screenshots written to ${OUT_DIR}`);
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of [consoleServer, daemon]) {
    try {
      child?.kill("SIGTERM");
    } catch {
      // best-effort
    }
  }
  await sleep(400);
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
