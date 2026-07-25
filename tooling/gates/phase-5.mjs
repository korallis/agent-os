#!/usr/bin/env node
/**
 * Phase 5 executable gates (master plan §11 Phase 5) — cross-family auto-validation.
 *
 *   G1  GATE_ERROR is not RED — a gate that could not run proves nothing
 *   G2  baseline-pass fixture → GATE DEFECT, no builder spawn
 *   G3  same-family builder/validator refused at spawn too, not only at cast
 *   G4  validator is write-jailed to the gate workspace; builder never sees it
 *   G5  verbatim FAIL lines are substrate-composed and hash-matched
 *   G6  editing the gate drops its RED proof — candidate refused until re-proven
 *   G7  uv/PEP 723: a gate importing a dependency absent from the project runs
 *       in its own cached venv without touching the product tree
 *   G8  gateLanguage "ts" override runs gate.ts via node strip-types
 *   G9  halt lands exactly on the configured cap, and on a RECONFIGURED cap
 *
 * Real uv, real git, real tmux; only the model is simulated.
 * Usage: node tooling/gates/phase-5.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p5-${process.pid}`;
const PORT = 4700 + 700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(home, port, extraEnv = {}) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      ...extraEnv,
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

async function api(path, token, init = {}, base = BASE) {
  // Respect an explicit content-type (config writes are JSON5 as text/plain).
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}

/**
 * Return every worktree this task holds. Gates run many tasks against one
 * pool, so each block stops its crewmates when done — the same thing the Brain
 * does in real operation via stop_crewmate or deliver_task.
 */
async function releaseTask(token, taskId, base = BASE) {
  const state = await (await api("/v1/fleet/state", token, {}, base)).json();
  for (const session of state.state?.sessions ?? []) {
    if (session.taskId !== taskId) continue;
    if (session.status === "stopped" || session.status === "lost") continue;
    await callTool(token, "stop_crewmate", { sessionId: session.sessionId, reason: "gate block done" }, base);
  }
}
async function callTool(token, tool, input, base = BASE) {
  return (
    await api("/v1/tools/call", token, { method: "POST", body: JSON.stringify({ tool, input }) }, base)
  ).json();
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p5-repo-"));
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "gate@agent-os.local");
  git("config", "user.name", "Agent OS Gate");
  writeFileSync(join(dir, "README.md"), "# p5 fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

const cleanups = [];
let child;

/** Drive a task to the point where a candidate gate may run. */
async function readyTask(token, projectId, title, opts = {}) {
  const taskId = (
    await (
      await api("/v1/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          spec: {
            shape: "SHIP",
            title,
            intent: "auto-validate fixture",
            projectId,
            mode: "local-only",
            yolo: true,
          },
        }),
      })
    ).json()
  ).task.id;

  await callTool(token, "resolve_cast", {
    taskId,
    roles: [
      { role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true },
      { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
    ],
    familyCheckOverride: false,
  });
  await callTool(token, "author_gate", {
    taskId,
    validatorCast: {
      role: "validator",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      family: "anthropic",
      cleanRoom: true,
    },
    ...(opts.gateSource !== undefined ? { gateSource: opts.gateSource } : {}),
  });
  return taskId;
}

const RED_THEN_GREEN_GATE = `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import os
if os.environ.get("AGENTOS_GATE_TARGET") == "baseline":
    print("EXPECTED_RED")
    print("FAIL feature absent at baseline")
    raise SystemExit(1)
print("PASS")
`;

try {
  if (spawnSync("uv", ["--version"], { encoding: "utf8" }).status !== 0) {
    throw new Error("uv is required for the Phase 5 gates (hard v1 dependency)");
  }

  const home = mkdtempSync(join(tmpdir(), "agentos-p5-home-"));
  cleanups.push(home);
  child = startDaemon(home, PORT);
  let token = await waitForHealth(home, PORT);

  const repo = fixtureRepo();
  cleanups.push(repo);
  const projectId = (
    await (
      await api("/v1/projects", token, {
        method: "POST",
        body: JSON.stringify({ name: "p5", path: repo, mode: "local-only", trusted: true }),
      })
    ).json()
  ).project.id;

  // G1 — a gate that cannot run is GATE_ERROR, never RED
  {
    const taskId = await readyTask(token, projectId, "Infra error", {
      gateSource: `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["this-package-does-not-exist-agentos-gate-fixture"]
# ///
print("PASS")
`,
    });
    const body = await callTool(token, "run_gate", { taskId, target: "baseline" });
    const task = await (await api(`/v1/tasks/${taskId}`, token)).json();
    gate(
      "G1",
      "unrunnable gate → GATE_ERROR (infrastructure), never a RED verdict",
      body.ok === false &&
        body.error?.code === "GATE_ERROR" &&
        task.task.phase !== "GATE_RED_VERIFIED",
      `err=${body.error?.code} phase=${task.task?.phase}`,
    );
  }

  // G2 — EXPECTED_RED before builder: refuse spawn with no baseline at all,
  // and refuse after a baseline that PASSES (gate defect).
  {
    const beforeBaselineId = await readyTask(token, projectId, "No baseline yet", {
      gateSource: RED_THEN_GREEN_GATE,
    });
    const earlySpawn = await callTool(token, "spawn_crewmate", {
      taskId: beforeBaselineId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    const earlyMsg = String(earlySpawn.error?.message ?? "");
    const earlyRefused =
      earlySpawn.ok === false &&
      earlySpawn.error?.code === "POLICY_VIOLATION" &&
      /missing RED baseline proof|EXPECTED_RED/i.test(earlyMsg);

    const taskId = await readyTask(token, projectId, "Baseline defect", {
      gateSource: `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
print("PASS")
`,
    });
    const body = await callTool(token, "run_gate", { taskId, target: "baseline" });
    const spawned = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    gate(
      "G2",
      "builder refused before any baseline (names missing RED proof); baseline PASS → GATE DEFECT",
      earlyRefused &&
        body.ok === false &&
        String(body.error?.message ?? "").includes("GATE DEFECT") &&
        spawned.ok === false,
      `early=${earlySpawn.error?.code} earlyMsg=${earlyMsg.slice(0, 80)} gate=${body.error?.code} spawn=${spawned.error?.code}`,
    );
  }

  // G3 — same-family builder/validator refused at SPAWN, not just at cast
  {
    const taskId = await readyTask(token, projectId, "Cross family at spawn", {
      gateSource: RED_THEN_GREEN_GATE,
    });
    await callTool(token, "run_gate", { taskId, target: "baseline" });
    const body = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "builder",
      // Same family as the validator resolved in readyTask (anthropic).
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
      vars: {},
    });
    gate(
      "G3",
      "same-family builder/validator refused at spawn (not only at resolve_cast)",
      body.ok === false && body.error?.code === "POLICY_VIOLATION",
      body.error?.code,
    );
  }

  // G4 — validator write-jailed; builder tree separate; builder tool path into
  // the gate workspace is BLOCKED and an ext.tool_blocked frame is emitted.
  let jailTaskId;
  {
    jailTaskId = await readyTask(token, projectId, "Write jail", {
      gateSource: RED_THEN_GREEN_GATE,
    });
    await callTool(token, "run_gate", { taskId: jailTaskId, target: "baseline" });
    const validator = await callTool(token, "spawn_crewmate", {
      taskId: jailTaskId,
      role: "validator",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      vars: {},
    });
    const builder = await callTool(token, "spawn_crewmate", {
      taskId: jailTaskId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    const gateWorkspace = join(home, "runs", jailTaskId, "gate-workspace");
    const validatorPath = validator.data?.session?.worktreePath ?? "";
    const builderPath = builder.data?.session?.worktreePath ?? "";
    const blockedAbs = join(gateWorkspace, "gate.py");

    // Drive the real extension entry: builder role + AGENTOS_GATE_WORKSPACE must
    // block a read of an absolute path inside the gate dir and emit ext.tool_blocked.
    const { createServer } = await import("node:net");
    const { agentOsPiExtension } = await import(
      join(ROOT, "packages", "pi-extension", "dist", "index.js")
    );
    const sockDir = mkdtempSync(join(tmpdir(), "agentos-p5-g4-"));
    cleanups.push(sockDir);
    const sockPath = join(sockDir, "ext.sock");
    const frames = [];
    let toolCallHandler = null;
    const blockResult = await new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length === 0) continue;
            try {
              frames.push(JSON.parse(line));
            } catch {
              // ignore
            }
          }
        });
      });
      server.on("error", reject);
      server.listen(sockPath, () => {
        const prev = {
          socket: process.env.AGENTOS_SOCKET,
          session: process.env.AGENTOS_SESSION_ID,
          role: process.env.AGENTOS_ROLE,
          gate: process.env.AGENTOS_GATE_WORKSPACE,
        };
        process.env.AGENTOS_SOCKET = sockPath;
        process.env.AGENTOS_SESSION_ID = builder.data?.session?.sessionId ?? "01ARZ3NDEKTSV4RRFFQ69G5FG4";
        process.env.AGENTOS_ROLE = "builder";
        process.env.AGENTOS_GATE_WORKSPACE = gateWorkspace;
        const pi = {
          version: "0.82.0",
          on: (event, handler) => {
            if (event === "tool_call") toolCallHandler = handler;
          },
        };
        const host = agentOsPiExtension(pi);
        if (host === undefined || toolCallHandler === null) {
          server.close();
          reject(new Error("extension did not register tool_call fence"));
          return;
        }
        void host.connect().then(() => {
          const result = toolCallHandler({
            toolName: "read",
            toolCallId: "t1",
            input: { path: blockedAbs },
          });
          setTimeout(() => {
            host.close();
            server.close();
            if (prev.socket === undefined) delete process.env.AGENTOS_SOCKET;
            else process.env.AGENTOS_SOCKET = prev.socket;
            if (prev.session === undefined) delete process.env.AGENTOS_SESSION_ID;
            else process.env.AGENTOS_SESSION_ID = prev.session;
            if (prev.role === undefined) delete process.env.AGENTOS_ROLE;
            else process.env.AGENTOS_ROLE = prev.role;
            if (prev.gate === undefined) delete process.env.AGENTOS_GATE_WORKSPACE;
            else process.env.AGENTOS_GATE_WORKSPACE = prev.gate;
            resolve(result);
          }, 80);
        });
      });
    });

    const blockedOk =
      blockResult &&
      blockResult.block === true &&
      String(blockResult.reason ?? "").includes("tool/fs-blocked");
    const toolBlockedFrame = frames.find((f) => f.type === "ext.tool_blocked");
    const toolBlockedRecorded =
      toolBlockedFrame !== undefined &&
      toolBlockedFrame.toolName === "read" &&
      String(toolBlockedFrame.reason ?? "").includes("gate workspace");

    gate(
      "G4",
      "validator write-jailed; builder blocked from gate-dir paths; ext.tool_blocked recorded",
      validator.ok === true &&
        builder.ok === true &&
        validatorPath === gateWorkspace &&
        builderPath !== gateWorkspace &&
        !builderPath.startsWith(gateWorkspace) &&
        builderPath !== repo &&
        blockedOk &&
        toolBlockedRecorded,
      `validator=${validatorPath === gateWorkspace} blocked=${blockedOk} tool_blocked=${toolBlockedRecorded}`,
    );
    await releaseTask(token, jailTaskId);
  }

  // G5 — verbatim FAIL is substrate-composed and hash-matched
  {
    const taskId = await readyTask(token, projectId, "Verbatim fail", {
      gateSource: `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import os
print("EXPECTED_RED" if os.environ.get("AGENTOS_GATE_TARGET") == "baseline" else "FAIL")
print("FAIL expected 42 but got 41")
raise SystemExit(1)
`,
    });
    await callTool(token, "run_gate", { taskId, target: "baseline" });
    const builder = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    const sessionId = builder.data?.session?.sessionId;
    await callTool(token, "run_gate", { taskId, target: "candidate" });
    const sent = await callTool(token, "send_to_crew", { sessionId, gateFailRef: "last" });

    const failText = readFileSync(
      join(home, "runs", taskId, "gate-workspace", "last-fail.txt"),
      "utf8",
    );
    const failHashFile = readFileSync(
      join(home, "runs", taskId, "gate-workspace", "last-fail.sha256"),
      "utf8",
    ).trim();
    gate(
      "G5",
      "verbatim FAIL substrate-composed and hash-matched",
      sent.ok === true &&
        sent.data?.failHash === failHashFile &&
        failText.includes("expected 42 but got 41"),
      `hashMatch=${sent.data?.failHash === failHashFile}`,
    );
    await releaseTask(token, taskId);
  }

  // G6 — editing the gate drops its RED proof
  {
    const taskId = await readyTask(token, projectId, "Gate revision", {
      gateSource: RED_THEN_GREEN_GATE,
    });
    await callTool(token, "run_gate", { taskId, target: "baseline" });
    await callTool(token, "spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    const beforeEdit = await callTool(token, "run_gate", { taskId, target: "candidate" });

    // Validator revises the gate — the old RED proof must not carry over.
    const gatePath = join(home, "runs", taskId, "gate-workspace", "gate.py");
    writeFileSync(gatePath, `${readFileSync(gatePath, "utf8")}\n# revision 2\n`);
    const afterEdit = await callTool(token, "run_gate", { taskId, target: "candidate" });

    gate(
      "G6",
      "gate revision drops the RED proof — candidate refused until re-proven",
      beforeEdit.ok === true &&
        afterEdit.ok === false &&
        afterEdit.error?.code === "GATE_ERROR" &&
        String(afterEdit.error?.message ?? "").includes("RED baseline proof"),
      `before=${beforeEdit.ok} after=${afterEdit.error?.code}`,
    );
    await releaseTask(token, taskId);
  }

  // G7 — PEP 723 inline dependency resolves in its own venv, product tree untouched
  {
    const taskId = await readyTask(token, projectId, "PEP 723 isolation", {
      gateSource: `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["six"]
# ///
import os, six
assert six.PY3
if os.environ.get("AGENTOS_GATE_TARGET") == "baseline":
    print("EXPECTED_RED")
    print("FAIL six present but feature absent")
    raise SystemExit(1)
print("PASS")
`,
    });
    const body = await callTool(token, "run_gate", { taskId, target: "baseline" });
    const repoEntries = readdirSync(repo);
    gate(
      "G7",
      "uv/PEP 723 inline dependency runs in an isolated venv; product tree untouched",
      body.ok === true &&
        body.data?.outcome === "EXPECTED_RED" &&
        !repoEntries.includes(".venv") &&
        !repoEntries.includes("node_modules"),
      `outcome=${body.data?.outcome} repoClean=${!repoEntries.includes(".venv")}`,
    );
  }

  // G8 — gateLanguage "ts" override runs gate.ts
  {
    const port2 = PORT + 1;
    const home2 = mkdtempSync(join(tmpdir(), "agentos-p5-ts-"));
    cleanups.push(home2);
    spawnSync("mkdir", ["-p", join(home2, "config")]);
    writeFileSync(
      join(home2, "config", "validation.json5"),
      `{ maxValidations: 6, triageAt: 3, gateLanguage: "ts", gateTimeoutSeconds: 300 }\n`,
    );
    const tsChild = startDaemon(home2, port2);
    const base2 = `http://127.0.0.1:${port2}`;
    const token2 = await waitForHealth(home2, port2);
    const repo2 = fixtureRepo();
    cleanups.push(repo2);
    const pid2 = (
      await (
        await api(
          "/v1/projects",
          token2,
          { method: "POST", body: JSON.stringify({ name: "ts", path: repo2, mode: "local-only", trusted: true }) },
          base2,
        )
      ).json()
    ).project.id;
    const taskId = (
      await (
        await api(
          "/v1/tasks",
          token2,
          {
            method: "POST",
            body: JSON.stringify({
              spec: { shape: "SHIP", title: "ts gate", intent: "i", projectId: pid2, mode: "local-only", yolo: true },
            }),
          },
          base2,
        )
      ).json()
    ).task.id;
    await callTool(
      token2,
      "resolve_cast",
      {
        taskId,
        roles: [
          { role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true },
          { role: "validator", model: "anthropic/claude-fable-5", thinking: "high", cleanRoom: true },
        ],
        familyCheckOverride: false,
      },
      base2,
    );
    await callTool(
      token2,
      "author_gate",
      {
        taskId,
        validatorCast: {
          role: "validator",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "anthropic",
          cleanRoom: true,
        },
        gateSource: `const target = process.env.AGENTOS_GATE_TARGET ?? "candidate";
if (target === "baseline") {
  console.log("EXPECTED_RED");
  console.log("FAIL ts gate red at baseline");
  process.exit(1);
}
console.log("PASS");
`,
      },
      base2,
    );
    const body = await callTool(token2, "run_gate", { taskId, target: "baseline" }, base2);
    const wroteTs = existsSync(join(home2, "runs", taskId, "gate-workspace", "gate.ts"));
    tsChild.kill("SIGTERM");
    gate(
      "G8",
      'validation.gateLanguage "ts" override runs gate.ts via node strip-types',
      body.ok === true && body.data?.outcome === "EXPECTED_RED" && wroteTs,
      `outcome=${body.data?.outcome} gate.ts=${wroteTs}`,
    );
  }

  // G9 — halt lands exactly on the configured cap, and on a RECONFIGURED cap
  {
    const failingGate = `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import os
print("EXPECTED_RED" if os.environ.get("AGENTOS_GATE_TARGET") == "baseline" else "FAIL")
print("FAIL never satisfied")
raise SystemExit(1)
`;
    const runToHalt = async (taskId) => {
      let phase = "";
      for (let i = 0; i < 12; i += 1) {
        const current = await (await api(`/v1/tasks/${taskId}`, token)).json();
        phase = current.task.phase;
        if (phase === "VALIDATION_EXHAUSTED") break;
        if (phase === "BUILDING") {
          await callTool(token, "run_gate", { taskId, target: "candidate" });
          continue;
        }
        break;
      }
      const final = await (await api(`/v1/tasks/${taskId}`, token)).json();
      return { phase: final.task.phase, attempts: final.task.validationAttempt };
    };

    const defaultTask = await readyTask(token, projectId, "Cap default", {
      gateSource: failingGate,
    });
    await callTool(token, "run_gate", { taskId: defaultTask, target: "baseline" });
    await callTool(token, "spawn_crewmate", {
      taskId: defaultTask,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    await callTool(token, "run_gate", { taskId: defaultTask, target: "candidate" });
    const atDefault = await runToHalt(defaultTask);
    await releaseTask(token, defaultTask);

    // Reconfigure the cap and prove the NEW value is honoured.
    await api("/v1/config/global/validation", token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{ maxValidations: 2 }",
    });
    await sleep(300);
    const cappedTask = await readyTask(token, projectId, "Cap reconfigured", {
      gateSource: failingGate,
    });
    await callTool(token, "run_gate", { taskId: cappedTask, target: "baseline" });
    await callTool(token, "spawn_crewmate", {
      taskId: cappedTask,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    await callTool(token, "run_gate", { taskId: cappedTask, target: "candidate" });
    const atCapped = await runToHalt(cappedTask);
    await releaseTask(token, cappedTask);

    gate(
      "G9",
      "halt lands exactly on the configured cap, and on a reconfigured cap",
      atDefault.phase === "VALIDATION_EXHAUSTED" &&
        atDefault.attempts === 6 &&
        atCapped.phase === "VALIDATION_EXHAUSTED" &&
        atCapped.attempts === 2,
      `default=${atDefault.attempts}/6 reconfigured=${atCapped.attempts}/2`,
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
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
