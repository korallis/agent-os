#!/usr/bin/env node
/**
 * Phase 4 executable gates (master plan §11 Phase 4) — fusion primitives.
 *
 *   G1  `/opinion` default path spawns sides and writes per-side artifacts
 *   G2  clean-room: every side is LAUNCHED with byte-identical rendered bytes
 *   G3  same-family `/opinion` panel is refused (an echo is not an opinion)
 *   G4  `/fusion` contract enforcement — missing spans → FUSION_CONTRACT
 *   G5  aggregator family = first planner's family, derived from the model
 *   G6  session-key gate: model change → new dir; restart resumes only missing role
 *   G7  template edit (global layer) changes the next run's rendered instruction
 *   G8  `{{VAR}}` with an undefined variable → typed VALIDATION_ERROR
 *   G9  project prompt override wins over global
 *   G10 customized-template detection + three-way diff data served
 *   G11 clean-room: no model-visible tools on crew sides; no cross-reads
 *
 * Runs against a real daemon; only the model is simulated. G2 additionally boots
 * a second daemon on the real spawn path with a recording stand-in for the Pi
 * binary, so the clean-room claim is measured from the bytes each side is
 * actually launched with rather than from a hash the daemon copied into every
 * side.
 * Usage: node tooling/gates/phase-4.mjs
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const STUB_PI = join(dirname(fileURLToPath(import.meta.url)), "lib", "stub-pi.mjs");
const TMUX_SOCKET = `agentos-p4-${process.pid}`;
const PORT = pickPort(5000, 400);
const BASE = `http://127.0.0.1:${PORT}`;
// G2 boots a second daemon on the REAL spawn path (recording stub Pi), so it
// needs a port of its own.
let stubPort = pickPort(5000, 400);
while (stubPort === PORT) stubPort = pickPort(5000, 400);
const STUB_BASE = `http://127.0.0.1:${stubPort}`;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(home, port, envOverride = {}) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      ...envOverride,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
      const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok && (await res.json()).daemon?.home === home) return token;
    } catch {
      // not up
    }
    await sleep(100);
  }
  throw new Error(`daemon did not come up on ${port}`);
}

async function apiAt(base, path, token, init = {}) {
  const headers = { ...(init.headers ?? {}), "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}
async function api(path, token, init = {}) {
  return apiAt(BASE, path, token, init);
}
async function callToolAt(base, token, tool, input) {
  return (await apiAt(base, "/v1/tools/call", token, {
    method: "POST",
    body: JSON.stringify({ tool, input }),
  })).json();
}
async function callTool(token, tool, input) {
  return callToolAt(BASE, token, tool, input);
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p4-repo-"));
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "gate@agent-os.local");
  git("config", "user.name", "Agent OS Gate");
  writeFileSync(join(dir, "README.md"), "# p4 fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

let exitCode = 0;
const cleanups = [];
let child;
/** Second daemon (real spawn path with the recording stub Pi) used by G2. */
let stubChild;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p4-home-"));
  cleanups.push(home);
  child = startDaemon(home, PORT);
  let token = await waitForHealth(home, PORT);

  const repo = fixtureRepo();
  cleanups.push(repo);
  const projectId = (
    await (
      await api("/v1/projects", token, {
        method: "POST",
        body: JSON.stringify({ name: "p4", path: repo, mode: "local-only", trusted: true }),
      })
    ).json()
  ).project.id;

  const newTask = async (title) =>
    (
      await (
        await api("/v1/tasks", token, {
          method: "POST",
          body: JSON.stringify({
            spec: {
              shape: "SHIP",
              title,
              intent: "fusion gate fixture",
              projectId,
              mode: "local-only",
              yolo: true,
            },
          }),
        })
      ).json()
    ).task.id;

  const CROSS_FAMILY = [
    { role: "planner", model: "anthropic/claude-fable-5", thinking: "high", family: "anthropic", cleanRoom: true },
    { role: "planner", model: "openai/gpt-5.6-sol", thinking: "high", family: "openai", cleanRoom: true },
  ];

  // G1 + G5 — /opinion default path, per-side artifacts, aggregator family
  {
    const taskId = await newTask("Opinion gate");
    await callTool(token, "resolve_cast", {
      taskId,
      roles: CROSS_FAMILY.map(({ role, model, thinking, cleanRoom }) => ({
        role,
        model,
        thinking,
        cleanRoom,
      })),
      familyCheckOverride: false,
    });
    // Default path — no spawnSides flag; opinion must spawn clean-room sides.
    const res = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: CROSS_FAMILY,
      vars: { QUESTION: "Should the event log stay NDJSON?", CONTEXT: "100k events/day." },
    });
    const runs = await (await api(`/v1/tasks/${taskId}/fusion`, token)).json();
    const run = runs.runs?.[0];
    const detail = await (
      await api(`/v1/tasks/${taskId}/fusion/${res.data.runId}`, token)
    ).json();

    const sideArtifacts = detail.sideArtifacts ?? [];
    const sidesWithArtifacts = (run?.sides ?? []).filter((s) => s.artifactPath != null);
    const distinctArtifactPaths = new Set(sidesWithArtifacts.map((s) => s.artifactPath));
    gate(
      "G1",
      "/opinion default path writes per-side artifacts (index+model, no role collision)",
      res.ok === true &&
        res.data?.spawned === true &&
        run?.sides?.length === 2 &&
        detail.instruction !== null &&
        sideArtifacts.length === 2 &&
        sidesWithArtifacts.length === 2 &&
        distinctArtifactPaths.size === 2,
      `spawned=${res.data?.spawned} sides=${run?.sides?.length} artifacts=${sideArtifacts.length} paths=${distinctArtifactPaths.size}`,
    );

    // G5 — the aggregator family is the FIRST PLANNER's family, derived from the
    // model server-side. Asserting only the cross-family panel above proves
    // nothing: both its casts are planners, so "first planner" and `casts[0]`
    // pick the same side, and a hard-coded "anthropic" would pass too. The
    // three bookkeeping dispatches below (spawnSides:false — no seats, no
    // models) separate those rules from each other:
    //   · reversed      — flips the answer, so a constant cannot pass
    //   · scout-first   — casts[0] is NOT a planner, so first-cast ≠ first-planner
    //   · mislabelled   — client-supplied `family` contradicts the model
    // §16: cast order is load-bearing; the balancer must never reorder fusion
    // casts, and this is the assertion that would notice if it did.
    const aggregatorOf = async (title, casts) => {
      const id = await newTask(title);
      const body = await callTool(token, "dispatch_fusion", {
        taskId: id,
        kind: "opinion",
        casts,
        spawnSides: false,
        vars: { QUESTION: "q", CONTEXT: "c" },
      });
      if (body.ok !== true) return { reported: null, durable: null, sides: [] };
      const durable = await (
        await api(`/v1/tasks/${id}/fusion/${body.data.runId}`, token)
      ).json();
      return {
        reported: body.data.aggregatorFamily,
        durable: durable.run?.aggregatorFamily ?? null,
        sides: durable.run?.sides ?? [],
      };
    };

    const reversed = await aggregatorOf("Aggregator reversed", [
      { role: "planner", model: "openai/gpt-5.6-sol", thinking: "high", family: "openai", cleanRoom: true },
      { role: "planner", model: "anthropic/claude-fable-5", thinking: "high", family: "anthropic", cleanRoom: true },
    ]);
    const scoutFirst = await aggregatorOf("Aggregator scout first", [
      { role: "scout", model: "openai/gpt-5.6-sol", thinking: "low", family: "openai", cleanRoom: true },
      { role: "planner", model: "anthropic/claude-fable-5", thinking: "high", family: "anthropic", cleanRoom: true },
      { role: "planner", model: "openai/gpt-5.6-sol", thinking: "high", family: "openai", cleanRoom: true },
    ]);
    // Families deliberately swapped against the models they label.
    const mislabelled = await aggregatorOf("Aggregator mislabelled", [
      { role: "planner", model: "openai/gpt-5.6-sol", thinking: "high", family: "anthropic", cleanRoom: true },
      { role: "planner", model: "anthropic/claude-fable-5", thinking: "high", family: "openai", cleanRoom: true },
    ]);

    gate(
      "G5",
      "aggregator family = first PLANNER's family, derived from the model (not cast[0], not the client's label, not a constant)",
      res.data.aggregatorFamily === "anthropic" &&
        run?.aggregatorFamily === "anthropic" &&
        reversed.reported === "openai" &&
        reversed.durable === "openai" &&
        scoutFirst.reported === "anthropic" &&
        scoutFirst.durable === "anthropic" &&
        mislabelled.reported === "openai" &&
        mislabelled.durable === "openai" &&
        mislabelled.sides[0]?.family === "openai" &&
        mislabelled.sides[1]?.family === "anthropic",
      `base=${run?.aggregatorFamily} reversed=${reversed.durable} scoutFirst=${scoutFirst.durable} mislabelled=${mislabelled.durable}/${mislabelled.sides[0]?.family}`,
    );
  }

  // G2 — clean-room byte identity, proved against the bytes each side is
  // ACTUALLY launched with.
  //
  // The run record's `promptsIdentical` is `new Set(sides.map(s => s.promptHash))
  // .size === 1` over a hash the daemon copies into every side from one
  // variable, so it is true whatever the sides received; and the fake-Pi path
  // never reads `input.prompt` at all. Both halves of the old assertion were
  // therefore satisfied by construction. This boots a second daemon on the REAL
  // spawn path with a recording stand-in for the Pi binary (PI_BINARY), and
  // compares the `-p` bytes each side was launched with — to each other, to the
  // per-side hash on the durable record, and to the instruction the run serves.
  {
    const stubDir = mkdtempSync(join(tmpdir(), "agentos-p4-stubpi-"));
    cleanups.push(stubDir);
    const stubBin = join(stubDir, "pi");
    copyFileSync(STUB_PI, stubBin);
    chmodSync(stubBin, 0o755);

    // Short prefix on purpose: this daemon opens real per-session unix sockets
    // under $HOME/sockets/<ulid>.sock, and sun_path is capped at ~104 bytes on
    // macOS — a chattier temp name makes every spawn fail with SPAWN_FAILED.
    const stubHome = mkdtempSync(join(tmpdir(), "p4s-"));
    cleanups.push(stubHome);
    const stubRepo = fixtureRepo();
    cleanups.push(stubRepo);

    stubChild = startDaemon(stubHome, stubPort, {
      // The real spawn path is the whole point — no fake Pi here.
      AGENTOS_FAKE_PI: "0",
      PI_BINARY: stubBin,
    });
    const stubToken = await waitForHealth(stubHome, stubPort);

    const stubProjectId = (
      await (
        await apiAt(STUB_BASE, "/v1/projects", stubToken, {
          method: "POST",
          body: JSON.stringify({
            name: "p4-stub",
            path: stubRepo,
            mode: "local-only",
            trusted: true,
          }),
        })
      ).json()
    ).project.id;
    const stubTaskId = (
      await (
        await apiAt(STUB_BASE, "/v1/tasks", stubToken, {
          method: "POST",
          body: JSON.stringify({
            spec: {
              shape: "SHIP",
              title: "Clean-room byte identity",
              intent: "fusion gate fixture",
              projectId: stubProjectId,
              mode: "local-only",
              yolo: true,
            },
          }),
        })
      ).json()
    ).task.id;

    await callToolAt(STUB_BASE, stubToken, "resolve_cast", {
      taskId: stubTaskId,
      roles: CROSS_FAMILY.map(({ role, model, thinking, cleanRoom }) => ({
        role,
        model,
        thinking,
        cleanRoom,
      })),
      familyCheckOverride: false,
    });
    const question = "Should the event log stay NDJSON?";
    const res = await callToolAt(STUB_BASE, stubToken, "dispatch_fusion", {
      taskId: stubTaskId,
      kind: "opinion",
      casts: CROSS_FAMILY,
      vars: { QUESTION: question, CONTEXT: "100k events/day." },
    });

    const detail =
      res.ok === true
        ? await (
            await apiAt(
              STUB_BASE,
              `/v1/tasks/${stubTaskId}/fusion/${res.data.runId}`,
              stubToken,
            )
          ).json()
        : { run: { sides: [] }, instruction: null };
    const sides = detail.run?.sides ?? [];

    // Each side's stand-in writes its argv as soon as it is exec'd; wait for
    // both rather than assuming tmux has scheduled them.
    const captureFor = (sessionId) => {
      const path = join(stubDir, `capture-${sessionId}.json`);
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    };
    let captures = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      captures = sides.map((s) => (s.sessionId == null ? null : captureFor(s.sessionId)));
      if (captures.length > 0 && captures.every((c) => c !== null)) break;
      await sleep(100);
    }

    const deliveredPrompts = captures.map((c) => c?.prompt ?? null);
    const everySideLaunched =
      sides.length === 2 &&
      deliveredPrompts.length === 2 &&
      deliveredPrompts.every((p) => typeof p === "string" && p.length > 0);
    // The bytes handed to each side are the same bytes — measured, not asserted
    // from a single copied hash.
    const deliveredIdentical =
      everySideLaunched && new Set(deliveredPrompts).size === 1;
    // …and those bytes are the ones the run says it sent, and serves as its
    // instruction. A hash recorded from anything else fails here.
    const hashesMatchDelivery =
      everySideLaunched &&
      sides.every((s, i) => s.promptHash === sha256(deliveredPrompts[i])) &&
      typeof detail.instruction === "string" &&
      sides.every((s) => s.promptHash === sha256(detail.instruction));
    const renderedReachedModels =
      everySideLaunched && deliveredPrompts.every((p) => p.includes(question));
    const distinctModels = new Set(sides.map((s) => s.model)).size === 2;
    // Two captures must come from two DIFFERENT Pi sessions. Without this the
    // byte comparison above is re-readable as a tautology: if both sides record
    // the same sessionId, `captureFor` resolves to one file, `deliveredPrompts`
    // is that file twice, and "identical" is true because it is comparing a
    // string to itself. Verified: pinning both sides to session[0] leaves every
    // other clause in this gate green.
    const distinctSessions =
      sides.length === 2 &&
      sides.every((s) => typeof s.sessionId === "string" && s.sessionId.length > 0) &&
      new Set(sides.map((s) => s.sessionId)).size === 2;
    // …and each capture is the one that side's own process wrote.
    const capturesOwnedBySides =
      distinctSessions && captures.every((c, i) => c?.sessionId === sides[i].sessionId);
    const hashes = new Set(sides.map((s) => s.promptHash));

    gate(
      "G2",
      "clean-room: both sides were LAUNCHED with byte-identical rendered bytes (recorded hash matches what Pi actually received)",
      res.ok === true &&
        res.data?.spawned === true &&
        distinctModels &&
        distinctSessions &&
        capturesOwnedBySides &&
        everySideLaunched &&
        deliveredIdentical &&
        hashesMatchDelivery &&
        renderedReachedModels &&
        res.data.promptsIdentical === true &&
        hashes.size === 1,
      `launched=${everySideLaunched} deliveredIdentical=${deliveredIdentical} hashMatchesDelivery=${hashesMatchDelivery} rendered=${renderedReachedModels} distinctSessions=${distinctSessions} ownedBySides=${capturesOwnedBySides} identical=${res.data?.promptsIdentical} distinctHashes=${hashes.size}`,
    );

    stubChild.kill("SIGKILL");
    stubChild = undefined;
  }

  // G3 — same-family opinion panel refused
  {
    const taskId = await newTask("Same-family opinion");
    const body = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: [
        { role: "planner", model: "anthropic/claude-fable-5", thinking: "high", family: "anthropic", cleanRoom: true },
        { role: "planner", model: "anthropic/claude-sonnet-4-5", thinking: "high", family: "anthropic", cleanRoom: true },
      ],
    });
    gate(
      "G3",
      "same-family /opinion panel → POLICY_VIOLATION",
      body.ok === false && body.error?.code === "POLICY_VIOLATION",
      body.error?.code,
    );
  }

  // G4 — /fusion contract enforcement
  {
    const taskId = await newTask("Fusion contract");
    const bad = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "fusion",
      casts: CROSS_FAMILY,
      instruction: "Here is a merged plan with no attribution spans at all.",
    });
    const good = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "fusion",
      casts: CROSS_FAMILY,
      instruction: [
        "[ARCHITECT]",
        "Keep NDJSON.",
        "[BUILDER]",
        "Add an index.",
        "[FUSION]",
        "Keep NDJSON and add an index.",
        "## Consensus & Divergence",
        "Both agree on NDJSON; they diverge on indexing cost.",
        "## Decision ledger",
        "Chose the architect's durability argument over averaging.",
      ].join("\n"),
    });
    gate(
      "G4",
      "/fusion contract enforced (missing spans → FUSION_CONTRACT; complete artifact accepted)",
      bad.ok === false && bad.error?.code === "FUSION_CONTRACT" && good.ok === true && good.data?.contractOk === true,
      `bad=${bad.error?.code} good=${good.data?.contractOk}`,
    );
  }

  // G6 — session-key gate end-to-end in the daemon (HTTP), not an out-of-process eval:
  // two models → two dirs; wipe one; live restart reconcile respawns only that role.
  {
    const taskId = await newTask("Session key gate");
    await callTool(token, "resolve_cast", {
      taskId,
      roles: CROSS_FAMILY.map(({ role, model, thinking, cleanRoom }) => ({
        role,
        model,
        thinking,
        cleanRoom,
      })),
      familyCheckOverride: false,
    });
    const spawnA = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "high",
      cleanRoom: true,
    });
    const sessionA = spawnA.data?.session?.sessionId;
    const sessionB = spawnB.data?.session?.sessionId;
    const sessionKeyDir = (role, model) => {
      const key = createHash("sha256")
        .update(`${projectId}|${role}|${model}`)
        .digest("hex")
        .slice(0, 32);
      return join(home, "sessions", key);
    };
    const dirA = sessionKeyDir("planner", "anthropic/claude-fable-5");
    const dirB = sessionKeyDir("planner", "openai/gpt-5.6-sol");
    const dirsDiffer =
      spawnA.ok === true &&
      spawnB.ok === true &&
      typeof sessionA === "string" &&
      typeof sessionB === "string" &&
      sessionA !== sessionB &&
      existsSync(dirA) &&
      existsSync(dirB) &&
      dirA !== dirB;

    // Wipe exactly the openai side's session directory on disk.
    rmSync(dirB, { recursive: true, force: true });

    // Live reconcile via daemon restart (rehydrateRuntime → reconcileMissingCastRoles).
    child.kill("SIGKILL");
    await sleep(400);
    child = startDaemon(home, PORT);
    token = await waitForHealth(home, PORT);

    const state = await (await api("/v1/fleet/state", token)).json();
    const taskSessions = (state.state?.sessions ?? []).filter((s) => s.taskId === taskId);
    const anthropicLive = taskSessions.filter(
      (s) =>
        s.model === "anthropic/claude-fable-5" &&
        (s.status === "running" || s.status === "starting" || s.status === "settled"),
    );
    const openaiLive = taskSessions.filter(
      (s) =>
        s.model === "openai/gpt-5.6-sol" &&
        (s.status === "running" || s.status === "starting" || s.status === "settled"),
    );
    const openaiLost = taskSessions.some(
      (s) => s.sessionId === sessionB && s.status === "lost",
    );
    const survivorUnchanged =
      anthropicLive.length === 1 && anthropicLive[0]?.sessionId === sessionA;
    const exactlyOneNewOpenai =
      openaiLive.length === 1 &&
      openaiLive[0]?.sessionId !== sessionB &&
      openaiLive[0]?.role === "planner" &&
      openaiLive[0]?.model === "openai/gpt-5.6-sol";
    const wipedDirRestored = existsSync(dirB);
    const survivorDirIntact = existsSync(dirA);
    const taskPhase = (state.state?.tasks ?? []).find((t) => t.id === taskId)?.phase;
    const taskNotWhollyLost = taskPhase !== "SESSION_LOST";

    gate(
      "G6",
      "session-key gate: model change → new dir; restart resumes only the missing role",
      dirsDiffer &&
        survivorUnchanged &&
        exactlyOneNewOpenai &&
        openaiLost &&
        wipedDirRestored &&
        survivorDirIntact &&
        taskNotWhollyLost,
      `dirsDiffer=${dirsDiffer} survivor=${anthropicLive[0]?.sessionId === sessionA} newOpenai=${exactlyOneNewOpenai} lost=${openaiLost} phase=${taskPhase}`,
    );
  }

  // G7 — editing the global template changes the next rendered instruction
  {
    const taskId = await newTask("Template edit");
    const templatePath = join(home, "prompts", "fusion", "opinion.md");
    const before = readFileSync(templatePath, "utf8");
    writeFileSync(templatePath, `${before}\n\nGATE-MARKER-G7\n`);
    const res = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: CROSS_FAMILY,
      vars: { QUESTION: "q", CONTEXT: "c" },
    });
    const detail = await (
      await api(`/v1/tasks/${taskId}/fusion/${res.data.runId}`, token)
    ).json();
    gate(
      "G7",
      "global template edit changes the next run's rendered instruction (hash-verified)",
      res.ok === true &&
        detail.instruction.includes("GATE-MARKER-G7") &&
        detail.run.templateLayer === "global" &&
        typeof detail.run.renderedHash === "string",
      `layer=${detail.run?.templateLayer} marker=${detail.instruction?.includes("GATE-MARKER-G7")}`,
    );
    writeFileSync(templatePath, before);
  }

  // G8 — undefined {{VAR}} is a typed error, never a half-rendered prompt
  {
    const taskId = await newTask("Undefined var");
    const templatePath = join(home, "prompts", "fusion", "opinion.md");
    const before = readFileSync(templatePath, "utf8");
    writeFileSync(templatePath, `${before}\n\n{{DEFINITELY_UNDEFINED_VAR}}\n`);
    const body = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: CROSS_FAMILY,
      vars: { QUESTION: "q", CONTEXT: "c" },
    });
    gate(
      "G8",
      "undefined {{VAR}} → typed VALIDATION_ERROR (never a half-rendered prompt)",
      body.ok === false &&
        body.error?.code === "VALIDATION_ERROR" &&
        String(body.error?.message ?? "").includes("DEFINITELY_UNDEFINED_VAR"),
      `code=${body.error?.code}`,
    );
    writeFileSync(templatePath, before);
  }

  // G9 — project prompt override beats global
  {
    const taskId = await newTask("Project override");
    const projectPromptDir = join(repo, ".agentos", "prompts", "fusion");
    mkdirSync(projectPromptDir, { recursive: true });
    writeFileSync(
      join(projectPromptDir, "opinion.md"),
      "# Project opinion template\n\n{{QUESTION}}\n\nPROJECT-LAYER-MARKER\n",
    );
    const res = await callTool(token, "dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: CROSS_FAMILY,
      vars: { QUESTION: "q", CONTEXT: "c" },
    });
    const detail = await (
      await api(`/v1/tasks/${taskId}/fusion/${res.data.runId}`, token)
    ).json();
    gate(
      "G9",
      "project prompt override wins over global",
      res.ok === true &&
        detail.run.templateLayer === "project" &&
        detail.instruction.includes("PROJECT-LAYER-MARKER"),
      `layer=${detail.run?.templateLayer}`,
    );
    rmSync(join(repo, ".agentos"), { recursive: true, force: true });
  }

  // G10 — customization detection + three-way diff data
  {
    const templatePath = join(home, "prompts", "fusion", "fusion.md");
    const before = readFileSync(templatePath, "utf8");
    const listBefore = await (await api("/v1/prompts", token)).json();
    const pristine = (listBefore.templates ?? []).find((t) => t.ref === "fusion/fusion.md");

    writeFileSync(templatePath, `${before}\n\nCAPTAIN-CUSTOMIZATION\n`);
    const listAfter = await (await api("/v1/prompts", token)).json();
    const customized = (listAfter.templates ?? []).find((t) => t.ref === "fusion/fusion.md");
    const diff = await (
      await api("/v1/prompts/diff?ref=fusion%2Ffusion.md", token)
    ).json();

    gate(
      "G10",
      "customized-template detection + three-way diff data served",
      pristine?.customized === false &&
        customized?.customized === true &&
        diff.customized === true &&
        typeof diff.shippedAtInstall === "string" &&
        typeof diff.shippedNow === "string" &&
        String(diff.yours ?? "").includes("CAPTAIN-CUSTOMIZATION"),
      `pristine=${pristine?.customized} customized=${customized?.customized}`,
    );
    writeFileSync(templatePath, before);
  }

  // G11 — clean-room: extension injects nothing model-visible for crew roles;
  // crew session cannot read_run_artifacts (no peer cross-reads).
  {
    const extPath = join(ROOT, "packages", "pi-extension", "dist", "extension.js");
    const extMod = await import(pathToFileURL(extPath).href);
    const agentOsPiExtension = extMod.default;

    const registeredPlanner = [];
    process.env.AGENTOS_SOCKET = join(home, "g11-planner.sock");
    process.env.AGENTOS_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FG1";
    process.env.AGENTOS_ROLE = "planner";
    const plannerHost = agentOsPiExtension({
      version: "0.82.0",
      registerTool: (def) => registeredPlanner.push(def.name),
    });
    plannerHost?.close?.();

    const registeredBrain = [];
    process.env.AGENTOS_SOCKET = join(home, "g11-brain.sock");
    process.env.AGENTOS_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FG2";
    process.env.AGENTOS_ROLE = "brain";
    const brainHost = agentOsPiExtension({
      version: "0.82.0",
      registerTool: (def) => registeredBrain.push(def.name),
    });
    brainHost?.close?.();
    delete process.env.AGENTOS_SOCKET;
    delete process.env.AGENTOS_SESSION_ID;
    delete process.env.AGENTOS_ROLE;

    const taskId = await newTask("Clean-room no cross-read");
    await callTool(token, "resolve_cast", {
      taskId,
      roles: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });
    const spawn = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const crewSessionId = spawn.data?.session?.sessionId;
    const denied = await (await api("/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "read_run_artifacts",
        input: { taskId },
        sessionId: crewSessionId,
      }),
    })).json();
    const captainOk = await callTool(token, "read_run_artifacts", { taskId });

    gate(
      "G11",
      "clean-room: no model-visible tools on crew; crew read_run_artifacts → UNAUTHORIZED_TOOL",
      registeredPlanner.length === 0 &&
        registeredBrain.includes("dispatch_fusion") &&
        registeredBrain.includes("read_run_artifacts") &&
        spawn.ok === true &&
        typeof crewSessionId === "string" &&
        denied.ok === false &&
        denied.error?.code === "UNAUTHORIZED_TOOL" &&
        captainOk.ok === true,
      `plannerTools=${registeredPlanner.length} brainTools=${registeredBrain.length} denied=${denied.error?.code}`,
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
    child?.kill("SIGTERM");
  } catch {
    // ignore
  }
  try {
    stubChild?.kill("SIGTERM");
  } catch {
    // ignore
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.exit(exitCode);
