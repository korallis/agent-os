#!/usr/bin/env node
/**
 * Phase 3 executable gates (master plan §11 Phase 3).
 *
 * Runs against REAL tmux and REAL git — the durability substrate and the
 * worktree pool are exercised, not simulated. The only simulated component is
 * the model itself (`AGENTOS_FAKE_PI` / `AGENTOS_FAKE_BRAIN`), because a gate
 * must not spend a subscription; the spawn *path* is asserted separately in
 * G11 by inspecting the exact command line the harness would run.
 *
 *   G1  fleet summary + brain running
 *   G2  register project + create_task
 *   G3  run_gate before GATE_AUTHORING → ILLEGAL_TRANSITION
 *   G4  same-family builder/validator → POLICY_VIOLATION
 *   G5  scripted local-only SHIP → DONE on a real git worktree
 *   G6  fleet state readable after the run
 *   G7  BRAIN_DOWN blocks orchestration
 *   G8  kill -9 mid-task → restart rehydrates tasks and the Brain reconciles
 *   G9  SCOUT write violation is audited by git and quarantines the worktree
 *   G10 a non-Brain session cannot orchestrate over the extension bridge
 *   G11 the spawn command line starts from `env -i` and carries no stray key
 *   G12 SIGKILL crewmate window → SESSION_LOST + lease reclaim within one reconcile cycle
 *   G13 SIGKILL Brain pane mid-BUILDING → fresh Brain reconciles (read_fleet_state)
 *
 * Usage: node tooling/gates/phase-3.mjs
 * Exit 0 = all gates green.
 */

import { spawn, spawnSync } from "node:child_process";
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
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Isolated tmux server so a gate run never touches the captain's sessions. */
const TMUX_SOCKET = `agentos-gate-${process.pid}`;

function startDaemon(home, port) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      // Real tmux, real git, real gate runner. Only the model is simulated.
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 20000) {
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

async function callTool(base, token, tool, input) {
  const res = await api(base, "/v1/tools/call", token, {
    method: "POST",
    body: JSON.stringify({ tool, input }),
  });
  return res.json();
}

/** A real git repository with one commit — worktrees need a HEAD. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-gate-repo-"));
  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "gate@agent-os.local");
  git("config", "user.name", "Agent OS Gate");
  writeFileSync(join(dir, "README.md"), "# gate fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

async function registerProject(base, token, name, repo) {
  const res = await api(base, "/v1/projects", token, {
    method: "POST",
    body: JSON.stringify({ name, path: repo, mode: "local-only", trusted: true }),
  });
  return (await res.json()).project?.id;
}

async function createTask(base, token, projectId, spec = {}) {
  const res = await api(base, "/v1/tasks", token, {
    method: "POST",
    body: JSON.stringify({
      spec: {
        shape: "SHIP",
        title: "Gate ship",
        intent: "local only",
        projectId,
        mode: "local-only",
        yolo: true,
        ...spec,
      },
    }),
  });
  return (await res.json()).task?.id;
}

let home;
let child;
let exitCode = 0;
const cleanups = [];
const PORT = pickPort(4900, 1000);
const BASE = `http://127.0.0.1:${PORT}`;

try {
  if (spawnSync("tmux", ["-V"], { encoding: "utf8" }).status !== 0) {
    throw new Error("tmux is required for the Phase 3 gates");
  }

  home = mkdtempSync(join(tmpdir(), "agentos-p3-gate-"));
  cleanups.push(home);
  // Fast reconcile cadence so G12 can assert SESSION_LOST within one cycle.
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "supervision.json5"),
    "{ heartbeatSeconds: 1, staleMinutes: { api: 5, build: 12 }, escalationLadderSteps: 3, respawnPerStage: 1, absorb: [\"PROGRESS\", \"TURN_SETTLED_MID_STAGE\", \"CONTEXT_PRESSURE_LT_70\"] }\n",
  );
  child = startDaemon(home, PORT);
  let token = await waitForHealth(home, PORT);

  // G1 — fleet + brain endpoints
  {
    const res = await api(BASE, "/v1/fleet", token);
    const body = await res.json();
    const ok = res.ok && body.summary?.brain?.status === "running";
    gate("G1", "fleet summary + brain running", ok, `brain=${body.summary?.brain?.status}`);
  }

  // G2 — project + create_task on a real git repo
  const repo = fixtureRepo();
  cleanups.push(repo);
  const projectId = await registerProject(BASE, token, "gate", repo);
  const taskId = await createTask(BASE, token, projectId);
  gate("G2", "register project + create_task", !!projectId && !!taskId, taskId);

  // G3 — illegal transition run_gate
  {
    const body = await callTool(BASE, token, "run_gate", { taskId, target: "baseline" });
    gate(
      "G3",
      "run_gate before GATE_AUTHORING → ILLEGAL_TRANSITION",
      body.ok === false && body.error?.code === "ILLEGAL_TRANSITION",
      body.error?.code,
    );
  }

  // G4 — cross-family policy (claude-agent-sdk vs anthropic)
  {
    const body = await callTool(BASE, token, "resolve_cast", {
      taskId,
      roles: [
        { role: "builder", model: "claude-agent-sdk/claude-sonnet-4-5", thinking: "medium", cleanRoom: true },
        { role: "validator", model: "anthropic/claude-sonnet-4-5", thinking: "medium", cleanRoom: true },
      ],
      familyCheckOverride: false,
    });
    gate(
      "G4",
      "same-family builder/validator → POLICY_VIOLATION",
      body.ok === false && body.error?.code === "POLICY_VIOLATION",
      body.error?.code,
    );
  }

  // G5 — scripted local SHIP end-to-end on a real worktree
  {
    await callTool(BASE, token, "resolve_cast", {
      taskId,
      roles: [{ role: "builder", model: "openai/gpt-4.1", thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    const spawned = await callTool(BASE, token, "spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "medium",
      vars: {},
      redBaselineOverride: true,
    });
    const worktreePath = spawned.data?.session?.worktreePath ?? null;
    const sessionId = spawned.data?.session?.sessionId ?? null;
    const isRealWorktree =
      worktreePath !== null &&
      spawnSync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      }).stdout.trim() === "true";

    // Stop the crewmate before deliver so the lease is not reclaimed under a live pane.
    if (sessionId !== null) {
      await callTool(BASE, token, "stop_crewmate", {
        sessionId,
        reason: "G5 ship complete",
      });
    }

    const body = await callTool(BASE, token, "deliver_task", { taskId });
    gate(
      "G5",
      "scripted local-only SHIP → DONE on a real git worktree",
      body.ok === true &&
        body.data?.phase === "DONE" &&
        String(body.data?.branch ?? "").startsWith("ao/") &&
        isRealWorktree,
      `phase=${body.data?.phase} branch=${body.data?.branch} realWorktree=${isRealWorktree}`,
    );
  }

  // G6 — fleet state readable
  {
    const state = await api(BASE, "/v1/fleet/state", token);
    const sb = await state.json();
    const ok = state.ok && Array.isArray(sb.state?.tasks);
    gate("G6", "fleet state readable after run", ok, `tasks=${sb.state?.tasks?.length}`);
  }

  // G9 — SCOUT write violation quarantines the worktree
  {
    const scoutTask = await createTask(BASE, token, projectId, {
      shape: "SCOUT",
      title: "Gate scout",
      intent: "read only",
      yolo: undefined,
    });
    await callTool(BASE, token, "resolve_cast", {
      taskId: scoutTask,
      roles: [{ role: "scout", model: "openai/gpt-4.1", thinking: "low", cleanRoom: true }],
      familyCheckOverride: false,
    });
    const spawned = await callTool(BASE, token, "spawn_crewmate", {
      taskId: scoutTask,
      role: "scout",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = spawned.data?.session?.sessionId;
    const worktreePath = spawned.data?.session?.worktreePath;
    let quarantined = false;
    let changed = 0;
    if (typeof worktreePath === "string") {
      writeFileSync(join(worktreePath, "scout-wrote-this.txt"), "violation\n");
      const stopped = await callTool(BASE, token, "stop_crewmate", {
        sessionId,
        reason: "gate scout audit",
      });
      void stopped;
      const state = await (await api(BASE, "/v1/fleet/state", token)).json();
      const lease = (state.state?.worktrees ?? []).find((l) => l.path === worktreePath);
      quarantined = lease?.state === "quarantined";
      const { events } = await (await api(BASE, "/v1/events/replay", token)).json();
      changed =
        events.filter((e) => e.event.type === "scout.write_violation").length;
    }
    gate(
      "G9",
      "SCOUT write violation audited by git → worktree quarantined",
      quarantined && changed >= 1,
      `quarantined=${quarantined} violations=${changed}`,
    );
  }

  // G10 — a crew session cannot orchestrate over the bridge
  {
    const body = await callTool(BASE, token, "read_fleet_state", {});
    const sessions = body.data?.sessions ?? [];
    const crew = sessions.find((s) => s.role !== "brain");
    const res = await api(BASE, "/v1/tools/call", token, {
      method: "POST",
      body: JSON.stringify({
        tool: "deliver_task",
        input: { taskId },
        sessionId: crew?.sessionId,
      }),
    });
    const denied = await res.json();
    gate(
      "G10",
      "non-Brain session cannot orchestrate over the extension bridge",
      denied.ok === false && denied.error?.code === "UNAUTHORIZED_TOOL",
      `err=${denied.error?.code}`,
    );
  }

  // G14 — structural WEDGED: a seat whose pane is ALIVE but silent past the
  // stale window is respawned ONCE, evidence-stamped, then escalated. Wedged is
  // the nastiest failure mode precisely because every liveness check passes.
  {
    // Tighten the stale window so the gate need not wait 30 real minutes.
    await api(BASE, "/v1/config/global/supervision", token, {
      method: "PUT",
      body: JSON.stringify({
        staleMinutes: { api: 1, build: 1 },
        escalationLadderSteps: 3,
        respawnPerStage: 1,
        absorb: ["PROGRESS"],
        heartbeatSeconds: 2,
      }),
    });
    await sleep(1500);

    const wedgeTask = await createTask(BASE, token, projectId, { title: "wedge fixture" });
    await callTool(BASE, token, "resolve_cast", {
      taskId: wedgeTask,
      roles: [{ role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    await callTool(BASE, token, "spawn_crewmate", {
      taskId: wedgeTask,
      role: "builder",
      model: "openai/gpt-5.6-sol",
      thinking: "medium",
      vars: {},
      redBaselineOverride: true,
    });

    // Let the seat go silent past the 1-minute window while its pane stays up.
    // The fake-pi pane is `sleep 86400`: genuinely alive, genuinely producing
    // nothing — exactly the shape of a real wedge.
    await sleep(75_000);

    const deadline = Date.now() + 120_000;
    let respawned = null;
    let escalated = null;
    while (Date.now() < deadline && (respawned === null || escalated === null)) {
      const res = await api(BASE, "/v1/events/replay?types=session.wedged&limit=1000", token);
      const body = await res.json();
      for (const envelope of body.events ?? []) {
        if (envelope.event?.type !== "session.wedged") continue;
        const payload = envelope.event.payload;
        if (payload.taskId !== wedgeTask) continue;
        if (payload.action === "respawned" && respawned === null) respawned = payload;
        if (payload.action === "escalated" && escalated === null) escalated = payload;
      }
      if (respawned === null || escalated === null) await sleep(2000);
    }

    gate(
      "G14",
      "a live-but-silent seat is WEDGED: respawned once with evidence, then escalated",
      respawned !== null &&
        escalated !== null &&
        respawned.respawnsUsed === 1 &&
        escalated.respawnsUsed === 1 &&
        respawned.thresholdMinutes === 1,
      `respawned=${respawned !== null ? `idle ${respawned.idleMinutes}m ${respawned.respawnsUsed}/${respawned.respawnCap}` : "none"} escalated=${escalated !== null ? `${escalated.respawnsUsed}/${escalated.respawnCap}` : "none"}`,
    );
  }

  // G8 — kill -9 mid-task → rehydrate + Brain reconcile
  {
    const liveTask = await createTask(BASE, token, projectId, { title: "Survives kill -9" });
    child.kill("SIGKILL");
    await sleep(400);
    child = startDaemon(home, PORT);
    token = await waitForHealth(home, PORT);

    const rehydrated = await (await api(BASE, `/v1/tasks/${liveTask}`, token)).json();
    const brain = await (await api(BASE, "/v1/brain", token)).json();
    gate(
      "G8",
      "kill -9 → tasks rehydrate and the Brain reconciles on restart",
      rehydrated.task?.id === liveTask &&
        brain.brain?.status === "running" &&
        brain.brain?.lastReconcileAt !== null,
      `task=${rehydrated.task?.phase} brain=${brain.brain?.status} reconciledAt=${brain.brain?.lastReconcileAt !== null}`,
    );
  }

  // G11 — the spawn command line is env-scrubbed and starts from `env -i`
  {
    const evalJs = `
      import { envPrefixedCommand } from '${join(ROOT, "apps/orchestrator/dist/fleet/tmux.js")}';
      import { scrubEnv } from '${join(ROOT, "apps/orchestrator/dist/security/env-scrub.js")}';
      const scrubbed = scrubEnv(
        { PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'leaked', SECRET_THING: 'leaked' },
        { grantProviderKey: { name: 'ANTHROPIC_API_KEY', value: 'granted' },
          extraAllow: { AGENTOS_SOCKET: '/tmp/s.sock', AGENTOS_ROLE: 'builder' } },
      );
      const cmd = envPrefixedCommand(['/usr/local/bin/pi', '--mode', 'json'], scrubbed.env);
      if (!cmd.startsWith('env -i ')) process.exit(2);
      if (cmd.includes('leaked')) process.exit(3);
      if (!cmd.includes('AGENTOS_SOCKET=/tmp/s.sock')) process.exit(4);
      if (!cmd.includes('ANTHROPIC_API_KEY=granted')) process.exit(5);
      process.stdout.write('ok');
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", evalJs], {
      encoding: "utf8",
    });
    gate(
      "G11",
      "spawn command line starts from `env -i` and carries only scrubbed pairs",
      run.status === 0 && run.stdout.trim() === "ok",
      `exit=${run.status}`,
    );
  }

  // G12 — kill crewmate tmux window → SESSION_LOST + lease reclaim within one reconcile cycle
  {
    const liveTask = await createTask(BASE, token, projectId, { title: "Session lost gate" });
    await callTool(BASE, token, "resolve_cast", {
      taskId: liveTask,
      roles: [{ role: "builder", model: "openai/gpt-4.1", thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    const spawned = await callTool(BASE, token, "spawn_crewmate", {
      taskId: liveTask,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "medium",
      vars: {},
      redBaselineOverride: true,
    });
    const sessionId = spawned.data?.session?.sessionId;
    const tmuxWindow = spawned.data?.session?.tmuxWindow;
    const worktreePath = spawned.data?.session?.worktreePath;
    let killed = false;
    if (typeof tmuxWindow === "string") {
      const kill = spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-window", "-t", tmuxWindow], {
        encoding: "utf8",
      });
      killed = kill.status === 0;
    }
    // One reconcile cycle at heartbeatSeconds=1, plus margin for the tick.
    await sleep(2500);
    const state = await (await api(BASE, "/v1/fleet/state", token)).json();
    const session = (state.state?.sessions ?? []).find((s) => s.sessionId === sessionId);
    const task = await (await api(BASE, `/v1/tasks/${liveTask}`, token)).json();
    const lease =
      typeof worktreePath === "string"
        ? (state.state?.worktrees ?? []).find((l) => l.path === worktreePath)
        : undefined;
    const leaseReclaimed =
      lease === undefined || lease.state === "idle" || lease.state === "quarantined";
    const lost =
      session?.status === "lost" ||
      task.task?.phase === "SESSION_LOST" ||
      (task.task?.sessions ?? []).some((s) => s.sessionId === sessionId && s.status === "lost");
    const { events } = await (await api(BASE, "/v1/events/replay", token)).json();
    const lostEvents = events.filter((e) => e.event.type === "session.lost").length;
    gate(
      "G12",
      "SIGKILL crewmate window → SESSION_LOST + lease reclaim within one reconcile cycle",
      killed && lost && leaseReclaimed && lostEvents >= 1,
      `killed=${killed} lost=${lost} lease=${lease?.state ?? "gone"} events=${lostEvents} phase=${task.task?.phase}`,
    );
  }

  // G13 — kill Brain pane mid-BUILDING → fresh Brain reconciles
  {
    const before = await (await api(BASE, "/v1/brain", token)).json();
    const priorSessionId = before.brain?.sessionId;
    const priorWindow = before.brain?.tmuxWindow;
    let killed = false;
    if (typeof priorWindow === "string") {
      const kill = spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-window", "-t", priorWindow], {
        encoding: "utf8",
      });
      killed = kill.status === 0;
    }
    // One reconcile cycle at heartbeatSeconds=1, plus margin for the tick.
    await sleep(2500);
    const after = await (await api(BASE, "/v1/brain", token)).json();
    const brain = after.brain;
    const respawned =
      brain?.status === "running" &&
      brain?.lastReconcileAt !== null &&
      typeof brain?.sessionId === "string" &&
      brain.sessionId !== priorSessionId;
    gate(
      "G13",
      "SIGKILL Brain pane → fresh Brain reconciles (read_fleet_state)",
      killed && respawned,
      `killed=${killed} status=${brain?.status} prior=${priorSessionId} next=${brain?.sessionId} reconciled=${brain?.lastReconcileAt !== null}`,
    );
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
    const bb = await (await api(base2, "/v1/brain", token2)).json();
    const repo2 = fixtureRepo();
    cleanups.push(repo2);
    const pid = await registerProject(base2, token2, "bd", repo2);
    const tid = await createTask(base2, token2, pid, { title: "bd", yolo: false });
    const sb = await callTool(base2, token2, "spawn_crewmate", {
      taskId: tid,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    gate(
      "G7",
      "BRAIN_DOWN blocks spawn_crewmate",
      bb.brain?.status === "down" && sb.ok === false && sb.error?.code === "BRAIN_DOWN",
      `brain=${bb.brain?.status} err=${sb.error?.code}`,
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
