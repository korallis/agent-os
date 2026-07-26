#!/usr/bin/env node
/**
 * Phase 10 executable gates (master plan §11 Phase 10, [R7]) — auto-balancer.
 *
 *   G1  toggle off ⇒ inert: no suggestion, no event — genuinely opt-in
 *   G2  a single-family roster is REFUSED at config-write time
 *   G3  balanced casts distribute across the roster instead of pinning one model
 *   G4  cross-family survives balancing; no familyCheckOverride is ever implied
 *   G5  headroom-driven: balances with cost coverage absent, and says so
 *   G6  a LIMIT REACHED connection is never suggested; near-threshold is de-preferred
 *   G7  every decision is recorded with its inputs — "why this model?" is answerable
 *   G8  /opinion and plan-fusion casts keep ≥2 distinct families; side order preserved
 *   G9  balancer and Brain handoff converge — steer first, handoff only when steering fails
 *
 * Real daemon, real config writes, real quota fixtures.
 * Usage: node tooling/gates/phase-10.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p10-${process.pid}`;
const PORT = pickPort(5700, 40);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanups = [];
let exitCode = 0;
let daemon;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p10-home-"));
  cleanups.push(home);

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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 30_000;
  let token = null;
  while (Date.now() < deadline && token === null) {
    try {
      const candidate = readFileSync(join(home, "daemon.token"), "utf8").trim();
      if ((await fetch(`${BASE}/v1/health`)).ok) token = candidate;
    } catch {
      // not up
    }
    if (token === null) await sleep(150);
  }
  if (token === null) throw new Error("daemon did not start");

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async (path) => (await fetch(`${BASE}${path}`, { headers: auth })).json();
  const post = async (path, body) =>
    (await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
  const putRaw = async (path, body) =>
    fetch(`${BASE}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  const tool = (name, input) => post("/v1/tools/call", { tool: name, input });

  /** Seed a connection plus a deterministic window reading for it. */
  const seedProvider = async (provider, usedPct, { limitReached = false } = {}) => {
    mkdirSync(join(home, "fake-quota"), { recursive: true });
    writeFileSync(
      join(home, "fake-quota", `${provider}.json`),
      JSON.stringify([
        {
          kind: "weekly-window-pct",
          value: usedPct,
          unit: "percent",
          tier: "live",
          source: "API KEY",
          syncedAt: new Date().toISOString(),
          reason: limitReached ? "window exhausted" : null,
          resetsAt: null,
          limitReached,
        },
      ]),
    );
    const connection = (
      await post("/v1/connections/api-key", {
        provider,
        apiKey: `p10-${provider}-fixture-not-a-secret`,
        label: `${provider} fixture`,
      })
    ).connection;
    await post(`/v1/connections/${connection.id}/quota/refresh`, {});
    return connection;
  };

  // ── G1 — toggle off is genuinely inert ────────────────────────────────
  {
    await seedProvider("anthropic", 10);
    await seedProvider("openai", 20);
    await sleep(600);

    const before = (await get("/v1/events/replay?types=balancer.suggested&limit=1000")).events ?? [];
    const suggestion = await tool("suggest_cast", { roles: ["builder", "validator"] });
    await sleep(400);
    const after = (await get("/v1/events/replay?types=balancer.suggested&limit=1000")).events ?? [];

    gate(
      "G1",
      "with the toggle off the balancer is inert — no suggestion, no event",
      suggestion.ok === true &&
        suggestion.data?.enabled === false &&
        (suggestion.data?.suggestions ?? []).length === 0 &&
        after.length === before.length,
      `enabled=${suggestion.data?.enabled} suggestions=${(suggestion.data?.suggestions ?? []).length} events ${before.length}→${after.length}`,
    );
  }

  // ── G2 — a single-family roster is refused at write time ──────────────
  {
    const singleFamily = await putRaw("/v1/config/global/balancer", {
      enabled: true,
      roster: [
        { model: "anthropic/claude-sonnet-4-5", brainCapable: true },
        { model: "anthropic/claude-haiku-4-5", brainCapable: false },
      ],
      steerAwayPct: 60,
      useReportedCost: true,
    });
    const body = await singleFamily.json();
    const message = JSON.stringify(body);

    const castable = await putRaw("/v1/config/global/balancer", {
      enabled: true,
      roster: [
        { model: "anthropic/claude-sonnet-4-5", brainCapable: true },
        { model: "openai/gpt-4.1", brainCapable: true },
        { model: "xai/grok-3", brainCapable: false },
      ],
      steerAwayPct: 60,
      useReportedCost: true,
    });

    gate(
      "G2",
      "a single-family roster is refused at write time, a castable one is accepted",
      singleFamily.status === 400 &&
        message.includes("single model family") &&
        castable.ok,
      `singleFamily=${singleFamily.status} castable=${castable.status} reasonStated=${message.includes("single model family")}`,
    );
    await sleep(1500); // let the write hot-reload
  }

  // ── G5 + G7 — headroom-driven, and the decision is recorded ───────────
  {
    const suggestion = await tool("suggest_cast", { roles: ["builder", "validator"] });
    const data = suggestion.data ?? {};
    await sleep(500);
    const events = (await get("/v1/events/replay?types=balancer.suggested&limit=1000")).events ?? [];
    const recorded = events[0]?.event?.payload;

    gate(
      "G5",
      "balances on window headroom and states that cost was not a factor",
      data.enabled === true &&
        data.costUsable === false &&
        String(data.basis).includes("headroom") &&
        String(data.basis).includes("not a factor"),
      `costUsable=${data.costUsable} basis="${data.basis}"`,
    );

    gate(
      "G7",
      "every suggestion is recorded with the candidates and numbers behind it",
      recorded !== undefined &&
        (recorded.suggestions ?? []).length === 2 &&
        (recorded.considered ?? []).length >= 2 &&
        recorded.considered.every((c) => "usedPct" in c && "tier" in c) &&
        (recorded.suggestions ?? []).every((s) => String(s.reason).includes("headroom")),
      `recorded=${recorded !== undefined} suggestions=${(recorded?.suggestions ?? []).length} considered=${(recorded?.considered ?? []).length}`,
    );
  }

  // ── G4 — cross-family survives balancing ──────────────────────────────
  {
    const suggestion = await tool("suggest_cast", { roles: ["builder", "validator"] });
    const suggestions = suggestion.data?.suggestions ?? [];
    const families = new Set(suggestions.map((s) => s.family));

    // The suggested pair must be accepted by the real resolve_cast — which
    // re-derives family server-side — with NO override.
    const project = (
      await post("/v1/projects", { name: "p10", path: fixtureRepo(cleanups), mode: "local-only", trusted: true })
    ).project;
    const task = (
      await post("/v1/tasks", {
        spec: { shape: "SHIP", title: "balanced cast", intent: "gate", projectId: project.id, mode: "local-only", yolo: true },
      })
    ).task;
    const resolved = await tool("resolve_cast", {
      taskId: task.id,
      roles: suggestions.map((s) => ({ role: s.role, model: s.model, thinking: "medium", cleanRoom: true })),
      familyCheckOverride: false,
    });

    gate(
      "G4",
      "a balanced cast is cross-family and accepted with no override",
      suggestions.length === 2 &&
        families.size === 2 &&
        resolved.ok === true,
      `families=${[...families].join(",")} resolveCastOk=${resolved.ok} error=${resolved.error?.code ?? "none"}`,
    );
  }

  // ── G6 — limit reached is never suggested; near-threshold de-preferred ─
  {
    // anthropic exhausted, openai near threshold, xai fresh.
    await seedProvider("anthropic", 100, { limitReached: true });
    await seedProvider("xai", 5);
    const connections = (await get("/v1/connections")).connections ?? [];
    const openai = connections.find((c) => c.provider === "openai");
    writeFileSync(
      join(home, "fake-quota", "openai.json"),
      JSON.stringify([
        {
          kind: "weekly-window-pct",
          value: 75,
          unit: "percent",
          tier: "live",
          source: "API KEY",
          syncedAt: new Date().toISOString(),
          reason: null,
          resetsAt: null,
          limitReached: false,
        },
      ]),
    );
    if (openai !== undefined) await post(`/v1/connections/${openai.id}/quota/refresh`, {});
    await sleep(800);

    const suggestion = await tool("suggest_cast", { roles: ["builder"] });
    const picked = suggestion.data?.suggestions?.[0]?.model ?? "";
    const considered = suggestion.data?.considered ?? [];
    const exhaustedOffered = (suggestion.data?.suggestions ?? []).some((s) =>
      s.model.startsWith("anthropic/"),
    );

    gate(
      "G6",
      "a LIMIT REACHED connection is never suggested and the freshest window wins",
      !exhaustedOffered && picked.startsWith("xai/") && considered.length > 0,
      `picked=${picked} exhaustedOffered=${exhaustedOffered} considered=${considered.length}`,
    );
  }

  // ── G3 — work distributes rather than pinning a single model ──────────
  {
    // Equal headroom across two families: repeated suggestions must not all
    // land on one model just because it sorts first.
    for (const provider of ["openai", "xai"]) {
      writeFileSync(
        join(home, "fake-quota", `${provider}.json`),
        JSON.stringify([
          {
            kind: "weekly-window-pct",
            value: 30,
            unit: "percent",
            tier: "live",
            source: "API KEY",
            syncedAt: new Date().toISOString(),
            reason: null,
            resetsAt: null,
            limitReached: false,
          },
        ]),
      );
    }
    const connections = (await get("/v1/connections")).connections ?? [];
    for (const provider of ["openai", "xai"]) {
      const c = connections.find((x) => x.provider === provider);
      if (c !== undefined) await post(`/v1/connections/${c.id}/quota/refresh`, {});
    }
    await sleep(800);

    const suggestion = await tool("suggest_cast", { roles: ["builder", "validator"] });
    const models = new Set((suggestion.data?.suggestions ?? []).map((s) => s.model));

    gate(
      "G3",
      "a balanced pair spreads across the roster instead of pinning one model",
      models.size === 2,
      `distinctModels=${models.size} models=${[...models].join(",")}`,
    );
  }

  // ── G8 — /opinion and plan-fusion casts preserve ≥2 families + order ──
  {
    const suggestion = await tool("suggest_cast", { roles: ["planner", "planner"] });
    const suggestions = suggestion.data?.suggestions ?? [];
    const families = new Set(suggestions.map((s) => s.family));
    const roles = suggestions.map((s) => s.role);
    const firstPlannerFamily = suggestions[0]?.family ?? null;

    gate(
      "G8",
      "/opinion and plan-fusion casts keep ≥2 distinct families; side order preserved",
      suggestions.length === 2 &&
        families.size >= 2 &&
        roles[0] === "planner" &&
        roles[1] === "planner" &&
        firstPlannerFamily !== null,
      `families=${[...families].join(",")} firstPlannerFamily=${firstPlannerFamily} rolesPreserved=${roles.join(",")}`,
    );
  }

  // ── G9 — balancer and Brain handoff converge, never oscillate ─────────
  {
    const { suggestCast: suggestCastPure } = await import(
      join(ROOT, "apps", "orchestrator", "dist", "fleet", "balancer.js")
    );
    const { decideHandoff: decideHandoffPure } = await import(
      join(ROOT, "apps", "orchestrator", "dist", "fleet", "brain-handoff.js")
    );

    const mkCandidate = (model, provider, family, usedPct) => ({
      model, family, connectionId: `conn-${provider}`, provider, usedPct, tier: "live", limitReached: false, healthy: true,
    });
    const mkSamples = (anthropicPct) => [
      { id: "s1", connectionId: "conn-anthropic", provider: "anthropic", metrics: [{ kind: "weekly-window-pct", value: anthropicPct, unit: "percent", tier: "live", source: "fixture", syncedAt: new Date().toISOString(), reason: null, resetsAt: null, limitReached: false }], sampledAt: new Date().toISOString() },
      { id: "s2", connectionId: "conn-openai", provider: "openai", metrics: [{ kind: "weekly-window-pct", value: 25, unit: "percent", tier: "live", source: "fixture", syncedAt: new Date().toISOString(), reason: null, resetsAt: null, limitReached: false }], sampledAt: new Date().toISOString() },
    ];
    const balancerCfg = {
      enabled: true,
      roster: [
        { model: "anthropic/claude-sonnet-4-5", brainCapable: true },
        { model: "openai/gpt-4.1", brainCapable: true },
      ],
      steerAwayPct: 60,
      useReportedCost: false,
    };
    const brainCfg = {
      cast: "auto", thinking: "medium",
      preferenceOrder: ["anthropic/claude-sonnet-4-5"],
      handoff: { thresholdPct: 80, target: "best-available-other-family" },
      respawnBlocked: false,
    };
    const budgets = { perTaskUsd: 0, claudeExtraUsageDailyUsd: 0, brainTokensPerDay: 0, gatewayHardUsd: 0 };

    // Scenario 1: 70% — over steerAway (60) but under handoff (80).
    // Balancer steers crew to openai; Brain stays because 70 < 80.
    const bal1 = suggestCastPure({
      config: balancerCfg,
      candidates: [
        mkCandidate("anthropic/claude-sonnet-4-5", "anthropic", "anthropic", 70),
        mkCandidate("openai/gpt-4.1", "openai", "openai", 25),
      ],
      roles: ["builder"],
      costUsable: false,
    });
    const ho1 = decideHandoffPure({
      brainModel: "anthropic/claude-sonnet-4-5",
      brainConnectionId: "conn-anthropic",
      config: brainCfg, budgets,
      samples: mkSamples(70),
      candidates: [{ model: "openai/gpt-4.1", worstWindowPct: 25 }],
    });

    const s1Steers = bal1.suggestions[0]?.model === "openai/gpt-4.1";
    const s1NoHandoff = !ho1.shouldHandoff;

    // Scenario 2: 85% — over both thresholds. Both agree: move to openai.
    const bal2 = suggestCastPure({
      config: balancerCfg,
      candidates: [
        mkCandidate("anthropic/claude-sonnet-4-5", "anthropic", "anthropic", 85),
        mkCandidate("openai/gpt-4.1", "openai", "openai", 25),
      ],
      roles: ["builder"],
      costUsable: false,
    });
    const ho2 = decideHandoffPure({
      brainModel: "anthropic/claude-sonnet-4-5",
      brainConnectionId: "conn-anthropic",
      config: brainCfg, budgets,
      samples: mkSamples(85),
      candidates: [{ model: "openai/gpt-4.1", worstWindowPct: 25 }],
    });

    const s2Steers = bal2.suggestions[0]?.model === "openai/gpt-4.1";
    const s2Handoff = ho2.shouldHandoff && ho2.toModel === "openai/gpt-4.1";

    gate(
      "G9",
      "balancer and Brain handoff converge — steer first, handoff only when steering fails",
      s1Steers && s1NoHandoff && s2Steers && s2Handoff,
      `@70%: steers=${s1Steers} noHandoff=${s1NoHandoff}; @85%: steers=${s2Steers} handoff=${s2Handoff} to=${ho2.toModel}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  // Set the code; exit AFTER the finally has torn everything down. Node does
  // not unwind `finally` across process.exit(), so exiting here orphans the
  // daemon on every run — including the passing ones.
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try {
    daemon?.kill("SIGTERM");
  } catch {
    // ignore
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

function fixtureRepo(list) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p10-repo-"));
  list.push(dir);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "p10@agent-os.local");
  git("config", "user.name", "phase10");
  writeFileSync(join(dir, "README.md"), "# p10\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

process.exit(exitCode);
