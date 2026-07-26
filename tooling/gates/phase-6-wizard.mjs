#!/usr/bin/env node
/**
 * Provider wizard E2E + extra-usage labelling (master plan §11 Phase 6, [R2]).
 *
 *   W1  a `pi-api-key` connection completes the wizard end-to-end
 *   W2  a fixture `pi-oauth` connection completes it too, on a different path
 *   W3  the wizard resumes at the same step after a daemon restart [R6]
 *   W4  extra-usage billing is labelled consistently on the provider card, the
 *       billing screen and analytics — and absent everywhere when none bills that way
 *
 * Its own file for the same reason the terminal gate is: this drives a wizard
 * from a genuinely fresh home and restarts the daemon mid-flow, which does not
 * compose with the shared Console gate run.
 *
 * Usage: node tooling/gates/phase-6-wizard.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p6w-${process.pid}`;
const PORT = 4700 + 1200 + Math.floor(Math.random() * 40);
const CONSOLE_PORT = 3200 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;

/**
 * Connection-driven honesty labels only — not budget-ceiling copy such as
 * "Claude extra-usage daily", which always renders when budgets load.
 */
const EXTRA_USAGE_LABEL =
  /EXTRA USAGE\s*[—–-]\s*PER[- ]TOKEN(?:\s+BILLING)?|Extra usage \(per token\)/;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
const cleanups = [];
let daemon;
let consoleServer;
let browser;

function startDaemon(home) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealthy(home, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
      if ((await fetch(`${BASE}/v1/health`)).ok) return token;
    } catch {
      // not up
    }
    await sleep(150);
  }
  throw new Error("daemon did not come up");
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p6w-repo-"));
  cleanups.push(dir);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "p6w@agent-os.local");
  git("config", "user.name", "phase6w");
  writeFileSync(join(dir, "README.md"), "# p6w\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

function openrouterVerified(state) {
  const row = (state.providers ?? []).find((p) => p.provider === "openrouter");
  if (row === undefined) return null;
  return { selected: row.selected === true, authVerified: row.authVerified === true };
}

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p6w-home-"));
  cleanups.push(home);
  daemon = startDaemon(home);
  let token = await waitHealthy(home);

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const get = async (path) => {
    const res = await fetch(`${BASE}${path}`, { headers: auth() });
    const body = await res.json();
    return { status: res.status, ok: res.ok, body };
  };
  const post = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, ok: res.ok, body: json };
  };

  // ── W1 — api-key path completes the wizard ────────────────────────────
  {
    const beforeRes = await get("/v1/onboarding");
    const before = beforeRes.body.state;
    const connectionRes = await post("/v1/connections/api-key", {
      provider: "openrouter",
      apiKey: "p6w-api-key-fixture-not-a-secret",
      label: "OpenRouter (api key)",
    });
    const connection = connectionRes.body.connection;
    await post(`/v1/connections/${connection.id}/quota/refresh`, {});
    // The wizard advances by ACTION, not by naming a step — driving it the way
    // the Console does is the whole point of an E2E gate. Each action must
    // succeed; a 400 on enable-probes must not be papered over by a lucky step.
    const actions = [
      { action: "refresh-doctor" },
      { action: "set-providers", providers: ["openrouter"] },
      { action: "verify-auth", provider: "openrouter" },
      { action: "enable-probes" },
    ];
    const actionResults = [];
    for (const payload of actions) {
      const res = await post("/v1/onboarding", payload);
      actionResults.push({
        action: payload.action,
        status: res.status,
        step: res.body?.state?.step,
        error: res.body?.error?.code ?? res.body?.error?.message ?? null,
      });
    }
    const afterRes = await get("/v1/onboarding");
    const after = afterRes.body.state;
    const actionsOk = actionResults.every(
      (r) => r.status < 400 && r.step !== undefined && r.error === null,
    );
    gate(
      "W1",
      "a pi-api-key connection carries the wizard from doctor through probes",
      connection?.kind === "pi-api-key" &&
        actionsOk &&
        before.step !== after.step &&
        ["probes", "complete"].includes(after.step),
      `kind=${connection?.kind ?? "none"} step ${before.step} → ${after.step} actions=${actionResults
        .map((r) => `${r.action}:${r.status}/${r.step ?? r.error ?? "?"}`)
        .join(",")}`,
    );
  }

  // ── W3 — the wizard resumes at the same step after a daemon restart ────
  {
    const beforeRestartRes = await get("/v1/onboarding");
    const beforeRestart = beforeRestartRes.body.state;
    const beforeOr = openrouterVerified(beforeRestart);
    daemon.kill("SIGTERM");
    await sleep(2500);
    daemon = startDaemon(home);
    token = await waitHealthy(home);
    const afterRestartRes = await get("/v1/onboarding");
    const afterRestart = afterRestartRes.body.state;
    const afterOr = openrouterVerified(afterRestart);
    const verificationsIntact =
      beforeOr !== null &&
      afterOr !== null &&
      beforeOr.selected === afterOr.selected &&
      beforeOr.authVerified === afterOr.authVerified &&
      afterOr.selected === true &&
      afterOr.authVerified === true;
    gate(
      "W3",
      "the wizard resumes at the same step after a daemon restart, with prior verifications intact",
      beforeRestart.step === afterRestart.step && verificationsIntact,
      `${beforeRestart.step} → ${afterRestart.step} openrouter selected/authVerified ${beforeOr?.selected}/${beforeOr?.authVerified} → ${afterOr?.selected}/${afterOr?.authVerified}`,
    );
  }

  // Console is needed for the honesty-label checks (both directions of W4).
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
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        up = (await fetch(`${CONSOLE}/providers`)).status < 500;
      } catch {
        // not up
      }
      if (!up) await sleep(300);
    }
    if (!up) throw new Error("console did not start");
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  async function labelledSurfaces() {
    const seenOn = [];
    for (const [label, path] of [
      ["providers", "/providers"],
      ["billing", "/settings/billing"],
      ["analytics", "/analytics"],
    ]) {
      await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
      await sleep(900);
      const text = (await page.textContent("body")) ?? "";
      if (EXTRA_USAGE_LABEL.test(text)) seenOn.push(label);
    }
    return seenOn;
  }

  // ── W4 (direction A) — labels absent when nothing bills extra-usage ───
  // Only the openrouter api-key connection exists so far; no surface should
  // invent connection-driven extra-usage wording (budget ceilings may still
  // mention "extra-usage" and must not count).
  const absentBeforeOauth = await labelledSurfaces();
  const absentOk = absentBeforeOauth.length === 0;

  // ── W2 — an OAuth-shaped connection takes a different, valid path ──────
  {
    // A fixture OAuth connection: no key file, credentials come from the Pi
    // auth store, so this exercises the branch the api-key path never touches.
    const started = await post("/v1/connections/oauth/start", { provider: "anthropic" });
    const connectionsRes = await get("/v1/connections");
    const connections = connectionsRes.body.connections ?? [];
    // Host auth-store sync may already have other pi-oauth cards (e.g. xai).
    // W2 must assert the fixture we just created, not the first oauth row.
    const oauth = connections.find(
      (c) => c.kind === "pi-oauth" && c.provider === "anthropic",
    );
    gate(
      "W2",
      "a fixture pi-oauth connection is created through the attach-command path",
      started.body.attachCommand !== undefined &&
        oauth !== undefined &&
        oauth.billingSurface === "extra-usage-per-token",
      `attachCommand=${started.body.attachCommand !== undefined} oauthConnection=${oauth !== undefined} provider=${oauth?.provider ?? "none"} kind=${oauth?.kind ?? "none"} billingSurface=${oauth?.billingSurface ?? "none"}`,
    );
  }

  // ── W4 (direction B) — labels on all three surfaces when one bills ─────
  {
    const connectionsRes = await get("/v1/connections");
    const connections = connectionsRes.body.connections ?? [];
    const extraUsage = connections.find((c) => c.billingSurface === "extra-usage-per-token");

    // Analytics only renders surface labels once usage is attributed. Seed a
    // single fake-pi spawn on anthropic so the connection-driven wording can
    // appear — without inventing budget-ceiling matches.
    if (extraUsage !== undefined) {
      const projectRes = await post("/v1/projects", {
        name: "p6w",
        path: fixtureRepo(),
        mode: "local-only",
        trusted: true,
      });
      const projectId = projectRes.body.project?.id;
      const taskRes = await post("/v1/tasks", {
        spec: {
          shape: "SHIP",
          title: "W4 extra-usage label fixture",
          intent: "seed anthropic usage for honesty labels",
          projectId,
          mode: "local-only",
          yolo: true,
        },
      });
      const taskId = taskRes.body.task?.id;
      if (taskId !== undefined) {
        await post("/v1/tools/call", {
          tool: "resolve_cast",
          input: {
            taskId,
            roles: [
              {
                role: "builder",
                model: "anthropic/claude-sonnet-4-5",
                thinking: "medium",
                cleanRoom: true,
              },
            ],
            familyCheckOverride: true,
          },
        });
        await post("/v1/tools/call", {
          tool: "spawn_crewmate",
          input: {
            taskId,
            role: "builder",
            model: "anthropic/claude-sonnet-4-5",
            thinking: "medium",
            vars: {},
            redBaselineOverride: true,
          },
        });
        await sleep(1500);
      }
    }

    const seenOn = await labelledSurfaces();
    const presentOk =
      extraUsage !== undefined &&
      seenOn.includes("providers") &&
      seenOn.includes("billing") &&
      seenOn.includes("analytics");

    gate(
      "W4",
      "extra-usage billing is labelled consistently across card, billing and analytics — and nowhere when nothing bills that way",
      absentOk && presentOk,
      `absentBefore=[${absentBeforeOauth.join(",")}] extraUsageConnection=${extraUsage !== undefined} labelledOn=[${seenOn.join(",")}]`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  // Set the code; exit AFTER the finally block has torn everything down.
  // process.exit() does not unwind `finally`, so exiting here would orphan the
  // daemon, the tmux server and the temp homes on every single run — including
  // the successful ones.
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
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
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.exit(exitCode);
