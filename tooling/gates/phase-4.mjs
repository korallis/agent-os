#!/usr/bin/env node
/**
 * Phase 4 executable gates (master plan §11 Phase 4) — fusion primitives.
 *
 *   G1  `/opinion` default path spawns sides and writes per-side artifacts
 *   G2  clean-room: every side receives byte-identical rendered bytes
 *   G3  same-family `/opinion` panel is refused (an echo is not an opinion)
 *   G4  `/fusion` contract enforcement — missing spans → FUSION_CONTRACT
 *   G5  aggregator family retention: recorded, and equals the architect family
 *   G6  session-key gate: model change → new dir; restart resumes only missing role
 *   G7  template edit (global layer) changes the next run's rendered instruction
 *   G8  `{{VAR}}` with an undefined variable → typed VALIDATION_ERROR
 *   G9  project prompt override wins over global
 *   G10 customized-template detection + three-way diff data served
 *
 * Runs against a real daemon; only the model is simulated.
 * Usage: node tooling/gates/phase-4.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p4-${process.pid}`;
const PORT = 4700 + 300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

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

async function api(path, token, init = {}) {
  const headers = { ...(init.headers ?? {}), "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...init, headers });
}
async function callTool(token, tool, input) {
  return (await api("/v1/tools/call", token, {
    method: "POST",
    body: JSON.stringify({ tool, input }),
  })).json();
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

const cleanups = [];
let child;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p4-home-"));
  cleanups.push(home);
  child = startDaemon(home, PORT);
  const token = await waitForHealth(home, PORT);

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

  // G1 + G2 + G5 — /opinion default path, clean-room byte identity, aggregator family
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

    const hashes = new Set((run?.sides ?? []).map((s) => s.promptHash));
    gate(
      "G2",
      "clean-room: every side received byte-identical rendered bytes",
      res.data.promptsIdentical === true && hashes.size === 1,
      `identical=${res.data.promptsIdentical} distinctHashes=${hashes.size}`,
    );

    gate(
      "G5",
      "aggregator family retained from the architect side",
      res.data.aggregatorFamily === "anthropic" && run?.aggregatorFamily === "anthropic",
      `aggregator=${run?.aggregatorFamily}`,
    );
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

  // G6 — session-key gate end-to-end: model change → new dir; restart resumes only missing
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
    // Spawn first planner only — creates one session dir via the live ensure path.
    const spawned = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const evalJs = `
      import { existsSync, rmSync } from 'node:fs';
      import { SessionKeyStore } from '${join(ROOT, "apps/orchestrator/dist/fleet/sessions.js")}';
      const store = new SessionKeyStore(${JSON.stringify(home)});
      const projectId = ${JSON.stringify(projectId)};
      const a = store.ensure({ projectId, role: 'planner', model: 'anthropic/claude-fable-5' });
      const b = store.ensure({ projectId, role: 'planner', model: 'openai/gpt-5.6-sol' });
      if (a.dir === b.dir) process.exit(2);
      if (a.key === b.key) process.exit(3);
      // Restart half: wipe the second model dir; missingRoles must report only that slot.
      rmSync(b.dir, { recursive: true, force: true });
      const missing = store.missingRoles(projectId, [
        { role: 'planner', model: 'anthropic/claude-fable-5' },
        { role: 'planner', model: 'openai/gpt-5.6-sol' },
      ]);
      if (missing.length !== 1) process.exit(4);
      if (missing[0].model !== 'openai/gpt-5.6-sol') process.exit(5);
      if (!existsSync(a.dir)) process.exit(6);
      process.stdout.write('ok');
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", evalJs], {
      encoding: "utf8",
    });
    gate(
      "G6",
      "session-key gate: model change → new dir; restart resumes only the missing role",
      spawned.ok === true && run.status === 0 && run.stdout.trim() === "ok",
      `spawn=${spawned.ok} exit=${run.status} out=${run.stdout.trim()} err=${(run.stderr ?? "").slice(0, 120)}`,
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  try {
    child?.kill("SIGTERM");
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
