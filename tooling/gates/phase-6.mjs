#!/usr/bin/env node
/**
 * Phase 6 executable gates (master plan §11 Phase 6) — Console completion.
 *
 *   G1  every Console page renders against a seeded daemon (HTTP 200, no error boundary)
 *   G2  Fleet reflects a state change within 1 s of it happening
 *   G3  NO placeholder data survives — the Figma sample values are absent from
 *       the rendered HTML of the pages that used to carry them
 *   G4  Analytics figures equal the daemon's own /v1/analytics numbers
 *   G5  Notifications renders the real wake queue, including absorbed wakes
 *   G6  Task Detail renders the Brain decision lane and validation evidence
 *   G7  quota strip renders from seeded samples and states its honesty tier
 *   G8  empty/error treatments render for an unknown route
 *
 * Real daemon, real Console production build, real browser (Playwright).
 * Usage: node tooling/gates/phase-6.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p6-${process.pid}`;
const DAEMON_PORT = 4700 + 800 + Math.floor(Math.random() * 100);
const CONSOLE_PORT = 3300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Values that appeared in the Figma-derived placeholder markup. If any of these
 * come back in rendered HTML, mock data has returned.
 */
const PLACEHOLDER_STRINGS = [
  "23,094",
  "48.2M",
  "Coder Agent",
  "Writer Agent",
  "API Refactor",
  "Unit Tests",
  "Deploy Script",
  "Auth Middleware",
  "Upgrade to Pro",
  "AI Optimization Tips",
  "Switch to Haiku for QA",
  "Monthly avg:",
  "3,074",
];

const PAGES = [
  "/fleet",
  "/tasks",
  "/projects",
  "/providers",
  "/notifications",
  "/runs",
  "/analytics",
  "/policies",
  "/settings",
  "/onboarding",
];

const cleanups = [];
let daemon;
let consoleServer;

async function waitFor(url, timeoutMs, init = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return;
    } catch {
      // not up
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p6-repo-"));
  cleanups.push(dir);
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "gate@agent-os.local");
  git("config", "user.name", "Agent OS Gate");
  writeFileSync(join(dir, "README.md"), "# p6 fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p6-home-"));
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
  await waitFor(`${BASE}/v1/health`, 20_000);
  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) =>
    (await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
  const tool = (name, input) => post("/v1/tools/call", { tool: name, input });

  // Seed real fleet state.
  const projectId = (
    await post("/v1/projects", {
      name: "p6",
      path: fixtureRepo(),
      mode: "local-only",
      trusted: true,
    })
  ).project.id;

  const setFakeGateOutcome = (outcome) => {
    writeFileSync(join(home, "fake-gate-outcome"), outcome);
  };

  const seedTask = async (title, roles, options = {}) => {
    const created = await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title,
        intent: "phase-6 console fixture",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    });
    const taskId = created.task.id;
    await tool("resolve_cast", { taskId, roles, familyCheckOverride: false });

    // Gate evidence path: author + baseline while still pre-BUILDING, then
    // spawn the builder (worktree) and run candidate outcomes for FAIL/GATE_ERROR.
    if (options.withGateEvidence === true) {
      const validator = roles.find((r) => r.role === "validator") ?? roles[0];
      const family = String(validator.model).split("/")[0] || "openai";
      await tool("author_gate", {
        taskId,
        validatorCast: {
          role: validator.role,
          model: validator.model,
          thinking: validator.thinking,
          family,
          cleanRoom: validator.cleanRoom ?? true,
        },
      });
      setFakeGateOutcome("EXPECTED_RED");
      await tool("run_gate", { taskId, target: "baseline" });
    }

    const first = roles[0];
    await tool("spawn_crewmate", {
      taskId,
      role: first.role,
      model: first.model,
      thinking: first.thinking,
      vars: {},
      // Override only when we did not establish a real RED proof above.
      redBaselineOverride: options.withGateEvidence === true ? false : true,
    });

    if (options.withGateEvidence === true) {
      setFakeGateOutcome("FAIL");
      await tool("run_gate", { taskId, target: "candidate" });
      setFakeGateOutcome("GATE_ERROR");
      await tool("run_gate", { taskId, target: "candidate" });
      try {
        rmSync(join(home, "fake-gate-outcome"), { force: true });
      } catch {
        // ignore
      }
    }
    return taskId;
  };

  const taskATitle = "Console parity task";
  const taskA = await seedTask(
    taskATitle,
    [
      { role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true },
      { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
    ],
    { withGateEvidence: true },
  );
  const taskBTitle = "Second console task";
  const taskB = await seedTask(taskBTitle, [
    { role: "builder", model: "xai/grok-4.5", thinking: "medium", cleanRoom: true },
  ]);
  // Complete a task so analytics tasksDone is a real non-zero figure.
  // Stop the fake-pi crewmate first (sleep 86400 pane) — same pattern as
  // phase-3 G5 — so deliver_task halt does not race a live tmux window.
  const taskBState = await (await fetch(`${BASE}/v1/tasks/${taskB}`, { headers: auth })).json();
  for (const session of taskBState.task?.sessions ?? []) {
    if (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "settled"
    ) {
      await tool("stop_crewmate", {
        sessionId: session.sessionId,
        reason: "phase-6 gate: free task for deliver",
      });
    }
  }
  const delivered = await tool("deliver_task", { taskId: taskB });
  if (delivered.ok !== true || delivered.data?.phase !== "DONE") {
    throw new Error(
      `deliver_task seed failed: ok=${delivered.ok} phase=${delivered.data?.phase} err=${delivered.error?.message ?? ""}`,
    );
  }

  // Fake-pi spawn classifies a PROGRESS wake absorbed by the zero-token watcher.
  const absorbedSummary = `progress on ${taskATitle}`;

  // Seed a real quota sample so G7 cannot pass against the empty-state copy.
  const quotaConnection = (
    await post("/v1/connections/api-key", {
      provider: "openrouter",
      apiKey: "gate-p6-quota-fixture-key-not-a-secret",
      label: "p6-quota-fixture",
    })
  ).connection;
  // POST with content-type application/json requires a body (Fastify rejects empty).
  const quotaRefresh = await (
    await fetch(`${BASE}/v1/connections/${quotaConnection.id}/quota/refresh`, {
      method: "POST",
      headers: auth,
      body: "{}",
    })
  ).json();
  const seededQuotaSample = quotaRefresh.sample;
  const seededQuotaMetric = seededQuotaSample?.metrics?.[0];
  const seededQuotaProvider = seededQuotaSample?.provider ?? "openrouter";
  const seededQuotaTier = seededQuotaMetric?.tier ?? "estimate";
  // UI renders `${tier} · ${source}` under the provider label.
  const seededQuotaTierLabel = `${seededQuotaTier} ·`;

  consoleServer = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(DAEMON_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitFor(`${CONSOLE}/fleet`, 60_000);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // G1 — every page renders
  {
    const statuses = [];
    for (const path of PAGES) {
      const res = await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
      await sleep(400);
      const body = await page.content();
      statuses.push({
        path,
        status: res?.status() ?? 0,
        errorBoundary: body.includes("agentosd is unreachable"),
      });
    }
    const bad = statuses.filter((s) => s.status >= 400 || s.errorBoundary);
    gate(
      "G1",
      "every Console page renders against a seeded daemon",
      bad.length === 0 && consoleErrors.length === 0,
      `pages=${statuses.length} bad=${bad.map((b) => b.path).join(",") || "none"} pageErrors=${consoleErrors.length}`,
    );
  }

  // G3 — no placeholder data survives anywhere
  {
    const found = [];
    for (const path of PAGES) {
      await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
      await sleep(400);
      const html = await page.content();
      for (const needle of PLACEHOLDER_STRINGS) {
        if (html.includes(needle)) found.push(`${path}:${needle}`);
      }
    }
    gate(
      "G3",
      "no Figma placeholder data survives in any rendered page",
      found.length === 0,
      found.length === 0 ? "clean" : `found ${found.slice(0, 4).join(", ")}`,
    );
  }

  // G2 — Fleet reflects a state change within 1 s
  {
    await page.goto(`${CONSOLE}/fleet`, { waitUntil: "networkidle" });
    await sleep(600);
    const before = await page.textContent("body");
    const newTitle = `Reflected ${Date.now().toString().slice(-6)}`;
    await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title: newTitle,
        intent: "reflect check",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    });
    const started = Date.now();
    let reflected = false;
    while (Date.now() - started < 3000) {
      const text = await page.textContent("body");
      if (text !== null && text.includes(newTitle)) {
        reflected = true;
        break;
      }
      await sleep(100);
    }
    const elapsed = Date.now() - started;
    gate(
      "G2",
      "Fleet reflects a new task within 1 s over SSE",
      reflected && elapsed <= 1000,
      `reflected=${reflected} in ${elapsed}ms (before ${String(before ?? "").length} chars)`,
    );
  }

  // G4 — Analytics numbers equal the daemon's own (never bare digits)
  {
    const snapshot = await (await fetch(`${BASE}/v1/analytics`, { headers: auth })).json();
    await page.goto(`${CONSOLE}/analytics`, { waitUntil: "networkidle" });
    await sleep(600);
    const text = (await page.textContent("body")) ?? "";
    const windowDays = snapshot.windowDays ?? 14;
    // Distinctive label+value notes — never assert on a bare digit alone.
    const createdNote = `${snapshot.totals.tasksTotal} created · last ${windowDays}d`;
    const requestsNote = `${snapshot.totals.requests} requests · last ${windowDays}d`;
    const tokensUsed =
      (snapshot.totals.inputTokens ?? 0) + (snapshot.totals.outputTokens ?? 0);
    const tokensRendered =
      tokensUsed >= 1_000_000
        ? `${(tokensUsed / 1_000_000).toFixed(1)}M`
        : tokensUsed >= 1_000
          ? `${(tokensUsed / 1_000).toFixed(1)}K`
          : String(tokensUsed);
    // Seed path must produce a completed task and at least one usage frame.
    const seeded =
      snapshot.totals.tasksDone >= 1 && snapshot.totals.requests >= 1 && tokensUsed > 0;
    const costHonest =
      snapshot.totals.costUsd === null ? text.includes("not reported by providers") : true;
    gate(
      "G4",
      "Analytics renders the daemon's own figures, and states absence honestly",
      seeded &&
        text.includes(createdNote) &&
        text.includes(requestsNote) &&
        text.includes(tokensRendered) &&
        costHonest,
      `createdNote=${createdNote} requestsNote=${requestsNote} tokens=${tokensRendered} tasksDone=${snapshot.totals.tasksDone}`,
    );
  }

  // G5 — Notifications shows the real wake queue including absorbed wakes
  {
    const wakes = await (await fetch(`${BASE}/v1/fleet/wakes`, { headers: auth })).json();
    const absorbedWakes = (wakes.wakes ?? []).filter((w) => w.absorbed);
    const seededAbsorbed = absorbedWakes.find((w) => w.summary === absorbedSummary);
    await page.goto(`${CONSOLE}/notifications`, { waitUntil: "networkidle" });
    await sleep(600);
    const text = (await page.textContent("body")) ?? "";
    // Require the specific absorbed wake's summary AND the "absorbed" marker —
    // never assert on a bare digit count (matches any "0" on the page).
    const summaryPresent = text.includes(absorbedSummary);
    const absorbedMarker = /absorbed/i.test(text);
    gate(
      "G5",
      "Notifications renders a seeded absorbed wake with its summary and absorbed marker",
      seededAbsorbed !== undefined && summaryPresent && absorbedMarker && text.includes("Absorbed (zero-token)"),
      `seeded=${seededAbsorbed !== undefined} summary=${summaryPresent} marker=${absorbedMarker}`,
    );
  }

  // G6 — Task Detail shows Brain decisions + validation evidence (FAIL vs GATE_ERROR)
  {
    await page.goto(`${CONSOLE}/tasks/${taskA}`, { waitUntil: "networkidle" });
    await sleep(800);
    const text = (await page.textContent("body")) ?? "";
    const brain = text.includes("Brain decisions") && text.includes("resolve_cast");
    const evidence = text.includes("Validation evidence");
    const hasFail = text.includes("FAIL");
    const hasGateError = text.includes("GATE_ERROR");
    // FAIL and GATE_ERROR must both appear and be distinguishable (different meaning copy).
    const failMeaning = text.includes("Candidate rejected by the gate");
    const gateErrorMeaning = text.includes("infrastructure error");
    gate(
      "G6",
      "Task Detail renders Brain decisions and validation evidence with FAIL vs GATE_ERROR",
      brain && evidence && hasFail && hasGateError && failMeaning && gateErrorMeaning,
      `brain=${brain} evidence=${evidence} FAIL=${hasFail} GATE_ERROR=${hasGateError}`,
    );
  }

  // G7 — quota strip renders a seeded sample with provider + honesty tier
  {
    const quotaList = await (await fetch(`${BASE}/v1/quota`, { headers: auth })).json();
    const daemonSeeded = (quotaList.samples ?? []).some(
      (s) =>
        s.provider === seededQuotaProvider &&
        (s.metrics ?? []).some((m) => m.tier === seededQuotaTier),
    );
    await page.goto(`${CONSOLE}/analytics`, { waitUntil: "networkidle" });
    await sleep(600);
    const text = (await page.textContent("body")) ?? "";
    // Require the concrete provider next to its tier label — never pass on the
    // empty-state sentence (which previously matched /LIVE/i via "Live quota…").
    const providerPresent = text.includes(seededQuotaProvider);
    const tierAdjacent = text.includes(seededQuotaTierLabel);
    const emptyCopy = text.includes("Quota probes will appear here once providers are connected");
    gate(
      "G7",
      "quota surface renders a seeded sample with provider and honesty tier",
      daemonSeeded &&
        providerPresent &&
        tierAdjacent &&
        !emptyCopy &&
        seededQuotaSample !== undefined &&
        seededQuotaMetric !== undefined,
      `provider=${seededQuotaProvider} tier=${seededQuotaTier} daemon=${daemonSeeded} uiProvider=${providerPresent} uiTier=${tierAdjacent}`,
    );
  }

  // G8 — unknown route renders the shared empty treatment
  {
    const res = await page.goto(`${CONSOLE}/definitely-not-a-route`, {
      waitUntil: "networkidle",
    });
    const text = (await page.textContent("body")) ?? "";
    gate(
      "G8",
      "unknown route renders the shared Not Found treatment",
      (res?.status() ?? 0) === 404 && text.includes("Not found"),
      `status=${res?.status()}`,
    );
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  for (const child of [consoleServer, daemon]) {
    try {
      child?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  await sleep(400);
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
