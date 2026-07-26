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
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
  });

  it("discharges a durable pending Captain notify for a stopped seat without re-wedging", () => {
    const { service, events, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    // Simulate stop-then-spawn-fail that recorded the obligation but never
    // sank captain.escalation (process death / throw after record).
    const task = service.tools.getTask(taskId)!;
    const summary = `Seat ${role} wedged and could not be respawned — no activity for 60m`;
    service.tools.hydrateTask({
      ...task,
      wedgeRespawnsByRole: { [role]: 1 },
      wedgePendingCaptainNotifies: [
        {
          sessionId,
          role,
          summary,
          severity: "critical",
          recordedAt: new Date().toISOString(),
        },
      ],
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, status: "stopped" } : s,
      ),
      updatedAt: new Date().toISOString(),
    });
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "stopped",
    );
    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    const esc = events.find((e) => e.type === "captain.escalation");
    if (esc?.type === "captain.escalation") {
      expect(esc.payload.summary).toBe(summary);
      expect(esc.payload.severity).toBe("critical");
    }
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "stopped",
    );
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");

    // Exactly once: a second reconcile must not re-emit.
    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);

    // Survives rehydrate: empty pending, no free re-notify.
    const durable = JSON.parse(
      readFileSync(join(home, "runs", taskId, "task.json"), "utf8"),
    ) as { wedgePendingCaptainNotifies: unknown[] };
    expect(durable.wedgePendingCaptainNotifies).toEqual([]);
  });

  it("discharges pending Captain notify after rehydrate even when the pane is gone", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId, role } = seedBuilder(service);
    const task = service.tools.getTask(taskId)!;
    const summary = `Seat ${role} wedged again after 0 respawns — deferred notify`;
    const stamped = {
      ...task,
      wedgePendingCaptainNotifies: [
        {
          sessionId,
          role,
          summary,
          severity: "critical" as const,
          recordedAt: new Date().toISOString(),
        },
      ],
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, status: "wedged" as const } : s,
      ),
      updatedAt: new Date().toISOString(),
    };
    service.tools.hydrateTask(stamped);
    // hydrateTask is memory-only — persist so a bounce can reload the obligation.
    writeFileSync(
      join(home, "runs", taskId, "task.json"),
      `${JSON.stringify(service.tools.getTask(taskId), null, 2)}\n`,
      { mode: 0o600 },
    );

    // Fresh fake tmux has no windows — pane is gone; notify must still discharge.
    const restarted = fleet({ home, start: false });
    const events: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => events.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies).toHaveLength(1);
    const rehydrated = restarted.service.tools
      .listSessions()
      .find((s) => s.sessionId === sessionId);
    expect(rehydrated?.status).toBe("wedged");
    expect(restarted.service.tmux.hasWindow(rehydrated!.tmuxWindow)).toBe(false);

    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    const esc = events.find((e) => e.type === "captain.escalation");
    if (esc?.type === "captain.escalation") {
      expect(esc.payload.summary).toBe(summary);
    }
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
    expect(restarted.service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");

    events.length = 0;
    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
  });

  it("records pending notify before escalate so a failed sink is retried next tick", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    // Force escalate to throw once after the durable pending is recorded.
    let failOnce = true;
    const tools = service.tools as unknown as {
      escalate: (raw: Record<string, unknown>, options?: { bypassAfk?: boolean }) => unknown;
    };
    const originalEscalate = tools.escalate.bind(service.tools);
    tools.escalate = (raw: Record<string, unknown>, options?: { bypassAfk?: boolean }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated escalate sink failure");
      }
      return originalEscalate(raw, options);
    };

    events.length = 0;
    try {
      const acted = service.tools.reconcileWedgedSessions(Date.now());
      expect(acted[0]?.action).toBe("escalated");
      expect(events.some((e) => e.type === "session.wedged")).toBe(true);
      expect(events.some((e) => e.type === "captain.escalation")).toBe(false);
      const pending = service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? [];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sessionId).toBe(sessionId);
      expect(pending[0]?.role).toBe(role);

      // Next tick discharges via top-of-loop only — no second session.wedged.
      events.length = 0;
      service.tools.reconcileWedgedSessions(Date.now());
      expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
      expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
      expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
      expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
      expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);
    } finally {
      tools.escalate = originalEscalate;
    }
  });

  it("does not re-arm Captain notify after successful discharge survives restart", () => {
    const { service, events, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("escalated");
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);

    // Persist is already on disk via saveTask; bounce with empty process state.
    const restarted = fleet({ home, start: false });
    const reEvents: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => reEvents.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(
      sessionId,
    );
    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
  });

  it("still escalates after restart when discharge never succeeded", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const tools = service.tools as unknown as {
      escalate: (raw: Record<string, unknown>, options?: { bypassAfk?: boolean }) => unknown;
    };
    const originalEscalate = tools.escalate.bind(service.tools);
    tools.escalate = () => {
      throw new Error("simulated durable sink failure");
    };

    try {
      service.tools.reconcileWedgedSessions(Date.now());
    } finally {
      tools.escalate = originalEscalate;
    }

    const pending = service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sessionId).toBe(sessionId);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds ?? []).not.toContain(
      sessionId,
    );

    // Ensure the failed-discharge task state is what a bounce would load.
    writeFileSync(
      join(home, "runs", taskId, "task.json"),
      `${JSON.stringify(service.tools.getTask(taskId), null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = fleet({ home, start: false });
    const reEvents: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => reEvents.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies).toHaveLength(1);
    expect(
      restarted.service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds ?? [],
    ).not.toContain(sessionId);

    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    const esc = reEvents.find((e) => e.type === "captain.escalation");
    if (esc?.type === "captain.escalation") {
      expect(esc.payload.summary).toContain(role);
    }
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
    expect(restarted.service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(restarted.service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(
      sessionId,
    );
  });

  it("does not clear wedge pending when AFK FAQ would match the summary", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 0 });
    const { taskId, sessionId } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    // Broad FAQ needles that substring-match a typical wedge summary ("Seat … wedged").
    service.afk.arm({
      faq: [
        {
          match: ["seat", "wedged"],
          answer: "Ignore structural wedge — keep going.",
          rationale: "would incorrectly auto-answer a structural wedge",
        },
      ],
    });
    expect(service.afk.isActive()).toBe(true);

    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted[0]?.action).toBe("escalated");
    // AFK must not swallow the structural wedge: Captain still gets the sink.
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(events.some((e) => e.type === "afk.auto_answered")).toBe(false);
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);

    // Crewmate-style escalate still honours AFK when not a wedge discharge.
    events.length = 0;
    const crewmate = service.tools.invoke("escalate_to_captain", {
      taskId,
      summary: "Seat builder wedged — OK to ignore?",
      severity: "info",
    });
    expect(crewmate.ok).toBe(true);
    expect((crewmate.data as { autoAnswered?: boolean; sank?: boolean }).autoAnswered).toBe(true);
    expect((crewmate.data as { sank?: boolean }).sank).toBe(false);
    expect(events.some((e) => e.type === "captain.escalation")).toBe(false);
    expect(events.some((e) => e.type === "afk.auto_answered")).toBe(true);
  });

  it("write-ahead pending before seat-consuming respawn so crash after stop still escalates", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    // Capture durable state at the first stop write for this seat — that is the
    // process-death window between spend/stop and post-outcome work. Restoring
    // only that snapshot simulates kill -9 inside the window (not after catch).
    type MidFlightTask = {
      sessions: Array<{ sessionId: string; status: string }>;
      wedgeRespawnsByRole: Record<string, number>;
      wedgePendingCaptainNotifies: unknown[];
    };
    let midFlight: MidFlightTask | null = null;
    const tools = service.tools as unknown as {
      saveTask: (task: MidFlightTask) => void;
    };
    const originalSaveTask = tools.saveTask.bind(service.tools);
    tools.saveTask = (task: MidFlightTask) => {
      originalSaveTask(task);
      if (midFlight !== null) return;
      const row = task.sessions.find((s) => s.sessionId === sessionId);
      if (row?.status === "stopped") {
        midFlight = JSON.parse(JSON.stringify(service.tools.getTask(taskId))) as MidFlightTask;
      }
    };

    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    service.tmux.newWindow = () => {
      throw new Error("simulated spawn refusal after stop");
    };

    try {
      service.tools.reconcileWedgedSessions(Date.now());
    } finally {
      tools.saveTask = originalSaveTask;
      service.tmux.newWindow = originalNewWindow;
    }

    expect(midFlight).not.toBeNull();
    // Obligation must already exist at stop — write-ahead, not post-catch.
    expect(midFlight!.wedgePendingCaptainNotifies).toHaveLength(1);
    expect(midFlight!.wedgeRespawnsByRole[role]).toBe(1);
    expect(midFlight!.sessions.find((s) => s.sessionId === sessionId)?.status).toBe("stopped");

    writeFileSync(
      join(home, "runs", taskId, "task.json"),
      `${JSON.stringify(midFlight, null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = fleet({ home, start: false });
    const reEvents: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => reEvents.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies).toHaveLength(1);
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);

    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
    expect(restarted.service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    // Ledger not double-spent across the restart recovery.
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);

    reEvents.length = 0;
    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
  });

  it("does not wedge a seat with an outstanding pending question past the stale window", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);

    const questionId = "01JQ5T0000000000000000000A";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Which approach should I take?",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);

    // Silence while blocked on the Captain still ages the clock — backdate after
    // the ask so the open-question exemption is what keeps the seat alive.
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );
    expect(service.tools.listQuestions()).toHaveLength(1);
  });

  it("does not wedge on the next tick after a long-pending question is answered", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);

    const questionId = "01JQ5T0000000000000000000B";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Need a decision before continuing.",
      ts: new Date().toISOString(),
    });
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);

    const answered = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Ship the migration as-is.",
    });
    expect(answered.ok).toBe(true);
    expect(service.tools.listQuestions()).toHaveLength(0);

    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );
  });

  it("wedges after a further full stale window of silence following an answer", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);

    const questionId = "01JQ5T0000000000000000000C";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Need a decision before continuing.",
      ts: new Date().toISOString(),
    });
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);

    const answered = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Ship the migration as-is.",
    });
    expect(answered.ok).toBe(true);
    expect(service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);

    // Answer stamped activity; only a further full window of silence re-arms.
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.action).toBe("respawned");
    expect(events.some((e) => e.type === "session.wedged")).toBe(true);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
  });

  it("keeps an open question across daemon restart (exemption + answer_crewmate)", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    const preRestart = service.tools.listSessions().find((s) => s.sessionId === sessionId)!;
    const windowName = preRestart.tmuxWindow.includes(":")
      ? preRestart.tmuxWindow.split(":")[1]!
      : preRestart.tmuxWindow;

    const questionId = "01JQ5T0000000000000000000D";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Which path should I take before the restart?",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.pendingQuestions).toHaveLength(1);

    const durable = JSON.parse(
      readFileSync(join(home, "runs", taskId, "task.json"), "utf8"),
    ) as { pendingQuestions: unknown[] };
    expect(durable.pendingQuestions).toHaveLength(1);

    // Bounce empties process-local Maps; only task.json rehydrates the view.
    // start:true so Brain is up (answer_crewmate is orchestration-gated).
    const restarted = fleet({ home, start: true });
    expect(restarted.service.tools.listQuestions()).toHaveLength(1);
    expect(restarted.service.tools.listQuestions()[0]?.questionId).toBe(questionId);
    expect(restarted.service.tools.getTask(taskId)?.pendingQuestions).toHaveLength(1);

    // Boot mark-lost may have cleared the live pane; restore seat shape so
    // structural WEDGED can classify, then prove the open-question skip holds.
    restarted.service.tmux.newWindow({
      windowName,
      argv: ["true"],
    });
    const task = restarted.service.tools.getTask(taskId)!;
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const lastEventAt = new Date(Date.now() - 60 * 60_000).toISOString();
    restarted.service.tools.hydrateTask({
      ...task,
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, status: "running", startedAt, lastEventAt }
          : s,
      ),
      updatedAt: new Date().toISOString(),
    });

    const events: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => events.push(e));
    const acted = restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    expect(
      restarted.service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status,
    ).toBe("running");

    const answered = restarted.service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Take the migration path.",
    });
    expect(answered.ok).toBe(true);
    expect(answered.error).toBeUndefined();
    expect(restarted.service.tools.listQuestions()).toHaveLength(0);
    expect(restarted.service.tools.getTask(taskId)?.pendingQuestions ?? []).toHaveLength(0);
  });

  it("after restart, answering resets activity so wedge needs a further full window", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    const preRestart = service.tools.listSessions().find((s) => s.sessionId === sessionId)!;
    const windowName = preRestart.tmuxWindow.includes(":")
      ? preRestart.tmuxWindow.split(":")[1]!
      : preRestart.tmuxWindow;

    const questionId = "01JQ5T0000000000000000000E";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Need a decision that survives bounce.",
      ts: new Date().toISOString(),
    });

    const restarted = fleet({ home, start: true });
    restarted.service.tmux.newWindow({
      windowName,
      argv: ["true"],
    });
    // Boot may promote SESSION_LOST when the pane is gone; restore BUILDING so
    // a later post-answer wedge can still take the legal respawn branch.
    if (restarted.service.tools.getTask(taskId)?.phase === "SESSION_LOST") {
      const advanced = restarted.service.tools.invoke("advance_phase", {
        taskId,
        to: "BUILDING",
        reason: "resume after rehydrate for open-question durability test",
      });
      expect(advanced.ok).toBe(true);
    }
    const task = restarted.service.tools.getTask(taskId)!;
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const lastEventAt = new Date(Date.now() - 60 * 60_000).toISOString();
    restarted.service.tools.hydrateTask({
      ...task,
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, status: "running", startedAt, lastEventAt }
          : s,
      ),
      updatedAt: new Date().toISOString(),
    });

    expect(restarted.service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);

    const answered = restarted.service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Proceed with the plan.",
    });
    expect(answered.ok).toBe(true);
    expect(restarted.service.tools.listQuestions()).toHaveLength(0);

    const events: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => events.push(e));
    // Immediately after answer — activity was stamped; must not wedge yet.
    expect(restarted.service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);

    backdateSession(restarted.service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    events.length = 0;
    const acted = restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.action).toBe("respawned");
    expect(events.some((e) => e.type === "session.wedged")).toBe(true);
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
  });

  it("stamps activity when a question is recorded so near-threshold seats are not wedged", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    // Seat is already idle for almost the full window.
    const almostStaleAt = new Date(Date.now() - 29 * 60_000).toISOString();
    backdateSession(service, sessionId, {
      idleMinutes: 29,
      lastEventAt: almostStaleAt,
    });

    const questionId = "01JQ5T0000000000000000000F";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Quick decision while near the stale threshold.",
      ts: new Date().toISOString(),
    });

    const afterAsk = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(afterAsk?.lastActivityAt).not.toBeNull();
    expect(Date.parse(afterAsk!.lastActivityAt!)).toBeGreaterThan(Date.parse(almostStaleAt));

    // Advance "now" past the original pre-question deadline; recorded-question
    // activity stamp must keep the seat non-wedged even with the exemption.
    const pastOriginalWindow = Date.now() + 5 * 60_000;
    events.length = 0;
    // Drop the exemption path by answering, then immediately check that the
    // ask-time activity stamp alone is still fresh enough.
    const answered = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Go ahead.",
    });
    expect(answered.ok).toBe(true);

    const acted = service.tools.reconcileWedgedSessions(pastOriginalWindow);
    expect(acted).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );
  });

  it("does not escalate when pending-clear throws after a successful respawn", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const tools = service.tools as unknown as {
      clearPendingWedgeCaptainNotify: (taskId: string, sessionId: string) => void;
    };
    const originalClear = tools.clearPendingWedgeCaptainNotify.bind(service.tools);
    tools.clearPendingWedgeCaptainNotify = () => {
      throw new Error("simulated clearPending I/O failure after respawn");
    };

    events.length = 0;
    try {
      expect(() => service.tools.reconcileWedgedSessions(Date.now())).toThrow(
        /simulated clearPending I\/O failure/,
      );
    } finally {
      tools.clearPendingWedgeCaptainNotify = originalClear;
    }

    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    // Write-ahead pending may still be durable; next tick must derive the live
    // replacement from task sessions and retire without false-escalating.
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(1);
    const replacement = service.tools
      .listSessions()
      .find((s) => s.taskId === taskId && s.role === role && s.status === "running");
    expect(replacement).toBeDefined();
    expect(replacement!.sessionId).not.toBe(sessionId);

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);
  });

  it("derives successful respawn without replacementSessionId stamp (spawn→bookkeeping kill)", () => {
    // Kill -9 after spawn lands in task.json but before any follow-up stamp/clear:
    // write-ahead remains, no replacementSessionId, original stopped, replacement live.
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const tools = service.tools as unknown as {
      clearPendingWedgeCaptainNotify: (taskId: string, sessionId: string) => void;
    };
    const originalClear = tools.clearPendingWedgeCaptainNotify.bind(service.tools);
    tools.clearPendingWedgeCaptainNotify = () => {
      // Leave write-ahead in place (no stamp path either).
    };

    events.length = 0;
    try {
      expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");
    } finally {
      tools.clearPendingWedgeCaptainNotify = originalClear;
    }

    const after = service.tools.getTask(taskId)!;
    const pending = after.wedgePendingCaptainNotifies ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.replacementSessionId).toBeUndefined();
    expect(pending[0]?.writeAheadRespawn).toBe(true);
    const replacement = after.sessions.find(
      (s) => s.role === role && s.status === "running" && s.sessionId !== sessionId,
    );
    expect(replacement).toBeDefined();
    expect(after.sessions.find((s) => s.sessionId === sessionId)?.status).toBe("stopped");

    // Strip any accidental stamp and ensure recordedAt is before replacement startedAt.
    service.tools.hydrateTask({
      ...after,
      wedgePendingCaptainNotifies: [
        {
          sessionId,
          role,
          summary:
            pending[0]?.summary ??
            `Seat ${role} wedged and could not be respawned — no activity for 60m`,
          severity: "critical",
          recordedAt: new Date(Date.parse(replacement!.startedAt) - 1_000).toISOString(),
          writeAheadRespawn: true,
        },
      ],
      wedgeLadderCompletedSessionIds: (after.wedgeLadderCompletedSessionIds ?? []).filter(
        (id) => id !== sessionId,
      ),
      updatedAt: new Date().toISOString(),
    });

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);
  });

  it("does not false-escalate when pending survives a successful respawn", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    // Land a real wedge respawn, then re-open durable write-ahead as if clear
    // never ran after spawn (no replacementSessionId stamp required).
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");
    const after = service.tools.getTask(taskId)!;
    const replacement = after.sessions.find(
      (s) => s.role === role && s.status === "running" && s.sessionId !== sessionId,
    );
    expect(replacement).toBeDefined();
    service.tools.hydrateTask({
      ...after,
      wedgePendingCaptainNotifies: [
        {
          sessionId,
          role,
          summary: `Seat ${role} wedged and could not be respawned — no activity for 60m`,
          severity: "critical",
          recordedAt: new Date(Date.parse(replacement!.startedAt) - 1_000).toISOString(),
          writeAheadRespawn: true,
        },
      ],
      wedgeLadderCompletedSessionIds: (after.wedgeLadderCompletedSessionIds ?? []).filter(
        (id) => id !== sessionId,
      ),
      updatedAt: new Date().toISOString(),
    });
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies).toHaveLength(1);
    expect(
      service.tools
        .listSessions()
        .some((s) => s.taskId === taskId && s.role === role && s.status === "running"),
    ).toBe(true);

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
  });

  it("escalates once after failed respawn with only write-ahead durable state", () => {
    // Respawn fails and process dies before any post-failure bookkeeping beyond
    // the write-ahead + stop: next reconcile must escalate exactly once.
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    const task = service.tools.getTask(taskId)!;
    const crashed = {
      ...task,
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, status: "stopped" as const } : s,
      ),
      wedgeRespawnsByRole: { ...(task.wedgeRespawnsByRole ?? {}), [role]: 1 },
      wedgePendingCaptainNotifies: [
        {
          sessionId,
          role,
          summary: `Seat ${role} wedged and could not be respawned — no activity for 60m`,
          severity: "critical" as const,
          recordedAt: new Date().toISOString(),
          writeAheadRespawn: true,
        },
      ],
      wedgeLadderCompletedSessionIds: [] as string[],
      updatedAt: new Date().toISOString(),
    };
    service.tools.hydrateTask(crashed);
    writeFileSync(
      join(home, "runs", taskId, "task.json"),
      `${JSON.stringify(service.tools.getTask(taskId), null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = fleet({ home, start: false });
    const reEvents: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => reEvents.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      1,
    );
    expect(
      restarted.service.tools
        .listSessions()
        .some((s) => s.taskId === taskId && s.role === role && s.status === "running"),
    ).toBe(false);

    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(restarted.service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
    expect(restarted.service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(
      sessionId,
    );

    reEvents.length = 0;
    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
  });

  it("does not let a pre-wedge same-role peer satisfy derived respawn success", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId: sessionB, role } = seedBuilder(service);
    const peerSpawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role,
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(peerSpawn.ok).toBe(true);
    const sessionA = (peerSpawn.data as { session: { sessionId: string } }).session.sessionId;
    const peerStartedAt = service.tools
      .listSessions()
      .find((s) => s.sessionId === sessionA)?.startedAt;
    expect(peerStartedAt).toBeDefined();

    // Durable crash state: write-ahead after stop, respawn never landed, peer A still live.
    // recordedAt is after peer A's startedAt so derivation must not treat A as the replacement.
    const task = service.tools.getTask(taskId)!;
    const recordedAt = new Date(Date.parse(peerStartedAt!) + 60_000).toISOString();
    service.tools.hydrateTask({
      ...task,
      sessions: task.sessions.map((s) =>
        s.sessionId === sessionB ? { ...s, status: "stopped" } : s,
      ),
      wedgeRespawnsByRole: { ...(task.wedgeRespawnsByRole ?? {}), [role]: 1 },
      wedgePendingCaptainNotifies: [
        {
          sessionId: sessionB,
          role,
          summary: `Seat ${role} wedged and could not be respawned — no activity for 60m`,
          severity: "critical",
          recordedAt,
          writeAheadRespawn: true,
        },
      ],
      wedgeLadderCompletedSessionIds: [],
      updatedAt: new Date().toISOString(),
    });

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionB);
    expect(
      service.tools.listSessions().find((s) => s.sessionId === sessionA)?.status,
    ).toBe("running");
  });

  it("still escalates once across restart when a wedge respawn genuinely failed", () => {
    const { service, events, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    service.tmux.newWindow = () => {
      throw new Error("simulated spawn refusal after stop");
    };
    try {
      expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("escalated");
    } finally {
      service.tmux.newWindow = originalNewWindow;
    }
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionId);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);

    const restarted = fleet({ home, start: false });
    const reEvents: OrchestratorEvent[] = [];
    restarted.service.onEvent((e) => reEvents.push(e));
    expect(restarted.service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(
      0,
    );
    restarted.service.tools.reconcileWedgedSessions(Date.now());
    expect(reEvents.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(restarted.service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(restarted.service.tools.getTask(taskId)?.wedgeRespawnsByRole[role]).toBe(1);
  });

  it("preflights missing RED proof: escalate without stop or ledger spend", () => {
    const { service, events, config } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    config.writeGlobal("policies", "{ redBaselineGateRequired: true }\n");
    const { taskId, sessionId, role } = seedBuilder(service);
    // Spawn used a Captain override; strip it so policy re-engages without proof.
    const task = service.tools.getTask(taskId)!;
    service.tools.hydrateTask({
      ...task,
      phase: "BUILDING",
      policyOverrides: task.policyOverrides.filter(
        (o) => o.policyId !== "redBaselineGateRequired",
      ),
      updatedAt: new Date().toISOString(),
    });
    expect(service.tools.getTask(taskId)?.policyOverrides.some(
      (o) => o.policyId === "redBaselineGateRequired",
    )).toBe(false);
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    events.length = 0;
    const acted = service.tools.reconcileWedgedSessions(Date.now());
    expect(acted).toHaveLength(1);
    expect(acted[0]?.action).toBe("escalated");
    const session = service.tools.listSessions().find((s) => s.sessionId === sessionId);
    expect(session?.status).toBe("wedged");
    expect(service.tmux.hasWindow(session!.tmuxWindow)).toBe(true);
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
    expect(events.some((e) => e.type === "captain.escalation")).toBe(true);
    const wedged = events.find((e) => e.type === "session.wedged");
    if (wedged?.type === "session.wedged") {
      expect(wedged.payload.action).toBe("escalated");
      expect(wedged.payload.respawnsUsed).toBe(0);
    }
  });

  it("escalates when seat B's respawn fails even if same-role peer A is live", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId: sessionB, role } = seedBuilder(service);
    // Peer A: second builder on the same task (first-class multi-seat shape).
    const peerSpawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role,
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(peerSpawn.ok).toBe(true);
    const sessionA = (peerSpawn.data as { session: { sessionId: string } }).session.sessionId;
    expect(sessionA).not.toBe(sessionB);

    backdateSession(service, sessionB, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    let refuseSpawn = true;
    service.tmux.newWindow = (opts) => {
      if (refuseSpawn) {
        refuseSpawn = false;
        throw new Error("simulated spawn refusal for wedged seat B");
      }
      return originalNewWindow(opts);
    };

    events.length = 0;
    try {
      const acted = service.tools.reconcileWedgedSessions(Date.now());
      expect(acted.some((a) => a.sessionId === sessionB && a.action === "escalated")).toBe(true);
    } finally {
      service.tmux.newWindow = originalNewWindow;
    }

    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.phase).toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionB);
    // Peer A must not absorb or prevent the notify.
    expect(
      service.tools.listSessions().find((s) => s.sessionId === sessionA)?.status,
    ).toBe("running");

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
  });

  it("retires write-ahead only for B's derived replacement, not peer A", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId: sessionB, role } = seedBuilder(service);
    const peerSpawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role,
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(peerSpawn.ok).toBe(true);
    const sessionA = (peerSpawn.data as { session: { sessionId: string } }).session.sessionId;

    backdateSession(service, sessionB, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    events.length = 0;
    expect(service.tools.reconcileWedgedSessions(Date.now())[0]?.action).toBe("respawned");
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);

    const after = service.tools.getTask(taskId)!;
    const replacement = after.sessions.find(
      (s) =>
        s.role === role &&
        s.status === "running" &&
        s.sessionId !== sessionB &&
        s.sessionId !== sessionA,
    );
    expect(replacement).toBeDefined();
    expect(replacement!.sessionId).not.toBe(sessionA);

    // Crash window: clear never ran; no stamp — derivation must pick replacement over peer A.
    service.tools.hydrateTask({
      ...after,
      wedgePendingCaptainNotifies: [
        {
          sessionId: sessionB,
          role,
          summary: `Seat ${role} wedged and could not be respawned — no activity for 60m`,
          severity: "critical",
          recordedAt: new Date(Date.parse(replacement!.startedAt) - 1_000).toISOString(),
          writeAheadRespawn: true,
        },
      ],
      wedgeLadderCompletedSessionIds: (after.wedgeLadderCompletedSessionIds ?? []).filter(
        (id) => id !== sessionB,
      ),
      updatedAt: new Date().toISOString(),
    });

    events.length = 0;
    service.tools.reconcileWedgedSessions(Date.now());
    expect(events.filter((e) => e.type === "captain.escalation")).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("NEEDS_CAPTAIN");
    expect(service.tools.getTask(taskId)?.wedgePendingCaptainNotifies ?? []).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.wedgeLadderCompletedSessionIds).toContain(sessionB);
  });

  it("clears unanswered questions when a seat is stopped or lost", () => {
    const { service, home } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId } = seedBuilder(service);
    const questionId = "01JQ5T0000000000000000001A";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Will die with this seat.",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.pendingQuestions).toHaveLength(1);

    const stopped = service.tools.invoke("stop_crewmate", {
      sessionId,
      reason: "captain stopped seat with open question",
    });
    expect(stopped.ok).toBe(true);
    expect(service.tools.listQuestions()).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.pendingQuestions ?? []).toHaveLength(0);
    const durable = JSON.parse(
      readFileSync(join(home, "runs", taskId, "task.json"), "utf8"),
    ) as { pendingQuestions: unknown[] };
    expect(durable.pendingQuestions).toHaveLength(0);

    const answer = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "too late",
    });
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("NOT_FOUND");

    // Lost path: new seat + question, then markSessionLost.
    const respawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
      redBaselineOverride: true,
    });
    expect(respawned.ok).toBe(true);
    const liveId = (respawned.data as { session: { sessionId: string } }).session.sessionId;
    const lostQuestionId = "01JQ5T0000000000000000001B";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId: liveId,
      questionId: lostQuestionId,
      question: "Will die when pane is lost.",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);
    service.tools.markSessionLost(liveId, "pane died with open question");
    expect(service.tools.listQuestions()).toHaveLength(0);
    expect(service.tools.getTask(taskId)?.pendingQuestions ?? []).toHaveLength(0);
    const answerLost = service.tools.invoke("answer_crewmate", {
      questionId: lostQuestionId,
      answer: "too late",
    });
    expect(answerLost.ok).toBe(false);
    expect(answerLost.error?.code).toBe("NOT_FOUND");
  });

  it("keeps open questions and wedge exemption while seat is merely waiting", () => {
    const { service, events } = fleet({ staleBuildMinutes: 30, respawnPerStage: 1 });
    const { taskId, sessionId, role } = seedBuilder(service);
    const questionId = "01JQ5T0000000000000000001C";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Still waiting on Captain — not terminal.",
      ts: new Date().toISOString(),
    });
    backdateSession(service, sessionId, {
      idleMinutes: 60,
      lastEventAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    events.length = 0;
    expect(service.tools.reconcileWedgedSessions(Date.now())).toHaveLength(0);
    expect(events.filter((e) => e.type === "session.wedged")).toHaveLength(0);
    expect(service.tools.listQuestions()).toHaveLength(1);
    expect(service.tools.getTask(taskId)?.pendingQuestions).toHaveLength(1);
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );
    expect(service.tools.getTask(taskId)?.wedgeRespawnsByRole[role] ?? 0).toBe(0);
  });
});
