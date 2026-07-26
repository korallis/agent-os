#!/usr/bin/env node
/**
 * Phase 8 executable gates (master plan §11 Phase 8) — hardening, /afk & /stow,
 * analytics, packaging.
 *
 *   G1  /afk answers only what the Captain pre-decided; anything else escalates
 *   G2  analytics reconcile ±0 incl. billing-surface and Brain-token breakdowns
 *   G3  soak: no lost events, no duplicate transitions, no unbounded growth
 *   G4  a seeded secret canary is absent from everything durable
 *   G5  fresh machine: clean home → dashboard + first local-only task, fast
 *   G6  Brain handoff past the budget threshold, into a NEW session
 *   G7  `config doctor` lists drift; upgrade never overwrites a customized template
 *   G8  signed self-update: bad signature refused, good applied, rollback works
 *   G9  WCAG: no critical/serious axe violations on the operational pages
 *
 * A real daemon on a real home throughout; only the model is simulated.
 * Usage: node tooling/gates/phase-8.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPort } from "./lib/ports.mjs";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p8-${process.pid}`;
// Non-overlapping with phase-6 (daemon 5500–5599 / console 3300–3499) so
// concurrent local or matrix runs cannot collide on bind ports.
const PORT = pickPort(5700, 60);
// G5's fresh machine needs its own daemon AND its own console. `PORT + 1` used
// to serve for the daemon, which quietly re-derived a port outside pickPort and
// could land on a port another run had already drawn; both fresh ports now come
// from pickPort on ranges that do not overlap the primary pair.
const FRESH_PORT = pickPort(5800, 60);
// 4000–4059 contains 4045 (lockd), which Chromium refuses to navigate to.
const CONSOLE_PORT = pickPort(4000, 60);
const FRESH_CONSOLE_PORT = pickPort(4100, 60);
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;
const FRESH_CONSOLE = `http://127.0.0.1:${FRESH_CONSOLE_PORT}`;

/** Every config domain a fresh home must self-provision on first boot. */
const CONFIG_DOMAINS = [
  "supervision",
  "policies",
  "console",
  "quota",
  "brain",
  "worktrees",
  "projects",
  "dispatch",
  "validation",
  "budgets",
];

/**
 * Text a console page renders when it could not reach agentosd. "Reaches a
 * live dashboard" is only proved when none of these are on the page: the shell
 * renders identically whether the daemon answered or not.
 */
const DAEMON_UNREACHABLE_MARKERS = [
  "could not be reached",
  "could not be loaded from the daemon",
  "is not reachable",
  "daemon token not found",
];

/** Planted in a provider key; must never appear in anything durable. */
const CANARY = "AGENTOS-CANARY-8f21c47d9b0e4a6f-DO-NOT-PERSIST";

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(home, port) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
      const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok && (await res.json()).daemon?.home === home) return token;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`daemon did not come up on ${port}`);
}

/** True when nothing is currently listening on 127.0.0.1:port. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Start the built console bound to one daemon home/port.
 *
 * Refuses to spawn onto an occupied port. Gates draw ports at random, and
 * orphaned `next start` servers from earlier runs do survive on developer
 * machines. When one squats the drawn port, `next` fails to bind and every
 * later probe silently talks to the STRANGER's console — which is bound to a
 * different home, so the run reports `bffLive=false` / `realData=false` on a
 * perfectly healthy build. That is a red pointing at the product for an
 * infrastructure cause: the same class of defect `lib/ports.mjs` exists to
 * prevent, and it was observed on this gate before this check was added.
 *
 * Returns a reason instead of throwing so the owning gate reports FAIL with a
 * diagnosis rather than aborting the whole run.
 */
async function startConsole(home, daemonPort, consolePort) {
  if (!(await portFree(consolePort))) {
    return {
      child: undefined,
      ok: false,
      reason: `console port ${consolePort} was already in use (orphaned gate server?)`,
    };
  }
  const child = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(consolePort), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(daemonPort) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = await waitForConsole(`http://127.0.0.1:${consolePort}`);
  return { child, ok: ready.ok, reason: ready.reason };
}

async function waitForConsole(base, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let reason = "no response before the deadline";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/fleet`);
      if (res.status < 500) return { ok: true, reason: null };
      reason = `console answered ${res.status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  return { ok: false, reason };
}

/** Visible text of a rendered page, whitespace-collapsed. */
async function pageText(page) {
  return (await page.evaluate(() => document.body.innerText ?? "")).replace(/\s+/g, " ");
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

function fixtureRepo(cleanups) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p8-repo-"));
  cleanups.push(dir);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "p8@agent-os.local");
  git("config", "user.name", "phase8");
  writeFileSync(join(dir, "README.md"), "# p8\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

let exitCode = 0;
const cleanups = [];
let daemon;
let freshDaemon;
let consoleServer;
let freshConsoleServer;
let browser;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p8-home-"));
  cleanups.push(home);
  daemon = startDaemon(home, PORT);
  const token = await waitForHealth(home, PORT);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })
    ).json();
  const get = async (path) => (await fetch(`${BASE}${path}`, { headers: auth })).json();
  const tool = (name, input) => post("/v1/tools/call", { tool: name, input });

  const projectId = (
    await post("/v1/projects", {
      name: "p8",
      path: fixtureRepo(cleanups),
      mode: "local-only",
      trusted: true,
    })
  ).project.id;

  const seedTask = async (title) => {
    const created = await post("/v1/tasks", {
      spec: { shape: "SHIP", title, intent: "phase-8 gate fixture", projectId, mode: "local-only", yolo: true },
    });
    return created.task.id;
  };

  // ── G1 — /afk answers only what the Captain pre-decided ────────────────
  {
    const armed = await post("/v1/afk", {
      armed: true,
      faq: [
        {
          match: ["bump", "dependency"],
          answer: "Yes — patch and minor dependency bumps are pre-approved.",
          rationale: "Captain pre-approved routine dependency bumps",
        },
      ],
    });

    const matchedTask = await seedTask("AFK matched question");
    const matched = await tool("escalate_to_captain", {
      taskId: matchedTask,
      summary: "OK to bump the zod dependency from 4.1 to 4.2?",
      severity: "info",
    });
    const matchedState = await get(`/v1/tasks/${matchedTask}`);

    const unmatchedTask = await seedTask("AFK unmatched question");
    await tool("escalate_to_captain", {
      taskId: unmatchedTask,
      summary: "Should I drop the production events table to fix the migration?",
      severity: "warn",
    });
    const unmatchedState = await get(`/v1/tasks/${unmatchedTask}`);

    // The pair is the whole gate: auto-answering everything would pass a test
    // that only checked the matched case, and would be the worst possible bug.
    const answeredMatched = matched.data?.autoAnswered === true;
    const matchedStillMoving = matchedState.task?.phase !== "NEEDS_CAPTAIN";
    const unmatchedEscalated = unmatchedState.task?.phase === "NEEDS_CAPTAIN";

    const afkState = await get("/v1/afk");
    gate(
      "G1",
      "/afk answers only recorded FAQ; anything else still escalates and waits",
      armed.active === true &&
        answeredMatched &&
        matchedStillMoving &&
        unmatchedEscalated &&
        afkState.afk?.answered === 1 &&
        afkState.afk?.escalated === 1,
      `answered=${answeredMatched} matchedPhase=${matchedState.task?.phase} unmatchedPhase=${unmatchedState.task?.phase} counts=${afkState.afk?.answered}/${afkState.afk?.escalated}`,
    );
    await post("/v1/afk", { armed: false });
  }

  // ── G2 — analytics reconcile ±0 across every breakdown ─────────────────
  {
    // Real usage: spawn seats so the extension reports ext.usage frames.
    const usageTask = await seedTask("Analytics reconcile fixture");
    await tool("resolve_cast", {
      taskId: usageTask,
      roles: [{ role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    await tool("spawn_crewmate", {
      taskId: usageTask,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
      redBaselineOverride: true,
    });
    await sleep(1500);

    const snapshot = await get("/v1/analytics?days=14");
    const a = snapshot;
    const sum = (rows) => ({
      input: rows.reduce((x, r) => x + r.inputTokens, 0),
      output: rows.reduce((x, r) => x + r.outputTokens, 0),
    });
    const surfaces = sum(a.billingSurfaces ?? []);
    const brainPlusCrew = {
      input: (a.brain?.brainInputTokens ?? 0) + (a.brain?.crewInputTokens ?? 0),
      output: (a.brain?.brainOutputTokens ?? 0) + (a.brain?.crewOutputTokens ?? 0),
    };

    // Assert independently as well as trusting the daemon's own reconcile flag,
    // so a bug that also breaks the flag cannot pass this gate.
    const surfacesMatch =
      surfaces.input === a.totals.inputTokens && surfaces.output === a.totals.outputTokens;
    const brainMatch =
      brainPlusCrew.input === a.totals.inputTokens &&
      brainPlusCrew.output === a.totals.outputTokens;
    const nonZero = a.totals.inputTokens + a.totals.outputTokens > 0;

    gate(
      "G2",
      "analytics reconcile ±0 incl. billing-surface and Brain-token breakdowns",
      nonZero &&
        a.reconcile?.exact === true &&
        surfacesMatch &&
        brainMatch &&
        a.reconcile.billingSurfacesMatchTotals === true &&
        a.reconcile.brainPlusCrewMatchTotals === true,
      `totals=${a.totals.inputTokens}/${a.totals.outputTokens} surfaces=${surfaces.input}/${surfaces.output} brain+crew=${brainPlusCrew.input}/${brainPlusCrew.output} exact=${a.reconcile?.exact}`,
    );
  }

  // ── G3 — soak: no lost events, no duplicate transitions, bounded growth ─
  {
    // A scaled stand-in for the 24-h soak: the same invariants, driven hard
    // enough to expose them, in a runtime a gate can actually enforce.
    //
    // Every cycle SPAWNS before it cancels. That is the whole point: a task
    // that is only created and cancelled never takes a worktree lease and never
    // classifies a wake, so lease and wake accounting have nothing to count and
    // a leak or a dropped wake cannot move them. Spawning drives the pool
    // (poolSize 4) and the watcher for real, so one stranded lease exhausts the
    // pool within a handful of cycles and one lost wake shows up as a missing
    // durable frame.
    const CYCLES = 24;
    const CREW = {
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
    };
    const before = await get("/v1/status");
    const startSeq = before.events.lastSeq;

    const soakTasks = [];
    const spawnFailures = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const id = await seedTask(`soak ${i}`);
      soakTasks.push(id);
      await tool("resolve_cast", {
        taskId: id,
        roles: [{ ...CREW, cleanRoom: true }],
        familyCheckOverride: false,
      });
      const spawned = await tool("spawn_crewmate", {
        taskId: id,
        ...CREW,
        vars: {},
        redBaselineOverride: true,
      });
      if (spawned.ok !== true) {
        spawnFailures.push(`${i}:${spawned.error?.code ?? "UNKNOWN"}`);
      }
      await tool("cancel_task", { taskId: id, reason: "soak cycle" });
    }
    await sleep(1500);

    const after = await get("/v1/status");
    // Every appended event got a sequence number: none lost, none reused.
    const seqAdvanced = after.events.lastSeq > startSeq;
    const countMatchesSeq = after.events.count === after.events.lastSeq;

    // No duplicate phase transitions: one CANCELLED per soak task, never two.
    const replay = await get("/v1/events/replay?types=task.phase_changed&limit=10000");
    const frames = replay.events ?? [];
    const cancelsPerTask = new Map();
    const seqSeen = new Set();
    let seqReused = 0;
    for (const envelope of frames) {
      if (typeof envelope.seq === "number") {
        if (seqSeen.has(envelope.seq)) seqReused += 1;
        seqSeen.add(envelope.seq);
      }
      const event = envelope.event ?? envelope;
      if (event.type !== "task.phase_changed") continue;
      if (event.payload.to !== "CANCELLED") continue;
      const id = event.payload.taskId;
      cancelsPerTask.set(id, (cancelsPerTask.get(id) ?? 0) + 1);
    }
    const dupes = soakTasks.filter((id) => (cancelsPerTask.get(id) ?? 0) > 1);
    const allCancelled = soakTasks.every((id) => (cancelsPerTask.get(id) ?? 0) === 1);

    // No lost wakes: the fake-Pi spawn classifies exactly one PROGRESS and one
    // AGENT_SETTLED per cycle. Count the durable frames per class rather than
    // the total, so an extra SESSION_LOST from pane reconcile cannot mask a
    // wake that never made it into the log.
    const soakSet = new Set(soakTasks);
    const wakeReplay = await get("/v1/events/replay?types=wake.classified&limit=10000");
    const soakWakes = (wakeReplay.events ?? [])
      .map((e) => e.event ?? e)
      .filter((e) => soakSet.has(e.payload.taskId));
    const wakeIds = new Set(soakWakes.map((e) => e.payload.wakeId));
    const perClass = (cls) => soakWakes.filter((e) => e.payload.class === cls).length;
    const wakesExact =
      perClass("PROGRESS") === CYCLES &&
      perClass("AGENT_SETTLED") === CYCLES &&
      wakeIds.size === soakWakes.length;
    // The watcher's in-memory history and the durable log must agree — a wake
    // present in one and not the other IS a lost event.
    const historyIds = new Set(((await get("/v1/wakes")).wakes ?? []).map((w) => w.id));
    const wakesMirrored = [...wakeIds].every((id) => historyIds.has(id));

    // Bounded growth. Read the leases without a `?? []` default: if the fleet
    // state ever stops carrying `worktrees`, that is a shape regression the
    // gate must fail on, not silently substitute an empty array for.
    const state = await get("/v1/fleet/state");
    const leases = state.state?.worktrees;
    const shapeOk = Array.isArray(leases);
    const leaked = shapeOk
      ? leases.filter((w) => w.taskId !== null && soakSet.has(w.taskId))
      : [];
    // A released tree drops its taskId, so dangling-taskId alone cannot see a
    // tree stranded OUT of the pool. The pool cap is the real bound: after
    // `CYCLES` leases the pool must still be within poolSize, nothing may have
    // quarantined, and no spawn may have been refused for exhaustion.
    const poolSize = (await get("/v1/config/effective")).config?.worktrees?.poolSize;
    const quarantined = shapeOk ? leases.filter((w) => w.state === "quarantined") : [];
    const boundedPool =
      shapeOk && typeof poolSize === "number" && poolSize > 0 && leases.length <= poolSize;
    // Its own statement rather than a template nested in the evidence template
    // below — see the note in G5 about verify-gate-cleanup.mjs's scanner.
    const spawnFailureNote =
      spawnFailures.length > 0 ? ` (${spawnFailures.slice(0, 3).join(", ")})` : "";

    gate(
      "G3",
      "soak: no lost events, no duplicate transitions, no leaked leases",
      seqAdvanced &&
        countMatchesSeq &&
        seqReused === 0 &&
        dupes.length === 0 &&
        allCancelled &&
        spawnFailures.length === 0 &&
        wakesExact &&
        wakesMirrored &&
        shapeOk &&
        leaked.length === 0 &&
        quarantined.length === 0 &&
        boundedPool,
      `cycles=${CYCLES} seq=${startSeq}→${after.events.lastSeq} count==seq=${countMatchesSeq} seqReused=${seqReused} dupeCancels=${dupes.length} spawnFailures=${spawnFailures.length}${spawnFailureNote} wakes=${perClass("PROGRESS")}/${perClass("AGENT_SETTLED")} of ${CYCLES} mirrored=${wakesMirrored} leases=${shapeOk ? leases.length : "MISSING"}/${poolSize} leaked=${leaked.length} quarantined=${quarantined.length}`,
    );
  }

  // ── G4 — seeded secret canary absent from everything durable ───────────
  {
    await post("/v1/connections/api-key", {
      provider: "openrouter",
      apiKey: CANARY,
      label: "canary",
    });
    await sleep(600);

    // `<home>/secrets/<provider>.key` (0600) is the ONE place the secret
    // legitimately lives. Anything else holding it is a leak.
    const keyFiles = new Set(walk(join(home, "secrets")));
    const offenders = [];
    for (const file of walk(home)) {
      if (keyFiles.has(file)) continue;
      let contents;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue; // binary / unreadable
      }
      if (contents.includes(CANARY)) offenders.push(file.slice(home.length + 1));
    }

    // And it must not come back out over the API either.
    const connections = JSON.stringify(await get("/v1/connections"));
    const events = JSON.stringify(await get("/v1/events/replay?order=desc&limit=10000"));
    const leakedOverApi = connections.includes(CANARY) || events.includes(CANARY);

    gate(
      "G4",
      "seeded secret canary is absent from the event log, projection, and API",
      offenders.length === 0 && !leakedOverApi,
      `durableOffenders=${offenders.length}${offenders.length > 0 ? ` (${offenders.slice(0, 3).join(", ")})` : ""} apiLeak=${leakedOverApi}`,
    );
  }

  // ── G6 — Brain handoff past the threshold, into a NEW session ──────────
  {
    const brainBefore = (await get("/v1/fleet")).summary.brain;
    const brainProvider = (brainBefore.model ?? "").split("/")[0] ?? "";

    // Fixture the Brain's OWN routing provider — evaluateBrainHandoff only
    // loads samples for that connection and returns shouldHandoff=false when
    // it is missing. Never fall back to connections[0].
    let connections = (await get("/v1/connections")).connections ?? [];
    let brainConnection = connections.find((c) => c.provider === brainProvider);
    if (brainConnection === undefined && brainProvider.length > 0) {
      await post("/v1/connections/api-key", {
        provider: brainProvider,
        apiKey: "p8-brain-own-provider-not-a-secret",
        label: "brain own provider for handoff fixture",
      });
      connections = (await get("/v1/connections")).connections ?? [];
      brainConnection = connections.find((c) => c.provider === brainProvider);
    }

    // A second healthy connection so pickTarget has a refuge.
    if (!connections.some((c) => c.provider === "xai")) {
      await post("/v1/connections/api-key", {
        provider: "xai",
        apiKey: "p8-handoff-target-not-a-secret",
        label: "handoff target",
      });
      connections = (await get("/v1/connections")).connections ?? [];
      brainConnection = connections.find((c) => c.provider === brainProvider);
    }

    const fixtureMatchesBrain =
      brainConnection !== undefined &&
      brainProvider.length > 0 &&
      brainConnection.provider === brainProvider;

    if (!fixtureMatchesBrain) {
      gate(
        "G6",
        "Brain hands off past the budget threshold into a NEW session",
        false,
        `fixture connection does not match Brain provider: brainProvider=${brainProvider} fixture=${brainConnection?.provider ?? "none"} model=${brainBefore.model}`,
      );
    } else {
      // Drive the Brain's own window past the threshold through the explicit
      // quota fixture seam, then refresh so the daemon holds the real sample.
      mkdirSync(join(home, "fake-quota"), { recursive: true });
      writeFileSync(
        join(home, "fake-quota", `${brainConnection.provider}.json`),
        JSON.stringify([
          {
            kind: "weekly-window-pct",
            value: 93,
            unit: "percent",
            tier: "live",
            source: "OAUTH",
            syncedAt: new Date().toISOString(),
            reason: null,
            resetsAt: null,
            limitReached: false,
          },
        ]),
      );
      await post(`/v1/connections/${brainConnection.id}/quota/refresh`, {});

      // Evaluate may race the reconcile tick: whichever runs first performs the
      // handoff; the second call may report cooldown. Prove the path by
      // observable evidence (model, sessions, events), not only this response.
      const decision = (await post("/v1/brain/handoff/evaluate", {})).decision;
      await sleep(800);
      const brainAfter = (await get("/v1/fleet")).summary.brain;

      const modelChanged = brainAfter.model !== brainBefore.model;
      // The core rule: a new session, so no cross-model transcript replay.
      const newSession =
        brainAfter.sessionId !== null && brainAfter.sessionId !== brainBefore.sessionId;

      const replay = await get(
        "/v1/events/replay?types=brain.handoff_triggered,brain.handoff_completed&limit=1000",
      );
      const frames = (replay.events ?? []).map((e) => e.event ?? e);
      const triggered = frames.find((e) => e.type === "brain.handoff_triggered");
      const completed = frames.find((e) => e.type === "brain.handoff_completed");
      const sessionsDiffer =
        completed !== undefined &&
        completed.payload.fromSessionId !== completed.payload.toSessionId;
      // Handoff path ran: seat moved, both events present, distinct sessions.
      const handoffEvidence =
        modelChanged &&
        newSession &&
        triggered !== undefined &&
        completed !== undefined &&
        sessionsDiffer &&
        brainAfter.status === "running";

      gate(
        "G6",
        "Brain hands off past the budget threshold into a NEW session",
        fixtureMatchesBrain && handoffEvidence,
        `brainConn=${brainConnection.id}/${brainConnection.provider} ${brainBefore.model} → ${brainAfter.model} observed=${decision?.observedPct}% threshold=${decision?.thresholdPct}% shouldHandoff=${decision?.shouldHandoff} newSession=${newSession} events=${triggered !== undefined}/${completed !== undefined} reason=${decision?.reason ?? ""}`,
      );
    }
  }

  // ── G7 — config doctor lists drift; upgrade never overwrites ───────────
  {
    const before = (await get("/v1/config/doctor")).doctor;

    // Customize a shipped template the way a Captain would — by editing the
    // global copy on disk, which is exactly what the product installs it for.
    const templates = (await get("/v1/prompts")).templates ?? [];
    const target = templates.find((t) => t.ref.includes("fusion")) ?? templates[0];
    const globalPath = join(home, "prompts", target.ref);
    const original = readFileSync(globalPath, "utf8");
    writeFileSync(globalPath, `CAPTAIN EDIT — do not overwrite\n\n${original}`);

    const after = (await get("/v1/config/doctor")).doctor;
    const listed = after.templates.find((t) => t.ref === target.ref);

    // The upgrade: restart the daemon, which reinstalls shipped defaults on
    // boot. The Captain's copy must survive — an upgrade that silently reverts
    // an edit is data loss, not a merge conflict.
    daemon.kill("SIGTERM");
    await sleep(2000);
    daemon = startDaemon(home, PORT);
    await waitForHealth(home, PORT);
    const survived = readFileSync(globalPath, "utf8").includes("CAPTAIN EDIT");
    const stillListed = (await get("/v1/config/doctor")).doctor.templates.find(
      (t) => t.ref === target.ref,
    );

    // The live daemon can only ever show HALF the doctor: its shipped pack is
    // the one inside the installed package, so `upstreamChanged` — and with it
    // `needsDecision`, the intersection the whole feature exists for — stays
    // false no matter what the Captain edits. Drive the real PromptService and
    // runConfigDoctor over a shipped pack that actually MOVES, in temp dirs, so
    // the upgrade case is exercised without ever writing to the repo's own
    // shipped defaults.
    const promptsRoot = mkdtempSync(join(tmpdir(), "agentos-p8-doctor-"));
    cleanups.push(promptsRoot);
    const shippedDir = join(promptsRoot, "shipped");
    const globalDir = join(promptsRoot, "global");
    mkdirSync(join(shippedDir, "pack"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(shippedDir, "pack", "edited.md"), "shipped v1 — edited\n");
    writeFileSync(join(shippedDir, "pack", "moved.md"), "shipped v1 — moved\n");
    writeFileSync(join(shippedDir, "pack", "untouched.md"), "shipped v1 — untouched\n");

    const doctorScript = `
      import { PromptService } from '${join(ROOT, "apps/orchestrator/dist/prompts/service.js")}';
      import { runConfigDoctor } from '${join(ROOT, "apps/orchestrator/dist/prompts/doctor.js")}';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const shippedDir = ${JSON.stringify(shippedDir)};
      const globalDir = ${JSON.stringify(globalDir)};
      const prompts = new PromptService(shippedDir, globalDir);
      const installed = prompts.installDefaults();

      // The Captain edits one template.
      const editedGlobal = join(globalDir, 'pack/edited.md');
      writeFileSync(editedGlobal, 'CAPTAIN EDIT\\n' + readFileSync(editedGlobal, 'utf8'));

      // Upstream ships a new version of that one AND of one the Captain never
      // touched. 'untouched.md' does not move — it is the negative control.
      writeFileSync(join(shippedDir, 'pack/edited.md'), 'shipped v2 — edited\\n');
      writeFileSync(join(shippedDir, 'pack/moved.md'), 'shipped v2 — moved\\n');

      const report = runConfigDoctor(prompts);
      const by = (ref) => report.templates.find((t) => t.ref === ref);

      // The upgrade: installDefaults again. It must not touch either copy.
      const beforeUpgrade = {
        edited: readFileSync(editedGlobal, 'utf8'),
        moved: readFileSync(join(globalDir, 'pack/moved.md'), 'utf8'),
      };
      const reinstalled = prompts.installDefaults();
      const afterUpgrade = {
        edited: readFileSync(editedGlobal, 'utf8'),
        moved: readFileSync(join(globalDir, 'pack/moved.md'), 'utf8'),
      };
      const diff = prompts.threeWayDiff('pack/edited.md');

      process.stdout.write(JSON.stringify({
        installed: installed.length,
        reinstalled: reinstalled.length,
        edited: by('pack/edited.md'),
        moved: by('pack/moved.md'),
        untouched: by('pack/untouched.md'),
        customizedCount: report.customizedCount,
        upstreamChangedCount: report.upstreamChangedCount,
        needsDecisionCount: report.needsDecisionCount,
        upgradePreserved:
          beforeUpgrade.edited === afterUpgrade.edited &&
          beforeUpgrade.moved === afterUpgrade.moved,
        captainEditIntact: afterUpgrade.edited.startsWith('CAPTAIN EDIT'),
        diffShippedNow: diff.shippedNow,
        diffUpstreamChanged: diff.upstreamChanged,
        diffCustomized: diff.customized,
      }));
    `;
    const doctorRun = spawnSync(process.execPath, ["--input-type=module", "-e", doctorScript], {
      encoding: "utf8",
    });
    let drift = {};
    try {
      drift = JSON.parse(doctorRun.stdout);
    } catch {
      drift = { parseError: doctorRun.stderr.slice(0, 300) };
    }

    // Captain edit + upstream move → the only case that needs a decision.
    const editedOk =
      drift.edited?.customized === true &&
      drift.edited?.upstreamChanged === true &&
      drift.edited?.needsDecision === true;
    // Upstream moved under an untouched copy → listed, but no decision needed.
    const movedOk =
      drift.moved?.customized === false &&
      drift.moved?.upstreamChanged === true &&
      drift.moved?.needsDecision === false;
    // Nothing moved → must not be reported at all. Kills a doctor that just
    // returns true for everything.
    const untouchedOk =
      drift.untouched?.customized === false &&
      drift.untouched?.upstreamChanged === false &&
      drift.untouched?.needsDecision === false;
    const countsOk =
      drift.customizedCount === 1 &&
      drift.upstreamChangedCount === 2 &&
      drift.needsDecisionCount === 1;
    const upgradeSafe =
      drift.reinstalled === 0 &&
      drift.upgradePreserved === true &&
      drift.captainEditIntact === true &&
      drift.diffShippedNow === "shipped v2 — edited\n" &&
      drift.diffUpstreamChanged === true &&
      drift.diffCustomized === true;

    gate(
      "G7",
      "config doctor lists drifted templates; upgrade never overwrites a customized one",
      before.customizedCount === 0 &&
        after.customizedCount >= 1 &&
        listed?.customized === true &&
        survived &&
        stillListed?.customized === true &&
        editedOk &&
        movedOk &&
        untouchedOk &&
        countsOk &&
        upgradeSafe,
      `customized ${before.customizedCount}→${after.customizedCount} ref=${target?.ref} survivedRestart=${survived} | shipped-moved: counts=${drift.customizedCount}/${drift.upstreamChangedCount}/${drift.needsDecisionCount} (customized/upstream/needsDecision) edited=${editedOk} moved=${movedOk} untouched=${untouchedOk} upgradeSafe=${upgradeSafe}${drift.parseError !== undefined ? ` parseError=${drift.parseError}` : ""}`,
    );
  }

  // ── G8 — signed self-update with rollback ──────────────────────────────
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    // A second, entirely unrelated keypair: the attacker who can produce a
    // perfectly well-formed Ed25519 signature over exactly the right message,
    // just not with the key this install trusts. Garbage-bytes signatures alone
    // cannot tell "verifies against the installed key" apart from "is shaped
    // like a signature" — this pair is what makes the installed key load-bearing.
    const attacker = generateKeyPairSync("ed25519");
    const updaterPath = join(ROOT, "apps/orchestrator/dist/update/self-update.js");
    const root = mkdtempSync(join(tmpdir(), "agentos-p8-update-"));
    const keylessRoot = mkdtempSync(join(tmpdir(), "agentos-p8-update-nokey-"));
    cleanups.push(root);
    cleanups.push(keylessRoot);

    const payload = Buffer.from("release payload v2");
    const script = `
      import { SelfUpdater } from '${updaterPath}';
      import { sign } from 'node:crypto';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      const root = ${JSON.stringify(root)};
      const updater = new SelfUpdater(root, ${JSON.stringify(publicPem)});
      updater.seedCurrent('1.0.0', Buffer.from('v1'));
      const payload = Buffer.from(${JSON.stringify(payload.toString())});
      const sha256 = SelfUpdater.digest(payload);
      const privatePem = ${JSON.stringify(
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      )};
      const attackerPem = ${JSON.stringify(
        attacker.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      )};
      const signMsg = (version, digest, pem = privatePem) =>
        sign(null, SelfUpdater.signedMessage(version, digest), pem).toString('base64');
      const good = signMsg('2.0.0', sha256);

      const forged = updater.apply({ version: '9.9.9', sha256, signature: Buffer.from('forged').toString('base64') }, payload);
      const swapped = updater.apply({ version: '9.9.9', sha256, signature: good }, Buffer.from('a different payload'));
      const versionSwap = updater.apply({ version: '9.9.9', sha256, signature: good }, payload);
      const traversal = updater.apply({ version: '../../evil', sha256, signature: signMsg('../../evil', sha256) }, payload);
      // Valid signature, valid digest, valid version — wrong signer.
      const wrongKey = updater.apply(
        { version: '6.6.6', sha256, signature: signMsg('6.6.6', sha256, attackerPem) },
        payload,
      );
      // An install with no key compiled in must refuse outright, never
      // fall through to "unsigned is fine".
      const keyless = new SelfUpdater(${JSON.stringify(keylessRoot)}, null)
        .apply({ version: '2.0.0', sha256, signature: good }, payload);

      // Every refusal above must have been inert: the installed version is
      // untouched and no archive was staged for a release we rejected.
      const versionAfterRefusals = updater.currentVersion();
      const refusedArchives = ['9.9.9', '6.6.6'].filter((v) =>
        existsSync(join(root, 'versions', v + '.tar')),
      );

      const applied = updater.apply({ version: '2.0.0', sha256, signature: good }, payload);
      const afterApply = updater.currentVersion();
      const rolled = updater.rollback();
      const afterRollback = updater.currentVersion();
      process.stdout.write(JSON.stringify({
        forged: forged.ok === false ? forged.code : 'APPLIED',
        swapped: swapped.ok === false ? swapped.code : 'APPLIED',
        versionSwap: versionSwap.ok === false ? versionSwap.code : 'APPLIED',
        traversal: traversal.ok === false ? traversal.code : 'APPLIED',
        wrongKey: wrongKey.ok === false ? wrongKey.code : 'APPLIED',
        keyless: keyless.ok === false ? keyless.code : 'APPLIED',
        versionAfterRefusals,
        refusedArchives,
        applied: applied.ok,
        afterApply,
        rolled: rolled.ok,
        afterRollback,
      }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    let outcome = {};
    try {
      outcome = JSON.parse(run.stdout);
    } catch {
      outcome = { parseError: run.stderr.slice(0, 200) };
    }

    gate(
      "G8",
      "self-update refuses forged, wrong-key and swapped releases, applies a signed one, rolls back",
      outcome.forged === "SIGNATURE_INVALID" &&
        outcome.swapped === "DIGEST_MISMATCH" &&
        outcome.versionSwap === "SIGNATURE_INVALID" &&
        outcome.traversal === "VERSION_UNSAFE" &&
        outcome.wrongKey === "SIGNATURE_INVALID" &&
        outcome.keyless === "NO_PUBLIC_KEY" &&
        outcome.versionAfterRefusals === "1.0.0" &&
        Array.isArray(outcome.refusedArchives) &&
        outcome.refusedArchives.length === 0 &&
        outcome.applied === true &&
        outcome.afterApply === "2.0.0" &&
        outcome.rolled === true &&
        outcome.afterRollback === "1.0.0",
      `forged=${outcome.forged} swapped=${outcome.swapped} versionSwap=${outcome.versionSwap} traversal=${outcome.traversal} wrongKey=${outcome.wrongKey} keyless=${outcome.keyless} versionAfterRefusals=${outcome.versionAfterRefusals} refusedArchives=${(outcome.refusedArchives ?? []).join(",") || "none"} applied=${outcome.afterApply} rolledBackTo=${outcome.afterRollback}`,
    );
  }

  // ── G5 — fresh machine: clean home → dashboard + first task ────────────
  {
    const FRESH_TASK_TITLE = "first task on a fresh machine";
    const freshHome = mkdtempSync(join(tmpdir(), "agentos-p8-fresh-"));
    cleanups.push(freshHome);
    // The home must be genuinely empty — everything asserted below is about
    // what the daemon provisions, so a pre-populated home would prove nothing.
    const homeStartedEmpty = readdirSync(freshHome).length === 0;
    const started = Date.now();
    freshDaemon = startDaemon(freshHome, FRESH_PORT);
    const freshToken = await waitForHealth(freshHome, FRESH_PORT, 60_000);
    const freshAuth = { authorization: `Bearer ${freshToken}`, "content-type": "application/json" };
    const freshGet = async (path) =>
      (await fetch(`http://127.0.0.1:${FRESH_PORT}${path}`, { headers: freshAuth })).json();
    const freshPost = async (path, body) =>
      (
        await fetch(`http://127.0.0.1:${FRESH_PORT}${path}`, {
          method: "POST",
          headers: freshAuth,
          body: JSON.stringify(body),
        })
      ).json();

    // Default config must install ITSELF, into THIS home. `/v1/config/effective`
    // alone cannot show that: it resolves through the shipped layer that ships
    // inside the package, so it answers identically on a home where nothing was
    // provisioned at all. The proof is on the fresh disk.
    const configFiles = CONFIG_DOMAINS.map((domain) =>
      join(freshHome, "config", `${domain}.json5`),
    );
    const missingConfig = configFiles.filter((path) => !existsSync(path));
    const promptManifest = join(freshHome, "prompts", ".installed.json");
    const installedPrompts = existsSync(promptManifest)
      ? Object.keys(JSON.parse(readFileSync(promptManifest, "utf8")))
      : [];
    const promptsOnDisk = installedPrompts.filter((ref) =>
      existsSync(join(freshHome, "prompts", ref)),
    );
    // The daemon must also SEE its own global layer — a template written to a
    // directory nothing reads back would still be an unprovisioned machine.
    const globalLayer = await Promise.all(
      CONFIG_DOMAINS.map(async (domain) => (await freshGet(`/v1/config/global/${domain}`)).value),
    );
    const globalLayerReadable = globalLayer.every((value) => value !== null && value !== undefined);
    const tokenMode = statSync(join(freshHome, "daemon.token")).mode & 0o777;

    const effective = await freshGet("/v1/config/effective");

    const freshProject = (
      await freshPost("/v1/projects", {
        name: "fresh",
        path: fixtureRepo(cleanups),
        mode: "local-only",
        trusted: true,
      })
    ).project;
    const freshTask = (
      await freshPost("/v1/tasks", {
        spec: {
          shape: "SHIP",
          title: FRESH_TASK_TITLE,
          intent: "prove the cold path",
          projectId: freshProject.id,
          mode: "local-only",
          yolo: true,
        },
      })
    ).task;
    // Cold boot → provisioned → first task. This is the part the 10-minute
    // budget is really about, and it runs in seconds; hold it to a bound that
    // a regression could actually cross rather than one with 600x of slack.
    const apiReadyMs = Date.now() - started;

    const summary = await freshGet("/v1/fleet");

    // "Reaches a live dashboard" is a claim about a rendered page, so render
    // one. A console bound to the fresh daemon must show the fresh task; the
    // shell renders byte-identically when the daemon is unreachable, so the
    // seeded row is the only thing that distinguishes live from dead.
    const freshConsole = await startConsole(freshHome, FRESH_PORT, FRESH_CONSOLE_PORT);
    freshConsoleServer = freshConsole.child;
    // Only drive Chromium once the console is actually serving. Navigating to a
    // console that never bound throws, and a throw here aborts the whole run —
    // G5 and G9 would both go unreported behind a stack trace instead of a
    // verdict. A gate must fail loudly, not explode.
    const dashboards = {};
    if (freshConsole.ok) {
      browser = await chromium.launch();
      const freshPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      for (const path of ["/fleet", "/tasks"]) {
        await freshPage.goto(`${FRESH_CONSOLE}${path}`, { waitUntil: "networkidle" });
        await sleep(600);
        dashboards[path] = await pageText(freshPage);
      }
      await freshPage.close();
    }
    const dashboardLive =
      freshConsole.ok &&
      // Fleet chips come from /v1/fleet on the fresh daemon: neither string is
      // in the shell — a console pointed at a dead daemon renders "Fleet
      // summary unavailable" with no BRAIN and no QUEUED anywhere on the page.
      dashboards["/fleet"].includes("BRAIN") &&
      dashboards["/fleet"].includes("QUEUED") &&
      // The job board lists the one task this fresh machine has ever had.
      dashboards["/tasks"].includes(FRESH_TASK_TITLE) &&
      Object.values(dashboards).every((text) =>
        DAEMON_UNREACHABLE_MARKERS.every((marker) => !text.toLowerCase().includes(marker)),
      );

    const totalMs = Date.now() - started;
    // Built as its own statement, never as a template nested inside the
    // evidence template below: `scripts/verify-gate-cleanup.mjs` scans gate
    // sources with a non-recursive string scanner, and a nested backtick makes
    // it close the outer literal early. It then mistakes the rest of the file
    // for a string, reports "no top-level finally", and silently stops checking
    // this gate for exit-before-cleanup — a CI check that passes by not looking.
    const freshConsoleNote = freshConsole.ok
      ? ""
      : ` (fresh console never served: ${freshConsole.reason})`;

    gate(
      "G5",
      "fresh home reaches a live dashboard and a first local-only task well inside 10 min",
      homeStartedEmpty &&
        missingConfig.length === 0 &&
        installedPrompts.length > 0 &&
        promptsOnDisk.length === installedPrompts.length &&
        globalLayerReadable &&
        tokenMode === 0o600 &&
        freshTask?.id !== undefined &&
        summary.summary?.brain !== undefined &&
        Object.keys(effective.config ?? effective).length > 0 &&
        dashboardLive &&
        apiReadyMs < 120_000 &&
        totalMs < 600_000,
      `emptyHome=${homeStartedEmpty} config=${CONFIG_DOMAINS.length - missingConfig.length}/${CONFIG_DOMAINS.length} prompts=${promptsOnDisk.length}/${installedPrompts.length} globalLayer=${globalLayerReadable} token=0${tokenMode.toString(8)} apiReady=${Math.round(apiReadyMs / 1000)}s total=${Math.round(totalMs / 1000)}s dashboardLive=${dashboardLive}${freshConsoleNote} brain=${summary.summary?.brain?.status} task=${freshTask?.phase}`,
    );
  }

  // ── G9 — WCAG on the operational pages ─────────────────────────────────
  {
    const consoleStart = await startConsole(home, PORT, CONSOLE_PORT);
    consoleServer = consoleStart.child;
    const up = consoleStart.ok;

    // The criterion is "the operational PAGES". Every screen here renders the
    // same shell whether the daemon answered or not, and an error state is
    // perfectly accessible — so a clean axe sweep over ten unreachable-daemon
    // pages certifies the chrome and nothing else. Proven, not assumed: with
    // the console BFF pointed at a dead port this gate still reported "10 pages
    // clean". Require the daemon-backed content to be on the page before the
    // sweep is allowed to mean anything.
    //
    // The home the BFF reports is also how a port squat diagnoses itself: an
    // orphaned console from an earlier run answers /fleet perfectly happily but
    // proxies to somebody else's daemon, and "bffLive=false" alone would send
    // someone hunting a product bug that is not there.
    const bff = up ? await fetch(`${CONSOLE}/api/agentos/status`) : null;
    const bffBody = bff !== null && bff.ok ? await bff.json() : null;
    const bffHome = bffBody?.daemon?.home ?? null;
    const bffLive = bffHome === home;
    const foreignConsole = bffHome !== null && bffHome !== home;

    const axePath = join(ROOT, "node_modules", "axe-core", "axe.min.js");
    // G5 already launched Chromium for the fresh dashboard; reuse it so the
    // finally block only ever has one browser to close.
    browser ??= await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const PAGES = [
      "/fleet",
      "/tasks",
      "/projects",
      "/providers",
      "/notifications",
      "/runs",
      "/alerts",
      "/analytics",
      "/policies",
      "/settings",
    ];
    const violations = [];
    const dead = [];
    let rulesEvaluated = 0;
    // Same rule as G5: never navigate to a console that did not serve. A throw
    // here would replace nine reported verdicts with a stack trace.
    for (const path of up ? PAGES : []) {
      await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
      await sleep(400);
      const text = (await pageText(page)).toLowerCase();
      if (DAEMON_UNREACHABLE_MARKERS.some((marker) => text.includes(marker))) {
        dead.push(path);
      }
      await page.addScriptTag({ path: axePath });
      const result = await page.evaluate(async () =>
        await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        }),
      );
      // An axe run that evaluated nothing reports zero violations too.
      rulesEvaluated += result.passes.length + result.violations.length;
      for (const violation of result.violations) {
        if (violation.impact === "critical" || violation.impact === "serious") {
          violations.push(`${path}:${violation.id}(${violation.nodes.length})`);
        }
      }
    }
    // The two screens whose content is entirely daemon-derived must show the
    // fixtures this run created — the strongest available proof that axe swept
    // a live screen rather than an empty frame.
    let tasksText = "";
    let projectsText = "";
    if (up) {
      await page.goto(`${CONSOLE}/tasks`, { waitUntil: "networkidle" });
      await sleep(400);
      tasksText = await pageText(page);
      await page.goto(`${CONSOLE}/projects`, { waitUntil: "networkidle" });
      await sleep(400);
      projectsText = await pageText(page);
    }
    const renderedRealData = tasksText.includes("soak ") && projectsText.includes("p8");
    // Separate statements, not templates nested in the evidence template — see
    // the note in G5 about verify-gate-cleanup.mjs's string scanner.
    const squatNote = foreignConsole
      ? ` (PORT ${CONSOLE_PORT} SQUATTED: that console proxies to ${bffHome}, not this run home)`
      : "";
    const deadNote = dead.length > 0 ? ` (${dead.slice(0, 3).join(", ")})` : "";

    gate(
      "G9",
      "no critical or serious WCAG 2.1 AA violations on the live operational pages",
      up &&
        bffLive &&
        dead.length === 0 &&
        renderedRealData &&
        rulesEvaluated > 0 &&
        violations.length === 0,
      up
        ? `bffLive=${bffLive}${squatNote} deadPages=${dead.length}${deadNote} realData=${renderedRealData} axeChecks=${rulesEvaluated} ` +
          (violations.length === 0
            ? `${PAGES.length} pages clean`
            : violations.slice(0, 5).join(", "))
        : `console did not start: ${consoleStart.reason}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  // Set the code; exit AFTER the finally block has torn everything down.
  // process.exit() does not unwind `finally`, so exiting here would orphan the
  // daemon, the tmux server and the temp homes on every single run — including
  // the successful ones. Accumulated orphans starve later gates of ports and
  // CPU, which surfaces as unrelated gates failing for no visible reason.
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
  for (const child of [consoleServer, freshConsoleServer, freshDaemon, daemon]) {
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
