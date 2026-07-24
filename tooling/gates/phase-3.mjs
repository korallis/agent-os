#!/usr/bin/env node
/**
 * Phase 3 executable gates (master plan §11 Phase 3).
 * Tool surface, scripted local SHIP, cross-family policy, BRAIN_DOWN, absorb.
 *
 * Usage: node tooling/gates/phase-3.mjs
 * Exit 0 = all gates green.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startDaemon(home, port) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_FAKE_TMUX: "1",
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GIT: "1",
      AGENTOS_FAKE_GATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 15000) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
      const response = await fetch(`${base}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const body = await response.json();
        if (body.daemon?.home === home) return token;
      }
    } catch {
      // not up
    }
    await sleep(100);
  }
  throw new Error(`daemon did not come up on ${port}`);
}

async function api(base, path, token, init = {}) {
  const headers = { ...(init.headers ?? {}), "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-gate-repo-"));
  writeFileSync(join(dir, "README.md"), "# gate fixture\n");
  return dir;
}

let home;
let child;
const cleanups = [];
const PORT = 4700 + Math.floor(Math.random() * 1000) + 200;
const BASE = `http://127.0.0.1:${PORT}`;

try {
  home = mkdtempSync(join(tmpdir(), "agentos-p3-gate-"));
  cleanups.push(home);
  child = startDaemon(home, PORT);
  const token = await waitForHealth(home, PORT);

  // G1 — fleet + brain endpoints
  {
    const res = await api(BASE, "/v1/fleet", token);
    const body = await res.json();
    const ok = res.ok && body.summary?.brain?.status === "running";
    gate("G1", "fleet summary + brain running", ok, `brain=${body.summary?.brain?.status}`);
  }

  // G2 — project + create_task
  const repo = fixtureRepo();
  cleanups.push(repo);
  let projectId;
  let taskId;
  {
    const pr = await api(BASE, "/v1/projects", token, {
      method: "POST",
      body: JSON.stringify({ name: "gate", path: repo, mode: "local-only", trusted: true }),
    });
    const pb = await pr.json();
    projectId = pb.project?.id;
    const tr = await api(BASE, "/v1/tasks", token, {
      method: "POST",
      body: JSON.stringify({
        spec: {
          shape: "SHIP",
          title: "Gate ship",
          intent: "local only",
          projectId,
          mode: "local-only",
          yolo: true,
        },
        idempotencyKey: "p3-g2",
      }),
    });
    const tb = await tr.json();
    taskId = tb.task?.id;
    gate("G2", "register project + create_task", pr.ok && tr.ok && !!taskId, taskId);
  }

  // G3 — illegal transition run_gate
  {
    const res = await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "run_gate",
        input: { taskId, target: "baseline" },
      }),
    });
    const body = await res.json();
    gate(
      "G3",
      "run_gate before GATE_AUTHORING → ILLEGAL_TRANSITION",
      body.ok === false && body.error?.code === "ILLEGAL_TRANSITION",
      body.error?.code,
    );
  }

  // G4 — cross-family policy (claude-agent-sdk vs anthropic)
  {
    const res = await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "resolve_cast",
        input: {
          taskId,
          roles: [
            {
              role: "builder",
              model: "claude-agent-sdk/claude-sonnet-4-5",
              thinking: "medium",
              cleanRoom: true,
            },
            {
              role: "validator",
              model: "anthropic/claude-sonnet-4-5",
              thinking: "medium",
              cleanRoom: true,
            },
          ],
          familyCheckOverride: false,
        },
      }),
    });
    const body = await res.json();
    gate(
      "G4",
      "same-family builder/validator → POLICY_VIOLATION",
      body.ok === false && body.error?.code === "POLICY_VIOLATION",
      body.error?.code,
    );
  }

  // G5 — scripted local SHIP end-to-end
  {
    await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "resolve_cast",
        input: {
          taskId,
          roles: [
            { role: "builder", model: "openai/gpt-4.1", thinking: "medium", cleanRoom: true },
          ],
          familyCheckOverride: false,
        },
      }),
    });
    await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "spawn_crewmate",
        input: {
          taskId,
          role: "builder",
          model: "openai/gpt-4.1",
          thinking: "medium",
          vars: {},
        },
      }),
    });
    const deliver = await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({ tool: "deliver_task", input: { taskId } }),
    });
    const body = await deliver.json();
    gate(
      "G5",
      "scripted local-only SHIP → DONE with ao/* branch",
      body.ok === true && body.data?.phase === "DONE" && String(body.data?.branch ?? "").startsWith("ao/"),
      `phase=${body.data?.phase} branch=${body.data?.branch}`,
    );
  }

  // G6 — fleet state readable
  {
    const state = await api(BASE, "/v1/fleet/state", token);
    const sb = await state.json();
    const ok = state.ok && Array.isArray(sb.state?.tasks);
    gate("G6", "fleet state readable after run", ok, `tasks=${sb.state?.tasks?.length}`);
  }

  // G7 — BRAIN_DOWN blocks orchestration
  {
    child.kill("SIGTERM");
    await sleep(800);
    const home2 = mkdtempSync(join(tmpdir(), "agentos-p3-bd-"));
    cleanups.push(home2);
    mkdirSync(join(home2, "config"), { recursive: true });
    writeFileSync(
      join(home2, "config", "brain.json5"),
      `{ cast: "auto", thinking: "high", preferenceOrder: ["best-available via any api-key"], handoff: { thresholdPct: 80, target: "same-family-api-key" }, respawnBlocked: true }\n`,
    );
    const port2 = PORT + 1;
    const base2 = `http://127.0.0.1:${port2}`;
    child = startDaemon(home2, port2);
    const token2 = await waitForHealth(home2, port2);
    const brain = await api(base2, "/v1/brain", token2);
    const bb = await brain.json();
    const repo2 = fixtureRepo();
    cleanups.push(repo2);
    const pr = await api(base2, "/v1/projects", token2, {
      method: "POST",
      body: JSON.stringify({ name: "bd", path: repo2, mode: "local-only" }),
    });
    const pid = (await pr.json()).project?.id;
    const tr = await api(base2, "/v1/tasks", token2, {
      method: "POST",
      body: JSON.stringify({
        spec: {
          shape: "SHIP",
          title: "bd",
          intent: "i",
          projectId: pid,
          mode: "local-only",
          yolo: false,
        },
      }),
    });
    const tid = (await tr.json()).task?.id;
    const spawn = await api(base2, "/v1/tools/call", token2, {
      method: "POST",
      body: JSON.stringify({
        tool: "spawn_crewmate",
        input: { taskId: tid, role: "builder", model: "openai/gpt-4.1", thinking: "low", vars: {} },
      }),
    });
    const sb = await spawn.json();
    gate(
      "G7",
      "BRAIN_DOWN blocks spawn_crewmate",
      bb.brain?.status === "down" && sb.ok === false && sb.error?.code === "BRAIN_DOWN",
      `brain=${bb.brain?.status} err=${sb.error?.code}`,
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
    child?.kill("SIGTERM");
  } catch {
    // ignore
  }
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
