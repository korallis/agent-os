import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@agent-os/protocol";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { FleetService } from "../src/fleet/service.js";

/**
 * Structural WEDGED ladder (master plan §11 Phase 3).
 *
 * Exercises the real ToolSurface.reconcileWedgedSessions path with fakes for
 * tmux/Pi/Brain. The distinction under test is operational: a wedged seat's
 * pane is ALIVE, so it passes every liveness check while producing nothing.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = temp("agentos-wedged-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git("config", "user.email", "wedged@agent-os.test");
  git("config", "user.name", "Wedged");
  writeFileSync(join(dir, "README.md"), "# wedged fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

function fleet(options: {
  home?: string;
  staleBuildMinutes?: number;
  respawnPerStage?: number;
  start?: boolean;
} = {}): { service: FleetService; events: OrchestratorEvent[]; home: string; config: ConfigService } {
  const home = options.home ?? temp("agentos-wedged-home-");
  mkdirSync(join(home, "config"), { recursive: true });
  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
  if (options.home === undefined) {
    config.installDefaults();
    config.writeGlobal("policies", "{ redBaselineGateRequired: false }\n");
    const stale = options.staleBuildMinutes ?? 30;
    const respawn = options.respawnPerStage ?? 1;
    config.writeGlobal(
      "supervision",
      `{ heartbeatSeconds: 30, staleMinutes: { api: 5, build: ${stale} }, escalationLadderSteps: 3, respawnPerStage: ${respawn}, absorb: ["PROGRESS"] }\n`,
    );
  }
  const events: OrchestratorEvent[] = [];
  const service = new FleetService({
    home,
    config,
    fakeTmux: true,
    fakeBrain: true,
    fakePi: true,
  });
  service.onEvent((e) => events.push(e));
  if (options.start !== false) {
    service.start();
  }
  return { service, events, home, config };
}

function seedBuilder(
  service: FleetService,
  options: { role?: "builder" | "validator"; model?: string } = {},
): { taskId: string; sessionId: string; role: "builder" | "validator" } {
  const role = options.role ?? "builder";
  const model = options.model ?? "openai/gpt-4.1";
  const project = service.projects.register({
    name: `wedged-${role}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    path: gitRepo(),
    mode: "local-only",
    trusted: true,
  });
  const created = service.tools.invoke("create_task", {
    spec: {
      shape: "SHIP",
      title: "wedge fixture",
      intent: "exercise structural WEDGED",
      projectId: project.id,
      mode: "local-only",
      yolo: true,
    },
  });
  expect(created.ok).toBe(true);
  const taskId = (created.data as { id: string }).id;
  const cast = service.tools.invoke("resolve_cast", {
    taskId,
    roles: [{ role, model, thinking: "low", cleanRoom: true }],
    familyCheckOverride: false,
  });
  expect(cast.ok).toBe(true);
  const spawned = service.tools.invoke("spawn_crewmate", {
    taskId,
    role,
    model,
    thinking: "low",
    vars: {},
    redBaselineOverride: true,
  });
  expect(spawned.ok).toBe(true);
  const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;
  return { taskId, sessionId, role };
}

/** Force durable activity timestamps so reconcile can treat the seat as idle. */
function backdateSession(
  service: FleetService,
  sessionId: string,
  options: { idleMinutes: number; lastEventAt: string | null },
): void {
  const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
  expect(session).toBeDefined();
  expect(session!.taskId).not.toBeNull();
  const task = service.tools.getTask(session!.taskId!);
  expect(task).not.toBeNull();
  const startedAt = new Date(Date.now() - options.idleMinutes * 60_000).toISOString();
  service.tools.hydrateTask({
    ...task!,
    sessions: task!.sessions.map((s) =>
      s.sessionId === sessionId
        ? {
            ...s,
            status: "running",
            startedAt,
            lastEventAt: options.lastEventAt,
          }
        : s,
    ),
    updatedAt: new Date().toISOString(),
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("structural WEDGED ladder", () => {
  it("does not fire while the seat is still producing activity", () => {
    const { service } = fleet({ staleBuildMinutes: 30 });
    const { sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
  });

  it("ignores a seat whose pane is GONE — that is SESSION_LOST, not wedged", () => {
    const { service } = fleet({ staleBuildMinutes: 30 });
    const { sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId)!;
    service.tmux.killWindow(session.tmuxWindow);
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
  });

  it("respawns once on the first wedge", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.action).toBe("respawned");
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("respawned");
      // Evidence matches the durable ledger after the successful spend.
      expect(wedged.payload.respawnsUsed).toBe(1);
    }
    const task = service.tools.getTask(taskId);
    expect(task?.wedgeRespawnsByRole[role]).toBe(1);
  });

  it("escalates on the second wedge instead of respawning forever", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");

    const live = service.tools
      .listSessions()
      .find((s) => s.taskId === taskId && s.role === role && s.status === "running");
    expect(live).toBeDefined();
    backdateSession(service, live!.sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted[0]?.action).toBe("escalated");
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(1);
    }
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
  });

  it("treats a seat that never reported anything as idle since spawn", () => {
    const { service } = fleet({ staleBuildMinutes: 30 });
    const { sessionId } = seedBuilder(service);
    // lastActivityAt null must not read as "active now" — that would hide the
    // seat that wedged immediately on spawn, the worst case of all.
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: null,
    });
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.action).toBe("respawned");
  });

  it("keeps the ladder per task+role on the same task", () => {
    const { service } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    // Same task, two roles — ledger keys are taskId:role, not a global counter.
    const { taskId, sessionId: builderSessionId } = seedBuilder(service, {
      role: "builder",
      model: "openai/gpt-4.1",
    });
    const cast = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        { role: "validator", model: "anthropic/claude-sonnet-4-5", thinking: "low", cleanRoom: true },
      ],
      familyCheckOverride: false,
    });
    expect(cast.ok).toBe(true);
    const validatorSpawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "validator",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(validatorSpawned.ok).toBe(true);
    const validatorSessionId = (
      validatorSpawned.data as { session: { sessionId: string } }
    ).session.sessionId;

    backdateSession(service, builderSessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.builder).toBe(1);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.validator ?? 0).toBe(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");

    // Validator still has its own free respawn while the task is BUILDING.
    backdateSession(service, validatorSessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.builder).toBe(1);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.validator).toBe(1);

    const builderLive = service.tools
      .listSessions()
      .find((s) => s.taskId === taskId && s.role === "builder" && s.status === "running");
    expect(builderLive).toBeDefined();
    backdateSession(service, builderLive!.sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("escalated");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.builder).toBe(1);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.validator).toBe(1);
  });

  it("honours a respawn cap of zero by escalating immediately", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted[0]?.action).toBe("escalated");
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(0);
      expect(wedged.payload.respawnCap).toBe(0);
    }
  });

  it("persists the respawn ledger across daemon rehydrate", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");

    const durable = JSON.parse(
      readFileSync(join(home, "runs", taskId, "task.json"), "utf8"),
    ) as { wedgeRespawnsByRole: Record<string, number> };
    expect(durable.wedgeRespawnsByRole[role]).toBe(1);

    // Bounce: empty process-local ledger, rebuild from task.json.
    // Boot reconcile marks panes missing under a fresh fake tmux as lost.
    const restarted = fleet({ home, start: true });
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);

    const phase = restarted.service.tools.getTask(taskId)?.phase;
    if (phase === "SESSION_LOST") {
      const advanced = restarted.service.tools.invoke("advance_phase", {
        taskId,
        to: "BUILDING",
        reason: "resume after rehydrate for ladder durability test",
      });
      expect(advanced.ok).toBe(true);
    }

    // A fresh seat for the same task+role must escalate — not free-respawn.
    const cast = restarted.service.tools.invoke("resolve_cast", {
      taskId,
      roles: [{ role, model: "openai/gpt-4.1", thinking: "low", cleanRoom: true }],
      familyCheckOverride: false,
    });
    expect(cast.ok).toBe(true);
    const spawned = restarted.service.tools.invoke("spawn_crewmate", {
      taskId,
      role,
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(spawned.ok).toBe(true);
    const newSessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;
    backdateSession(restarted.service, newSessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const acted = restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(acted[0]?.action).toBe("escalated");
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
  });

  it("stamps activity from progress frames so healthy seats are not false-wedged", () => {
    const { service } = fleet({ staleBuildMinutes: 12 });
    const { sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: null,
    });
    service.handleExtensionFrame({
      type: "ext.lifecycle",
      sessionId,
      phase: "turn_start",
      detail: "working",
      ts: new Date().toISOString(),
    });
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.lastActivityAt).not.toBeNull();
  });

  it("emits a second captain.escalation when already NEEDS_CAPTAIN", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("escalated");
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");

    events.length = 0;
    const result = service.tools.invoke("escalate_to_captain", {
      taskId,
      summary: "second seat wedged",
      severity: "critical",
    });
    expect(result.ok).toBe(true);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.needsCaptainSummary).toBe("second seat wedged");
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
    expect(events.some((e) => e.type === "task.phase_changed")).toBe(false);
  });

  it("preflights known-illegal respawns: escalate without stop or spend", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    // Builders cannot legally spawn in VALIDATING — do not stop to find that out.
    const task = service.tools.getTask(taskId)!;
    service.tools.hydrateTask({
      ...task,
      phase: "VALIDATING",
      updatedAt: new Date().toISOString(),
    });
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted[0]?.action).toBe("escalated");
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.status).toBe("wedged");
    expect(service.tmux.hasWindow(session!.tmuxWindow)).toBe(true);
    const durable = service.tools.getTask(taskId)!;
    const durableRow = durable.sessions.find((s) => s.sessionId === sessionId);
    expect(durableRow?.status).toBe("wedged");
    expect(durable.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(0);
    }
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
  });

  it("does not stop a first-wedge seat when the task is already NEEDS_CAPTAIN", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId: builderSessionId } = seedBuilder(service, {
      role: "builder",
      model: "openai/gpt-4.1",
    });
    const cast = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        { role: "validator", model: "anthropic/claude-sonnet-4-5", thinking: "low", cleanRoom: true },
      ],
      familyCheckOverride: false,
    });
    expect(cast.ok).toBe(true);
    const validatorSpawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "validator",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(validatorSpawned.ok).toBe(true);
    const validatorSessionId = (
      validatorSpawned.data as { session: { sessionId: string } }
    ).session.sessionId;

    // Cap-zero escalate on the builder so the task is already NEEDS_CAPTAIN
    // while the validator still has a free respawn budget.
    const task = service.tools.getTask(taskId)!;
    service.tools.hydrateTask({
      ...task,
      phase: "NEEDS_CAPTAIN",
      needsCaptainSummary: "prior seat escalated",
      updatedAt: new Date().toISOString(),
    });
    backdateSession(service, validatorSessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    // Builder is not idle-wedged this tick — only the validator is.
    void builderSessionId;
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.sessionId).toBe(validatorSessionId);
    expect(acted[0]?.action).toBe("escalated");
    const validator = service.tools.listSessions().find((s) => s.sessionId === validatorSessionId);
    expect(validator?.status).toBe("wedged");
    expect(service.tmux.hasWindow(validator!.tmuxWindow)).toBe(true);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole.validator ?? 0).toBe(0);
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
    const wedged = events.find((e) => e.type === "session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(0);
    }
  });

  it("keeps the ledger spent when stop ran but spawn failed, without re-wedging the stopped seat", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    // Phase still allows builder spawn; force the post-stop spawn half to fail.
    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    service.tmux.newWindow = () => {
      throw new Error("simulated spawn refusal after stop");
    };
    events.length = 0;
    try {
      const acted = service.tools.reconcileWedgedSessions(Date.now());
      expect(acted[0]?.action).toBe("escalated");
    } finally {
      service.tmux.newWindow = originalNewWindow;
    }
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.status).toBe("stopped");
    const durable = service.tools.getTask(taskId)!;
    const durableRow = durable.sessions.find((s) => s.sessionId === sessionId);
    expect(durableRow?.status).toBe("stopped");
    expect(durable.wedgeRespawnsByRole[role]).toBe(1);
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(1);
    }
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
  });

  it("rolls the ledger back when the respawn attempt fails before stop", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const originalKill = service.tmux.killWindow.bind(service.tmux);
    service.tmux.killWindow = () => {
      throw new Error("simulated stop refusal");
    };
    events.length = 0;
    try {
      const acted = service.tools.reconcileWedgedSessions(Date.now());
      expect(acted[0]?.action).toBe("escalated");
    } finally {
      service.tmux.killWindow = originalKill;
    }
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.status).toBe("wedged");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    const wedged = events.find((e) => e.type === "session.wedged");
    expect(wedged?.type).toBe("session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(0);
    }
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
  });
});
