#!/usr/bin/env node
/**
 * Phase 5 executable gates (master plan §11 Phase 5) — cross-family auto-validation.
 *
 *   G1  GATE_ERROR is not RED — a gate that could not run proves nothing
 *   G2  baseline-pass fixture → GATE DEFECT, no builder spawn
 *   G3  same-family builder/validator refused at spawn too, not only at cast
 *   G4  validator is write-jailed to the gate workspace (a write into the
 *       project checkout is refused, audited and never reaches disk, while its
 *       own workspace stays writable); builder never sees the gate tree
 *   G5  verbatim FAIL lines are substrate-composed and hash-matched
 *   G6  editing the gate drops RED proof (forged sibling/validation disk ignored); re-prove restores
 *   G7  uv/PEP 723: a gate importing a dependency absent from the project runs
 *       in its own cached venv, in the gate workspace, and the product tree is
 *       byte-for-byte identical afterwards
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p5-${process.pid}`;
const PORT = pickPort(5400, 300);
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

/**
 * Drive the REAL extension entry (packages/pi-extension/dist/index.js) as one
 * seat and hand it a single tool_call, exactly as Pi would. Returns the fence
 * decision plus every frame the extension pushed down its daemon socket, so a
 * gate can assert the refusal AND the ext.tool_blocked audit trail.
 *
 * `tempRoots` overrides TMPDIR/TMP/TEMP for the probe: the fence treats the OS
 * temp root as neutral ground, and gate fixtures live there, so a fixture that
 * must stand in for a real (non-temp) checkout points the temp roots elsewhere.
 */
async function fenceProbe(options) {
  const { createServer } = await import("node:net");
  const { agentOsPiExtension } = await import(
    join(ROOT, "packages", "pi-extension", "dist", "index.js")
  );
  const sockDir = mkdtempSync(join(tmpdir(), "agentos-p5-fence-"));
  cleanups.push(sockDir);
  const sockPath = join(sockDir, "ext.sock");
  const frames = [];
  let toolCallHandler = null;
  const result = await new Promise((resolve, reject) => {
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
            // ignore non-JSON noise
          }
        }
      });
    });
    server.on("error", reject);
    server.listen(sockPath, () => {
      const keys = [
        "AGENTOS_SOCKET",
        "AGENTOS_SESSION_ID",
        "AGENTOS_ROLE",
        "AGENTOS_HOME",
        "AGENTOS_GATE_WORKSPACE",
        "AGENTOS_SEAT_WORKSPACE",
        "TMPDIR",
        "TMP",
        "TEMP",
      ];
      const prev = new Map(keys.map((key) => [key, process.env[key]]));
      const restore = () => {
        for (const key of keys) {
          const value = prev.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
      process.env.AGENTOS_SOCKET = sockPath;
      process.env.AGENTOS_SESSION_ID = options.sessionId;
      process.env.AGENTOS_ROLE = options.role;
      process.env.AGENTOS_HOME = options.home;
      process.env.AGENTOS_GATE_WORKSPACE = options.gateWorkspace;
      process.env.AGENTOS_SEAT_WORKSPACE = options.seatWorkspace;
      if (options.tempRoots !== undefined) {
        process.env.TMPDIR = options.tempRoots;
        process.env.TMP = options.tempRoots;
        process.env.TEMP = options.tempRoots;
      }
      const pi = {
        version: "0.82.0",
        on: (event, handler) => {
          if (event === "tool_call") toolCallHandler = handler;
        },
      };
      const host = agentOsPiExtension(pi);
      if (host === undefined || toolCallHandler === null) {
        restore();
        server.close();
        reject(new Error(`extension did not register a ${options.role} tool_call fence`));
        return;
      }
      void host.connect().then(() => {
        const decision = toolCallHandler({
          toolName: options.toolName,
          toolCallId: options.toolCallId ?? "t1",
          input: options.input,
        });
        // Let any ext.tool_blocked frame land on the socket before teardown.
        setTimeout(() => {
          host.close();
          server.close();
          restore();
          resolve(decision);
        }, 80);
      });
    });
  });
  return { result, frames };
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

/**
 * Deep listing of a tree (every path plus file size) so "the product tree was
 * not touched" means the whole tree, not just its top level. `.git` is skipped:
 * the daemon legitimately leases builder worktrees off this repo elsewhere in
 * the run, which rewrites git's own bookkeeping.
 */
function treeSnapshot(root) {
  const lines = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${rel}`);
        walk(abs, rel);
      } else {
        lines.push(`f ${rel} ${statSync(abs).size}`);
      }
    }
  };
  walk(root, "");
  return lines.join("\n");
}

let exitCode = 0;
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

  // G4 — both write-jails, driven through the real extension entry:
  //   validator: seated in the gate workspace, refused when it writes into the
  //              Captain's project checkout — refusal audited, nothing on disk,
  //              yet still free to write inside its own workspace;
  //   builder:   separate tree, refused any path into the gate workspace.
  // Asserting only "validatorPath === gateWorkspace" proves the seat LOCATION
  // and nothing about the jail: gutting validatorJailBlockReason to `return
  // null` left this gate green, which is why the validator probe below exists.
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

    // --- VALIDATOR half: the write-jail itself, not just the seat location ---
    // The fixture checkout sits under the OS temp root, which the fence treats
    // as neutral ground; a Captain's checkout does not. Point the probe's temp
    // roots at an empty scratch dir so the refusal has to come from the
    // default-deny rule under test rather than from an accident of fixtures.
    const neutralScratch = mkdtempSync(join(tmpdir(), "agentos-p5-neutral-"));
    cleanups.push(neutralScratch);
    const escapeTarget = join(repo, "pwned-by-validator.txt");
    const validatorSeat = validatorPath || gateWorkspace;
    const validatorProbe = await fenceProbe({
      role: "validator",
      sessionId: validator.data?.session?.sessionId ?? "01ARZ3NDEKTSV4RRFFQ69G5FG4",
      home,
      gateWorkspace,
      seatWorkspace: validatorSeat,
      toolName: "write",
      toolCallId: "t-validator-escape",
      input: { path: escapeTarget, content: "validator escaped its jail\n" },
      tempRoots: neutralScratch,
    });
    // Pi executes any tool the fence did not block, so model that faithfully:
    // an unblocked write really does land in the product tree. Without this the
    // "no file on disk" clause would be true by construction.
    if (validatorProbe.result?.block !== true) {
      writeFileSync(escapeTarget, "validator escaped its jail\n");
    }
    const escapedOnDisk = existsSync(escapeTarget);
    if (escapedOnDisk) rmSync(escapeTarget, { force: true });
    const validatorReason = String(validatorProbe.result?.reason ?? "");
    const validatorBlocked =
      validatorProbe.result?.block === true &&
      validatorReason.includes("write-jailed to the gate workspace") &&
      validatorReason.includes(gateWorkspace) &&
      validatorReason.includes("pwned-by-validator.txt");
    const validatorFrame = validatorProbe.frames.find(
      (f) => f.type === "ext.tool_blocked" && f.toolName === "write",
    );
    const validatorAudited =
      validatorFrame !== undefined &&
      String(validatorFrame.reason ?? "").includes("write-jailed");

    // Positive control: a fence that refuses everything is not a write-jail, it
    // is a broken seat. The validator must still write inside its own workspace.
    const validatorAllowProbe = await fenceProbe({
      role: "validator",
      sessionId: validator.data?.session?.sessionId ?? "01ARZ3NDEKTSV4RRFFQ69G5FG4",
      home,
      gateWorkspace,
      seatWorkspace: validatorSeat,
      toolName: "write",
      toolCallId: "t-validator-own",
      input: { path: join(validatorSeat, "validator-notes.md"), content: "gate notes\n" },
      tempRoots: neutralScratch,
    });
    const ownWorkspaceAllowed =
      validatorAllowProbe.result === undefined &&
      !validatorAllowProbe.frames.some((f) => f.type === "ext.tool_blocked");

    // --- BUILDER half: default-deny seat fence refuses gate-dir paths --------
    const builderProbe = await fenceProbe({
      role: "builder",
      sessionId: builder.data?.session?.sessionId ?? "01ARZ3NDEKTSV4RRFFQ69G5FG4",
      home,
      gateWorkspace,
      seatWorkspace: builderPath || join(home, "worktrees", "builder"),
      toolName: "read",
      toolCallId: "t-builder-gate-read",
      input: { path: blockedAbs },
    });
    const blockResult = builderProbe.result;
    const blockedOk =
      blockResult &&
      blockResult.block === true &&
      String(blockResult.reason ?? "").includes("tool/fs-blocked");
    const toolBlockedFrame = builderProbe.frames.find((f) => f.type === "ext.tool_blocked");
    const toolBlockedRecorded =
      toolBlockedFrame !== undefined &&
      toolBlockedFrame.toolName === "read" &&
      (String(toolBlockedFrame.reason ?? "").includes("tool/fs-blocked") ||
        String(toolBlockedFrame.reason ?? "").includes("seat workspace"));

    gate(
      "G4",
      "validator write-jailed out of the project checkout (audited, nothing on disk, own workspace still writable); builder blocked from gate-dir paths",
      validator.ok === true &&
        builder.ok === true &&
        validatorPath === gateWorkspace &&
        builderPath !== gateWorkspace &&
        !builderPath.startsWith(gateWorkspace) &&
        builderPath !== repo &&
        validatorBlocked &&
        validatorAudited &&
        escapedOnDisk === false &&
        ownWorkspaceAllowed &&
        blockedOk &&
        toolBlockedRecorded,
      `validatorSeat=${validatorPath === gateWorkspace} jailed=${validatorBlocked} audited=${validatorAudited} onDisk=${escapedOnDisk} ownWs=${ownWorkspaceAllowed} builderBlocked=${blockedOk} tool_blocked=${toolBlockedRecorded}`,
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
      join(home, "runs", taskId, "validation", "last-fail.txt"),
      "utf8",
    );
    const failHashFile = readFileSync(
      join(home, "runs", taskId, "validation", "last-fail.sha256"),
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

  // G6 — editing the gate drops its RED proof; forged proofs on every seat-writable
  // path (including the sibling validation/ the daemon used to read) are ignored
  // because authz is process memory + HMAC only. Seat cannot read the signing key
  // or mint a valid gate.red_proven across restart. Mid-build re-prove restores.
  {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, appendFileSync } = await import("node:fs");
    const { createServer } = await import("node:net");
    const taskId = await readyTask(token, projectId, "Gate revision", {
      gateSource: RED_THEN_GREEN_GATE,
    });
    await callTool(token, "run_gate", { taskId, target: "baseline" });
    const builderSpawn = await callTool(token, "spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
    });
    const beforeEdit = await callTool(token, "run_gate", { taskId, target: "candidate" });

    // From the validator cwd (gate-workspace), weaken gate.py and plant forged
    // red-proof.json in every plausible location — including ../validation/ where
    // the daemon previously read disk. Authz must still refuse the candidate.
    const gateWs = join(home, "runs", taskId, "gate-workspace");
    const gatePath = join(gateWs, "gate.py");
    const revised = `${readFileSync(gatePath, "utf8")}\n# revision 2\n`;
    writeFileSync(gatePath, revised);
    const forgedHash = createHash("sha256").update(revised).digest("hex");
    const forgedBody = `${JSON.stringify({
      gateSourceHash: forgedHash,
      outcome: "EXPECTED_RED",
      provenAt: new Date().toISOString(),
      hmac: "forged-not-a-real-hmac",
    }, null, 2)}\n`;
    const forgeTargets = [
      join(gateWs, "red-proof.json"),
      join(home, "runs", taskId, "validation", "red-proof.json"),
      join(home, "runs", taskId, "red-proof.json"),
      join(home, "runs", taskId, "task-red-proof.json"),
    ];
    for (const target of forgeTargets) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, forgedBody);
    }
    // Also try rewriting task.json redProof if present (seat cannot mint HMAC).
    const taskJsonPath = join(home, "runs", taskId, "task.json");
    try {
      const taskJson = JSON.parse(readFileSync(taskJsonPath, "utf8"));
      taskJson.redProof = {
        gateSourceHash: forgedHash,
        outcome: "EXPECTED_RED",
        provenAt: new Date().toISOString(),
        hmac: "forged-not-a-real-hmac",
      };
      writeFileSync(taskJsonPath, `${JSON.stringify(taskJson, null, 2)}\n`);
    } catch {
      // ignore
    }
    const afterEdit = await callTool(token, "run_gate", { taskId, target: "candidate" });

    // Escalation: builder seat tries to read the signing key (must be tool-blocked).
    const builderPath = builderSpawn.data?.session?.worktreePath ?? join(home, "worktrees", "x");
    const keyPath = join(home, "secrets", "gate-proof.key");
    const { agentOsPiExtension } = await import(
      join(ROOT, "packages", "pi-extension", "dist", "index.js")
    );
    const sockDir = mkdtempSync(join(tmpdir(), "agentos-p5-g6-"));
    cleanups.push(sockDir);
    const sockPath = join(sockDir, "ext.sock");
    const keyBlockFrames = [];
    let keyToolHandler = null;
    const keyBlockResult = await new Promise((resolve, reject) => {
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
              keyBlockFrames.push(JSON.parse(line));
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
          seat: process.env.AGENTOS_SEAT_WORKSPACE,
          ahome: process.env.AGENTOS_HOME,
        };
        process.env.AGENTOS_SOCKET = sockPath;
        process.env.AGENTOS_SESSION_ID =
          builderSpawn.data?.session?.sessionId ?? "01ARZ3NDEKTSV4RRFFQ69G5FG6";
        process.env.AGENTOS_ROLE = "builder";
        process.env.AGENTOS_HOME = home;
        process.env.AGENTOS_GATE_WORKSPACE = gateWs;
        process.env.AGENTOS_SEAT_WORKSPACE = builderPath;
        const pi = {
          version: "0.82.0",
          on: (event, handler) => {
            if (event === "tool_call") keyToolHandler = handler;
          },
        };
        const host = agentOsPiExtension(pi);
        if (host === undefined || keyToolHandler === null) {
          server.close();
          reject(new Error("extension did not register seat fence"));
          return;
        }
        void host.connect().then(() => {
          const result = keyToolHandler({
            toolName: "read",
            toolCallId: "t-key",
            input: { path: keyPath },
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
            if (prev.seat === undefined) delete process.env.AGENTOS_SEAT_WORKSPACE;
            else process.env.AGENTOS_SEAT_WORKSPACE = prev.seat;
            if (prev.ahome === undefined) delete process.env.AGENTOS_HOME;
            else process.env.AGENTOS_HOME = prev.ahome;
            resolve(result);
          }, 80);
        });
      });
    });
    const keyBlocked =
      keyBlockResult &&
      keyBlockResult.block === true &&
      String(keyBlockResult.reason ?? "").includes("tool/fs-blocked");
    const keyToolBlocked = keyBlockFrames.some((f) => f.type === "ext.tool_blocked");

    // Stop the daemon before forging the event log so seq stays monotonic.
    child.kill("SIGTERM");
    await sleep(500);

    // Append a forged gate.red_proven (invalid HMAC). Hydrate must refuse it.
    const eventsPath = join(home, "events", "events.ndjson");
    mkdirSync(dirname(eventsPath), { recursive: true });
    let lastSeq = 0;
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const env = JSON.parse(line);
          if (typeof env.seq === "number" && env.seq > lastSeq) lastSeq = env.seq;
        } catch {
          // ignore corrupt lines; open will quarantine
        }
      }
    }
    const forgedEvent = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FGE",
      seq: lastSeq + 1,
      ts: new Date().toISOString(),
      event: {
        type: "gate.red_proven",
        payload: {
          taskId,
          gateSourceHash: forgedHash,
          outcome: "EXPECTED_RED",
          provenAt: new Date().toISOString(),
          hmac: "forged-not-a-real-hmac",
        },
      },
    };
    appendFileSync(eventsPath, `${JSON.stringify(forgedEvent)}\n`);

    // Restart daemon against the same home and assert candidate still refused.
    const restartChild = startDaemon(home, PORT);
    cleanups.push(() => {
      try {
        restartChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    });
    child = restartChild;
    token = await waitForHealth(home, PORT);
    const afterRestart = await callTool(token, "run_gate", { taskId, target: "candidate" });

    // Re-prove RED from BUILDING, then candidate must be accepted again.
    const reprove = await callTool(token, "run_gate", { taskId, target: "baseline" });
    const afterReprove = await callTool(token, "run_gate", { taskId, target: "candidate" });
    const phaseAfter = (await (await api(`/v1/tasks/${taskId}`, token)).json()).task?.phase;

    gate(
      "G6",
      "gate revision + forge/key-steal refused across restart; mid-build re-prove restores",
      beforeEdit.ok === true &&
        afterEdit.ok === false &&
        afterEdit.error?.code === "GATE_ERROR" &&
        String(afterEdit.error?.message ?? "").includes("RED baseline proof") &&
        keyBlocked &&
        keyToolBlocked &&
        afterRestart.ok === false &&
        afterRestart.error?.code === "GATE_ERROR" &&
        String(afterRestart.error?.message ?? "").includes("RED baseline proof") &&
        reprove.ok === true &&
        (reprove.data?.outcome === "EXPECTED_RED" || reprove.data?.outcome === "FAIL") &&
        afterReprove.ok === true &&
        (phaseAfter === "BUILDING" || phaseAfter === "VALIDATING"),
      `before=${beforeEdit.ok} after=${afterEdit.error?.code} keyBlocked=${keyBlocked} restart=${afterRestart.error?.code} reprove=${reprove.data?.outcome} restored=${afterReprove.ok} phase=${phaseAfter}`,
    );
    await releaseTask(token, taskId);
  }

  // G7 — PEP 723 inline dependency resolves in its own venv, product tree untouched.
  // The old form asserted `!readdirSync(repo).includes(".venv")` against a fixture
  // holding one README: true whatever the runner did. Rerouting the baseline cwd
  // to the Captain's checkout — the exact defect — left it green. So the gate now
  // makes the gate process report where it was put and where its dependency came
  // from, writes a probe file into whatever cwd it was given, and checks the
  // product tree against its PRISTINE listing.
  //
  // Pristine, not a before/after delta around this one call: G1–G6 have already
  // driven gates against the shared fixture repo, so anything they leaked is in
  // both halves of a delta and cancels out. Proven: a runner that wrote a fixed
  // `.gate-scratch` into the checkout on every run_gate left the delta form
  // green (the file was already in `treeBefore`); only a leak with a fresh name
  // each run turned it red. A real regression — a `.venv`, a lockfile, a stray
  // probe file — leaks the SAME path every time, i.e. exactly the case the
  // delta could not see. So G7 gets its own untouched checkout, snapshotted
  // before any task exists, and asserts the whole listing is still that.
  {
    const g7Repo = fixtureRepo();
    cleanups.push(g7Repo);
    const g7Pristine = treeSnapshot(g7Repo);
    const g7ProjectId = (
      await (
        await api("/v1/projects", token, {
          method: "POST",
          body: JSON.stringify({ name: "p5-g7", path: g7Repo, mode: "local-only", trusted: true }),
        })
      ).json()
    ).project.id;
    const taskId = await readyTask(token, g7ProjectId, "PEP 723 isolation", {
      gateSource: `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["six"]
# ///
import json, os, sys
import six

report = {
    "cwd": os.path.realpath(os.getcwd()),
    "prefix": os.path.realpath(sys.prefix),
    "basePrefix": os.path.realpath(sys.base_prefix),
    "six": os.path.realpath(six.__file__),
    "py3": six.PY3,
}
# Written into the working directory the RUNNER chose. If that is the product
# checkout, this file lands in the Captain's tree and the gate must go red.
with open("gate-probe.json", "w", encoding="utf-8") as fh:
    json.dump(report, fh)

if os.environ.get("AGENTOS_GATE_TARGET") == "baseline":
    print("EXPECTED_RED")
    print("FAIL six present but feature absent")
    raise SystemExit(1)
print("PASS")
`,
    });
    const body = await callTool(token, "run_gate", { taskId, target: "baseline" });
    const treeAfter = treeSnapshot(g7Repo);

    const gateWorkspace = join(home, "runs", taskId, "gate-workspace");
    let probe = null;
    try {
      probe = JSON.parse(readFileSync(join(gateWorkspace, "gate-probe.json"), "utf8"));
    } catch {
      // absent or unparseable → the assertions below fail, which is the point
    }
    const realRepo = realpathSync(g7Repo);
    const insideRepo = (p) =>
      typeof p === "string" && (p === realRepo || p.startsWith(`${realRepo}/`));

    // Ran where the runner promises: the per-task gate workspace, not the checkout.
    const ranInGateWorkspace =
      probe !== null && probe.cwd === realpathSync(gateWorkspace) && !insideRepo(probe.cwd);
    // The inline dependency came from a real venv of uv's own making, not from
    // anything inside the product tree.
    const depIsolated =
      probe !== null &&
      probe.py3 === true &&
      typeof probe.six === "string" &&
      !insideRepo(probe.six) &&
      typeof probe.prefix === "string" &&
      probe.prefix !== probe.basePrefix &&
      !insideRepo(probe.prefix);
    // Whole listing still equals the pristine one — not merely unchanged since
    // just before this call. Catches a leak that repeats the same path/size on
    // every run, which is what an isolation regression actually looks like.
    const productTreeUntouched =
      treeAfter === g7Pristine && !existsSync(join(g7Repo, "gate-probe.json"));

    gate(
      "G7",
      "uv/PEP 723 inline dependency resolves in its own venv; gate runs in the gate workspace and the product tree is byte-for-byte identical to its pristine listing",
      body.ok === true &&
        body.data?.outcome === "EXPECTED_RED" &&
        ranInGateWorkspace &&
        depIsolated &&
        productTreeUntouched,
      `outcome=${body.data?.outcome} cwd=${ranInGateWorkspace} venv=${depIsolated} untouched=${productTreeUntouched}`,
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
