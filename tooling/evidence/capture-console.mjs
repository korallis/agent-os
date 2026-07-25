#!/usr/bin/env node
/**
 * Console evidence capture — screenshots that prove the shipped screens work.
 *
 * Boots a real `agentosd` on a throwaway home, seeds real fleet state through
 * the daemon's own REST + tool surface (never fixtures written straight to
 * disk), starts the production Console build against it, and screenshots every
 * operational page plus the deep screens that only exist once a task has run.
 *
 * The point is that each capture is of the real product against a real daemon.
 * Only the model is simulated (`AGENTOS_FAKE_PI` / `AGENTOS_FAKE_BRAIN`) — the
 * event log, projections, SSE, tool surface, gate runner, and worktrees are all
 * the shipped code paths.
 *
 * Usage: node tooling/evidence/capture-console.mjs <outputDir>
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "qa", "runs", "console-evidence"));
const DAEMON_PORT = 4700 + 600 + Math.floor(Math.random() * 60);
const CONSOLE_PORT = 3000 + 600 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;
const TMUX_SOCKET = `agentos-evidence-${process.pid}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
const cleanups = [];
let daemon;
let consoleServer;

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** A real git repo so worktree leasing and the SCOUT audit run for real. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-evidence-repo-"));
  cleanups.push(dir);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "evidence@agent-os.local");
  git("config", "user.name", "Agent OS Evidence");
  writeFileSync(join(dir, "README.md"), "# evidence fixture\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const ready = true;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

try {
  mkdirSync(OUT, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "agentos-evidence-home-"));
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
  const get = async (path) => (await fetch(`${BASE}${path}`, { headers: auth })).json();
  /**
   * Tool calls are checked, not fired and forgotten. A silently failed seed
   * would produce screenshots of empty states that look like a broken product.
   */
  const tool = async (name, input, { expectFailure = false } = {}) => {
    const res = await post("/v1/tools/call", { tool: name, input });
    if (expectFailure) return res;
    if (res.ok !== true) {
      throw new Error(
        `tool ${name} failed: ${res.error?.code ?? "?"} ${res.error?.message ?? JSON.stringify(res)}`,
      );
    }
    return res;
  };
  const setGateOutcome = (outcome) => writeFileSync(join(home, "fake-gate-outcome"), outcome);

  // ── Seed real state through the product's own surfaces ────────────────
  const projectId = (
    await post("/v1/projects", {
      name: "agent-os-evidence",
      path: fixtureRepo(),
      mode: "local-only",
      trusted: true,
    })
  ).project.id;

  // resolve_cast takes role assignments WITHOUT a family: the substrate derives
  // family server-side so a client cannot talk its way past the cross-family
  // rule. dispatch_fusion / author_gate take full casts, which do carry it.
  const cast = [
    { role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true },
    { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
  ];

  // Task A — full cross-family validation evidence: RED baseline proved, then a
  // real FAIL and a real GATE_ERROR so the Console shows the two are different.
  const taskA = (
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
  await tool("resolve_cast", { taskId: taskA, roles: cast, familyCheckOverride: false });
  await tool("author_gate", {
    taskId: taskA,
    validatorCast: {
      role: "validator",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      family: "anthropic",
      cleanRoom: true,
    },
  });
  setGateOutcome("EXPECTED_RED");
  await tool("run_gate", { taskId: taskA, target: "baseline" });
  await tool("spawn_crewmate", {
    taskId: taskA,
    role: "builder",
    model: "openai/gpt-5.6-sol",
    thinking: "medium",
    vars: {},
    redBaselineOverride: false,
  });
  setGateOutcome("FAIL");
  await tool("run_gate", { taskId: taskA, target: "candidate" });
  setGateOutcome("GATE_ERROR");
  // Expected to come back not-ok: a GATE_ERROR is an infrastructure fault, and
  // the whole point of this capture is that the Console shows it as distinct
  // from a RED verdict rather than collapsing both into "failed".
  await tool("run_gate", { taskId: taskA, target: "candidate" }, { expectFailure: true });
  rmSync(join(home, "fake-gate-outcome"), { force: true });

  // Task B — a clean-room /fusion run, so the side-by-side columns and the
  // byte-identical-prompt proof have something real to render.
  const taskB = (
    await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title: "Choose the cache eviction strategy",
        intent: "Compare LRU against a segmented policy under our access pattern",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    })
  ).task.id;
  const fusionCasts = [
    {
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      family: "anthropic",
      cleanRoom: true,
    },
    {
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "high",
      family: "openai",
      cleanRoom: true,
    },
  ];
  await tool("resolve_cast", {
    taskId: taskB,
    roles: fusionCasts.map(({ family, ...rest }) => rest),
    familyCheckOverride: false,
  });
  const fusion = await tool("dispatch_fusion", {
    taskId: taskB,
    kind: "opinion",
    instruction: "Which eviction policy fits a workload with a hot 5% and a long tail?",
    casts: fusionCasts,
  });

  // Task C — delivered, so throughput and success rate are real non-zero figures.
  const taskC = (
    await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title: "Document the daemon event contract",
        intent: "Write the event reference from the shipped schemas",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    })
  ).task.id;
  await tool("resolve_cast", {
    taskId: taskC,
    roles: [{ role: "builder", model: "xai/grok-4.5", thinking: "medium", cleanRoom: true }],
    familyCheckOverride: false,
  });
  await tool("spawn_crewmate", {
    taskId: taskC,
    role: "builder",
    model: "xai/grok-4.5",
    thinking: "medium",
    vars: {},
    redBaselineOverride: true,
  });
  const taskCState = await get(`/v1/tasks/${taskC}`);
  for (const session of taskCState.task?.sessions ?? []) {
    if (["running", "starting", "settled"].includes(session.status)) {
      await tool("stop_crewmate", { sessionId: session.sessionId, reason: "evidence: free for deliver" });
    }
  }
  await tool("deliver_task", { taskId: taskC });

  // A real provider connection + a real quota probe, so the quota cards and the
  // billing surface render measured values rather than empty-state copy.
  const connection = (
    await post("/v1/connections/api-key", {
      provider: "openrouter",
      apiKey: "evidence-fixture-key-not-a-secret",
      label: "OpenRouter (evidence fixture)",
    })
  ).connection;
  await fetch(`${BASE}/v1/connections/${connection.id}/quota/refresh`, {
    method: "POST",
    headers: auth,
    body: "{}",
  });

  // An escalation, so the wake queue and Recent Alerts have real rows.
  await tool("escalate_to_captain", {
    taskId: taskA,
    summary: "Candidate gate FAILed twice on the same assertion — need a decision on scope",
    severity: "warn",
  });

  const sessionsList = await get("/v1/sessions");
  const sessionId =
    sessionsList.sessions?.[0]?.sessionId ??
    (await get(`/v1/tasks/${taskA}`)).task?.sessions?.[0]?.sessionId ??
    null;
  const fusionRunId = fusion?.data?.runId ?? null;

  // ── Console against that daemon ───────────────────────────────────────
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

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const capture = async (name, path, note) => {
    const res = await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
    await sleep(900);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shots.push({ name, path, note, status: res?.status() ?? 0 });
    console.log(`captured ${name} (${path}) status=${res?.status() ?? 0}`);
  };

  await capture("fleet-dashboard", "/fleet", "Live fleet: Brain status, active seats, wake queue");
  await capture("tasks", "/tasks", "Task list from the daemon's projection");
  await capture("task-detail-validation", `/tasks/${taskA}`, "Brain decision lane + FAIL vs GATE_ERROR evidence");
  await capture("task-detail-fusion", `/tasks/${taskB}`, "Clean-room /fusion columns with byte-identical prompt proof");
  await capture("projects", "/projects", "Registered projects and trust state");
  await capture("providers", "/providers", "Provider connections with live quota cards");
  await capture("analytics", "/analytics", "Usage, cost coverage, billing surface and Brain overhead");
  await capture("analytics-models", "/analytics/models", "Measured per-model telemetry");
  await capture("runs", "/runs", "Live event stream");
  await capture("runs-history", "/runs/history", "Pipeline run history (FAIL and GATE_ERROR counted apart)");
  await capture("alerts", "/alerts", "Actionable alerts from type-filtered event replay");
  await capture("notifications", "/notifications", "Brain wake queue including zero-token ABSORBED wakes");
  await capture("policies", "/policies", "Layered config with per-key source and diff-from-default marks");
  await capture("settings", "/settings", "Workspace settings");
  await capture("settings-billing", "/settings/billing", "Billing surfaces, measured spend, budget ceilings");
  await capture("onboarding", "/onboarding", "First-run wizard against real Pi detection");
  if (sessionId !== null) {
    await capture("session-detail", `/sessions/${sessionId}`, "Seat model, tmux pane, attach command, agent log");
  }
  // Fusion evidence renders inside Task Detail (the fusion columns above);
  // there is deliberately no standalone /runs/:id screen to capture.

  // Mobile pass on the two screens the Captain reads away from the desk.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const [name, path] of [
    ["fleet-mobile", "/fleet"],
    ["notifications-mobile", "/notifications"],
  ]) {
    await mobile.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
    await sleep(700);
    await mobile.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    shots.push({ name, path, note: "390px", status: 200 });
    console.log(`captured ${name} (${path}) @390px`);
  }

  await browser.close();

  const manifest = {
    capturedAgainst: { daemonPort: DAEMON_PORT, consolePort: CONSOLE_PORT },
    seeded: { projectId, taskA, taskB, taskC, sessionId, fusionRunId, connectionId: connection.id },
    shots,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${shots.length} screenshots written to ${OUT}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
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
