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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p8-${process.pid}`;
// Non-overlapping with phase-6 (daemon 5500–5599 / console 3300–3499) so
// concurrent local or matrix runs cannot collide on bind ports.
const PORT = 4700 + 1000 + Math.floor(Math.random() * 60); // 5700–5759
const CONSOLE_PORT = 3000 + 1000 + Math.floor(Math.random() * 60); // 4000–4059
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;

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

const cleanups = [];
let daemon;
let freshDaemon;
let consoleServer;
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
    const CYCLES = 40;
    const before = await get("/v1/status");
    const startSeq = before.events.lastSeq;

    const soakTasks = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const id = await seedTask(`soak ${i}`);
      soakTasks.push(id);
      await tool("cancel_task", { taskId: id, reason: "soak cycle" });
    }
    await sleep(1200);

    const after = await get("/v1/status");
    // Every appended event got a sequence number: none lost, none reused.
    const seqAdvanced = after.events.lastSeq > startSeq;
    const countMatchesSeq = after.events.count === after.events.lastSeq;

    // No duplicate phase transitions: one CANCELLED per soak task, never two.
    const replay = await get("/v1/events/replay?types=task.phase_changed&limit=10000");
    const frames = replay.events ?? [];
    const cancelsPerTask = new Map();
    for (const envelope of frames) {
      const event = envelope.event ?? envelope;
      if (event.type !== "task.phase_changed") continue;
      if (event.payload.to !== "CANCELLED") continue;
      const id = event.payload.taskId;
      cancelsPerTask.set(id, (cancelsPerTask.get(id) ?? 0) + 1);
    }
    const dupes = soakTasks.filter((id) => (cancelsPerTask.get(id) ?? 0) > 1);
    const allCancelled = soakTasks.every((id) => (cancelsPerTask.get(id) ?? 0) === 1);

    // Bounded growth: no worktree lease survives a cancelled task.
    const state = await get("/v1/fleet/state");
    const leaked = (state.state?.worktrees ?? []).filter(
      (w) => w.taskId !== null && soakTasks.includes(w.taskId),
    );

    gate(
      "G3",
      "soak: no lost events, no duplicate transitions, no leaked leases",
      seqAdvanced && countMatchesSeq && dupes.length === 0 && allCancelled && leaked.length === 0,
      `cycles=${CYCLES} seq=${startSeq}→${after.events.lastSeq} count==seq=${countMatchesSeq} dupeCancels=${dupes.length} leakedLeases=${leaked.length}`,
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

    gate(
      "G7",
      "config doctor lists drifted templates; upgrade never overwrites a customized one",
      before.customizedCount === 0 &&
        after.customizedCount >= 1 &&
        listed?.customized === true &&
        survived &&
        stillListed?.customized === true,
      `customized ${before.customizedCount}→${after.customizedCount} ref=${target?.ref} survivedRestart=${survived}`,
    );
  }

  // ── G8 — signed self-update with rollback ──────────────────────────────
  {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const updaterPath = join(ROOT, "apps/orchestrator/dist/update/self-update.js");
    const root = mkdtempSync(join(tmpdir(), "agentos-p8-update-"));
    cleanups.push(root);

    const payload = Buffer.from("release payload v2");
    const script = `
      import { SelfUpdater } from '${updaterPath}';
      import { sign } from 'node:crypto';
      const updater = new SelfUpdater(${JSON.stringify(root)}, ${JSON.stringify(publicPem)});
      updater.seedCurrent('1.0.0', Buffer.from('v1'));
      const payload = Buffer.from(${JSON.stringify(payload.toString())});
      const sha256 = SelfUpdater.digest(payload);
      const privatePem = ${JSON.stringify(
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      )};
      const signMsg = (version, digest) =>
        sign(null, SelfUpdater.signedMessage(version, digest), privatePem).toString('base64');
      const good = signMsg('2.0.0', sha256);

      const forged = updater.apply({ version: '9.9.9', sha256, signature: Buffer.from('forged').toString('base64') }, payload);
      const swapped = updater.apply({ version: '9.9.9', sha256, signature: good }, Buffer.from('a different payload'));
      const versionSwap = updater.apply({ version: '9.9.9', sha256, signature: good }, payload);
      const traversal = updater.apply({ version: '../../evil', sha256, signature: signMsg('../../evil', sha256) }, payload);
      const applied = updater.apply({ version: '2.0.0', sha256, signature: good }, payload);
      const afterApply = updater.currentVersion();
      const rolled = updater.rollback();
      const afterRollback = updater.currentVersion();
      process.stdout.write(JSON.stringify({
        forged: forged.ok === false ? forged.code : 'APPLIED',
        swapped: swapped.ok === false ? swapped.code : 'APPLIED',
        versionSwap: versionSwap.ok === false ? versionSwap.code : 'APPLIED',
        traversal: traversal.ok === false ? traversal.code : 'APPLIED',
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
      "self-update refuses forged and swapped releases, applies a signed one, rolls back",
      outcome.forged === "SIGNATURE_INVALID" &&
        outcome.swapped === "DIGEST_MISMATCH" &&
        outcome.versionSwap === "SIGNATURE_INVALID" &&
        outcome.traversal === "VERSION_UNSAFE" &&
        outcome.applied === true &&
        outcome.afterApply === "2.0.0" &&
        outcome.rolled === true &&
        outcome.afterRollback === "1.0.0",
      `forged=${outcome.forged} swapped=${outcome.swapped} versionSwap=${outcome.versionSwap} traversal=${outcome.traversal} applied=${outcome.afterApply} rolledBackTo=${outcome.afterRollback}`,
    );
  }

  // ── G5 — fresh machine: clean home → dashboard + first task ────────────
  {
    const freshHome = mkdtempSync(join(tmpdir(), "agentos-p8-fresh-"));
    cleanups.push(freshHome);
    const freshPort = PORT + 1;
    const started = Date.now();
    freshDaemon = startDaemon(freshHome, freshPort);
    const freshToken = await waitForHealth(freshHome, freshPort, 60_000);
    const freshAuth = { authorization: `Bearer ${freshToken}`, "content-type": "application/json" };
    const freshPost = async (path, body) =>
      (
        await fetch(`http://127.0.0.1:${freshPort}${path}`, {
          method: "POST",
          headers: freshAuth,
          body: JSON.stringify(body),
        })
      ).json();

    // Default config must install itself — a fresh machine has none.
    const effective = await (
      await fetch(`http://127.0.0.1:${freshPort}/v1/config/effective`, { headers: freshAuth })
    ).json();

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
          title: "first task on a fresh machine",
          intent: "prove the cold path",
          projectId: freshProject.id,
          mode: "local-only",
          yolo: true,
        },
      })
    ).task;
    const elapsedMs = Date.now() - started;

    const summary = await (
      await fetch(`http://127.0.0.1:${freshPort}/v1/fleet`, { headers: freshAuth })
    ).json();

    gate(
      "G5",
      "fresh home reaches a live dashboard and a first local-only task well inside 10 min",
      freshTask?.id !== undefined &&
        summary.summary?.brain !== undefined &&
        Object.keys(effective.config ?? effective).length > 0 &&
        elapsedMs < 600_000,
      `elapsed=${Math.round(elapsedMs / 1000)}s brain=${summary.summary?.brain?.status} task=${freshTask?.phase}`,
    );
  }

  // ── G9 — WCAG on the operational pages ─────────────────────────────────
  {
    consoleServer = spawn(
      join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
      ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
      {
        cwd: join(ROOT, "apps", "console"),
        env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const res = await fetch(`${CONSOLE}/fleet`);
        up = res.status < 500;
      } catch {
        // not up
      }
      if (!up) await sleep(300);
    }

    const axePath = join(ROOT, "node_modules", "axe-core", "axe.min.js");
    browser = await chromium.launch();
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
    for (const path of PAGES) {
      await page.goto(`${CONSOLE}${path}`, { waitUntil: "networkidle" });
      await sleep(400);
      await page.addScriptTag({ path: axePath });
      const result = await page.evaluate(async () =>
        await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        }),
      );
      for (const violation of result.violations) {
        if (violation.impact === "critical" || violation.impact === "serious") {
          violations.push(`${path}:${violation.id}(${violation.nodes.length})`);
        }
      }
    }

    gate(
      "G9",
      "no critical or serious WCAG 2.1 AA violations on the operational pages",
      up && violations.length === 0,
      up
        ? violations.length === 0
          ? `${PAGES.length} pages clean`
          : violations.slice(0, 5).join(", ")
        : "console did not start",
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
  for (const child of [consoleServer, freshDaemon, daemon]) {
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
