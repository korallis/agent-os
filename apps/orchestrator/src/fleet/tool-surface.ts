import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import {
  authorGateInputSchema,
  cancelTaskInputSchema,
  createTaskInputSchema,
  deliverTaskInputSchema,
  dispatchFusionInputSchema,
  escalateToCaptainInputSchema,
  notifyCaptainInputSchema,
  readPolicyInputSchema,
  readTaskInputSchema,
  resolveCastInputSchema,
  respawnCrewmateInputSchema,
  runGateInputSchema,
  sendToCrewInputSchema,
  spawnCrewmateInputSchema,
  stowKnowledgeInputSchema,
  stopCrewmateInputSchema,
  updateTaskInputSchema,
  advancePhaseInputSchema,
  type AgentOsConfig,
  type BrainSnapshot,
  type BrainToolName,
  type FleetSession,
  type FleetStateSnapshot,
  type OrchestratorEvent,
  type RoleCast,
  type TaskPhase,
  type TaskSession,
  type TaskSnapshot,
  type ToolError,
  type ToolErrorCode,
} from "@agent-os/protocol";
import type { ConfigService } from "../config/service.js";
import type { ConnectionRegistry } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { buildPiSpawnSpec } from "../pi/manager.js";
import { familyFromModel } from "../substrate/family.js";
import {
  assertTransition,
  canRunGate,
  canSpawnBuilder,
  canSpawnScout,
  IllegalTransitionError,
  isTerminalPhase,
} from "../substrate/task-machine.js";
import type { ProjectRegistry } from "./projects.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { TmuxController } from "./tmux.js";
import type { WakeWatcher } from "./watcher.js";
import type { GateRunner } from "./gate-runner.js";

export type ToolEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

export interface ToolCallResult {
  invocationId: string;
  ok: boolean;
  data?: unknown;
  error?: ToolError;
  durationMs: number;
}

export interface ToolSurfaceDeps {
  home: string;
  config: ConfigService;
  projects: ProjectRegistry;
  worktrees: WorktreePool;
  tmux: TmuxController;
  watcher: WakeWatcher;
  gates: GateRunner;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  extensionPath?: string;
  /** When true (tests / no Pi), crewmates are simulated. */
  fakePi?: boolean;
}

/**
 * Brain tool surface (master plan §5.3).
 * Deterministic substrate: validates transitions + policy, executes, records events.
 * Never makes judgment calls.
 */
export class ToolSurface {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly sessions = new Map<string, FleetSession>();
  private readonly idempotency = new Map<string, TaskSnapshot>();
  private readonly toolIdempotency = new Map<string, ToolCallResult>();
  private sink: ToolEventSink = () => undefined;
  private brain: BrainSnapshot;
  private brainDown = false;
  private readonly failLines = new Map<string, string[]>();

  constructor(private readonly deps: ToolSurfaceDeps) {
    this.brain = {
      status: "down",
      sessionId: null,
      model: null,
      thinking: null,
      family: null,
      provider: null,
      tmuxWindow: null,
      wakeQueueDepth: 0,
      lastReconcileAt: null,
      handoffFrom: null,
      handoffReason: null,
    };
  }

  onEvent(sink: ToolEventSink): void {
    this.sink = sink;
  }

  setBrainSnapshot(brain: BrainSnapshot): void {
    this.brain = brain;
    this.brainDown = brain.status === "down";
    this.deps.watcher.setBrainDown(this.brainDown);
  }

  isBrainDown(): boolean {
    return this.brainDown;
  }

  getTask(id: string): TaskSnapshot | null {
    return this.tasks.get(id) ?? null;
  }

  listTasks(): TaskSnapshot[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listSessions(): FleetSession[] {
    return [...this.sessions.values()];
  }

  readFleetState(): FleetStateSnapshot {
    return {
      brain: {
        ...this.brain,
        wakeQueueDepth: this.deps.watcher.queueDepth(),
      },
      tasks: this.listTasks(),
      sessions: this.listSessions(),
      worktrees: this.deps.worktrees.list(),
      wakeQueue: this.deps.watcher.getQueue(),
      projects: this.deps.projects.list(),
      brainDown: this.brainDown,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Hydrate from durable task store (daemon boot). */
  hydrateTask(task: TaskSnapshot): void {
    this.tasks.set(task.id, task);
    if (task.idempotencyKey !== null) {
      this.idempotency.set(task.idempotencyKey, task);
    }
  }

  invoke(
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    options: { idempotencyKey?: string } = {},
  ): ToolCallResult {
    const started = Date.now();
    const invocationId = nextUlid();

    if (options.idempotencyKey !== undefined) {
      const cached = this.toolIdempotency.get(`${tool}:${options.idempotencyKey}`);
      if (cached !== undefined) return cached;
    }

    // Orchestration tools blocked in BRAIN_DOWN except read_* and create via REST captain.
    if (
      this.brainDown &&
      tool !== "read_fleet_state" &&
      tool !== "read_task" &&
      tool !== "read_policy" &&
      tool !== "read_run_artifacts" &&
      tool !== "notify_captain"
    ) {
      // Captain REST may still create_task; Brain cannot orchestrate.
      if (tool !== "create_task") {
        return this.finish(invocationId, tool, null, started, {
          ok: false,
          error: err("BRAIN_DOWN", "brain is down — orchestration tools are blocked"),
        });
      }
    }

    try {
      const data = this.dispatch(tool, rawInput);
      const result = this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: true,
        data,
      });
      if (options.idempotencyKey !== undefined) {
        this.toolIdempotency.set(`${tool}:${options.idempotencyKey}`, result);
      }
      return result;
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return this.finish(invocationId, tool, error.taskId, started, {
          ok: false,
          error: err("ILLEGAL_TRANSITION", error.message, {
            from: error.from,
            to: error.to,
          }),
        });
      }
      if (error instanceof ToolSurfaceError) {
        return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
          ok: false,
          error: err(error.code, error.message, error.details),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: false,
        error: err("INTERNAL", message),
      });
    }
  }

  private finish(
    invocationId: string,
    tool: BrainToolName,
    taskId: string | null,
    started: number,
    body: { ok: true; data: unknown } | { ok: false; error: ToolError },
  ): ToolCallResult {
    const durationMs = Date.now() - started;
    this.sink({
      type: "tool.invoked",
      payload: {
        invocationId,
        tool,
        taskId,
        ok: body.ok,
        errorCode: body.ok ? null : body.error.code,
        durationMs,
      },
    });
    if (body.ok) {
      return { invocationId, ok: true, data: body.data, durationMs };
    }
    return { invocationId, ok: false, error: body.error, durationMs };
  }

  private dispatch(tool: BrainToolName, raw: Record<string, unknown>): unknown {
    switch (tool) {
      case "create_task":
        return this.createTask(raw);
      case "update_task":
        return this.updateTask(raw);
      case "cancel_task":
        return this.cancelTask(raw);
      case "read_fleet_state":
        return this.readFleetState();
      case "read_task":
        return this.readTask(raw);
      case "read_run_artifacts":
        return this.readRunArtifacts(raw);
      case "resolve_cast":
        return this.resolveCast(raw);
      case "spawn_crewmate":
        return this.spawnCrewmate(raw);
      case "stop_crewmate":
        return this.stopCrewmate(raw);
      case "respawn_crewmate":
        return this.respawnCrewmate(raw);
      case "dispatch_fusion":
        return this.dispatchFusion(raw);
      case "author_gate":
        return this.authorGate(raw);
      case "run_gate":
        return this.runGate(raw);
      case "send_to_crew":
        return this.sendToCrew(raw);
      case "answer_crewmate":
        return { answered: true };
      case "deliver_task":
        return this.deliverTask(raw);
      case "escalate_to_captain":
        return this.escalate(raw);
      case "notify_captain":
        return this.notify(raw);
      case "route_to_secondmate":
        throw new ToolSurfaceError("NOT_FOUND", "secondmates are Phase 7 — not provisioned");
      case "read_secondmate_bearings":
        throw new ToolSurfaceError("NOT_FOUND", "secondmates are Phase 7 — not provisioned");
      case "stow_knowledge":
        return this.stowKnowledge(raw);
      case "read_policy":
        return this.readPolicy(raw);
      case "advance_phase":
        return this.advancePhase(raw);
      default: {
        const _exhaustive: never = tool;
        throw new ToolSurfaceError("VALIDATION_ERROR", `unknown tool: ${String(_exhaustive)}`);
      }
    }
  }

  private cfg(): AgentOsConfig {
    return this.deps.config.effective().config;
  }

  private createTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = createTaskInputSchema.parse(raw);
    if (input.idempotencyKey !== undefined) {
      const existing = this.idempotency.get(input.idempotencyKey);
      if (existing !== undefined) return existing;
    }

    const project = this.deps.projects.get(input.spec.projectId);
    if (project === null) {
      throw new ToolSurfaceError("NOT_FOUND", `project not found: ${input.spec.projectId}`);
    }

    const now = new Date().toISOString();
    const maxValidations = this.cfg().validation.maxValidations;
    const yolo = input.spec.shape === "SHIP" ? input.spec.yolo : false;
    const mode = input.spec.shape === "SHIP" ? input.spec.mode : input.spec.mode;

    const task: TaskSnapshot = {
      id: nextUlid(),
      shape: input.spec.shape,
      title: input.spec.title,
      intent: input.spec.intent,
      projectId: input.spec.projectId,
      mode,
      yolo,
      phase: "QUEUED",
      failureCause: null,
      cast: [],
      sessions: [],
      validationAttempt: 0,
      maxValidations,
      branch: null,
      worktreePath: null,
      needsCaptainSummary: null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
      configSnapshotHash: hashConfig(this.cfg()),
      policyOverrides: [],
    };

    this.tasks.set(task.id, task);
    if (task.idempotencyKey !== null) {
      this.idempotency.set(task.idempotencyKey, task);
    }
    this.persistTask(task);
    this.sink({
      type: "task.created",
      payload: {
        taskId: task.id,
        shape: task.shape,
        projectId: task.projectId,
        title: task.title,
        mode: task.mode,
        phase: task.phase,
        idempotencyKey: task.idempotencyKey,
      },
    });
    return task;
  }

  private updateTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = updateTaskInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    if (isTerminalPhase(task.phase)) {
      throw new ToolSurfaceError("CONFLICT", `task ${task.id} is terminal (${task.phase})`);
    }
    const updated: TaskSnapshot = {
      ...task,
      title: input.patch.title ?? task.title,
      intent: input.patch.intent ?? task.intent,
      mode: input.patch.mode ?? task.mode,
      updatedAt: new Date().toISOString(),
    };
    this.saveTask(updated);
    this.sink({
      type: "task.updated",
      payload: { taskId: updated.id, title: updated.title, phase: updated.phase },
    });
    return updated;
  }

  private cancelTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = cancelTaskInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    return this.transition(task, "CANCELLED", input.reason);
  }

  private readTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = readTaskInputSchema.parse(raw);
    return this.requireTask(input.taskId);
  }

  private readRunArtifacts(raw: Record<string, unknown>): { taskId: string; path: string; files: string[] } {
    const input = readTaskInputSchema.parse(raw);
    const dir = join(this.deps.home, "runs", input.taskId);
    return { taskId: input.taskId, path: dir, files: existsSync(dir) ? ["task.json"] : [] };
  }

  private resolveCast(raw: Record<string, unknown>): { taskId: string; cast: RoleCast[] } {
    const input = resolveCastInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    const policies = this.cfg().policies;

    const cast: RoleCast[] = input.roles.map((r) => ({
      role: r.role,
      model: r.model,
      thinking: r.thinking,
      family: familyFromModel(r.model),
      cleanRoom: r.cleanRoom,
    }));

    // LIMIT REACHED exclusion
    if (this.deps.connections !== undefined) {
      for (const role of cast) {
        const provider = role.model.split("/")[0] ?? "";
        const conn = this.deps.connections
          .list()
          .find((c) => c.provider === provider || role.model.startsWith(c.provider));
        if (conn?.limitReached === true) {
          throw new ToolSurfaceError(
            "LIMIT_REACHED",
            `connection ${conn.id} (${conn.provider}) is LIMIT REACHED — excluded from cast`,
            { connectionId: conn.id, provider: conn.provider, role: role.role },
          );
        }
      }
    }

    // Cross-family builder ≠ validator
    const builder = cast.find((c) => c.role === "builder");
    const validator = cast.find((c) => c.role === "validator");
    if (
      policies.crossFamilyBuilderValidator &&
      builder !== undefined &&
      validator !== undefined &&
      builder.family === validator.family &&
      !input.familyCheckOverride
    ) {
      throw new ToolSurfaceError(
        "POLICY_VIOLATION",
        `builder family (${builder.family}) must differ from validator family (${validator.family})`,
        { builder: builder.model, validator: validator.model },
      );
    }

    // Distinct planner families for plan-fusion casts
    const planners = cast.filter((c) => c.role === "planner");
    if (policies.distinctPlannerFamilies && planners.length >= 2) {
      const families = new Set(planners.map((p) => p.family));
      if (families.size < 2 && !input.familyCheckOverride) {
        throw new ToolSurfaceError(
          "POLICY_VIOLATION",
          "plan-fusion requires ≥2 distinct planner families",
        );
      }
    }

    let policyOverrides = task.policyOverrides;
    if (input.familyCheckOverride) {
      policyOverrides = [
        ...policyOverrides,
        {
          policyId: "crossFamilyBuilderValidator",
          configuredValue: "overridden",
          layer: "task",
          stampedAt: new Date().toISOString(),
        },
      ];
    }

    let next = {
      ...task,
      cast,
      policyOverrides,
      updatedAt: new Date().toISOString(),
    };
    if (task.phase === "QUEUED") {
      next = this.transition(next, "DISPATCH_RESOLVED", "cast resolved");
    } else {
      this.saveTask(next);
    }

    this.sink({
      type: "task.cast_resolved",
      payload: {
        taskId: next.id,
        roles: cast.map((c) => ({
          role: c.role,
          model: c.model,
          thinking: c.thinking,
          family: c.family,
        })),
        familyCheckOverridden: input.familyCheckOverride,
      },
    });
    return { taskId: next.id, cast };
  }

  private spawnCrewmate(raw: Record<string, unknown>): {
    session: FleetSession;
    task: TaskSnapshot;
  } {
    const input = spawnCrewmateInputSchema.parse(raw);
    let task = this.requireTask(input.taskId);
    const project = this.deps.projects.get(task.projectId);
    if (project === null) {
      throw new ToolSurfaceError("NOT_FOUND", `project not found: ${task.projectId}`);
    }

    if (input.role === "scout" && !canSpawnScout(task.phase)) {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `cannot spawn scout in phase ${task.phase}`,
      );
    }
    if (input.role === "builder" && !canSpawnBuilder(task.phase)) {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `cannot spawn builder in phase ${task.phase}`,
      );
    }

    const family = familyFromModel(input.model);
    const sessionId = nextUlid();
    const windowName = `${input.role}-${sessionId.slice(0, 8).toLowerCase()}`;

    let worktreePath: string | null = null;
    let branch: string | null = task.branch;

    if (input.role === "builder" || input.role === "scout" || input.role === "planner") {
      try {
        const lease = this.deps.worktrees.lease({
          projectId: task.projectId,
          repoPath: project.path,
          taskId: task.id,
          sessionId,
          ...(task.branch !== null ? { branch: task.branch } : {}),
        });
        worktreePath = lease.path;
        branch = lease.branch;
      } catch (error) {
        if (error instanceof Error && error.message.includes("exhausted")) {
          task = this.transition(task, "WAITING_WORKTREE", error.message);
          throw new ToolSurfaceError("CONFLICT", error.message);
        }
        throw error;
      }
    }

    const cwd = worktreePath ?? project.path;
    const fake =
      this.deps.fakePi === true ||
      process.env.AGENTOS_FAKE_PI === "1" ||
      this.deps.pi?.binary == null;

    let tmuxWindow = `agentos:${windowName}`;
    if (fake) {
      this.deps.tmux.newWindow({
        windowName,
        command: `echo fake-pi ${input.role} ${sessionId}`,
        cwd,
      });
    } else if (this.deps.pi !== undefined && this.deps.extensionPath !== undefined) {
      const prompt =
        input.prompt ??
        `Agent OS role=${input.role}. Task: ${task.title}\n\n${task.intent}`;
      const spec = buildPiSpawnSpec({
        agentosHome: this.deps.home,
        detection: this.deps.pi,
        args: ["--mode", "json", "-p", prompt, "--model", input.model],
        cwd,
        sessionId,
        socketPath: join(this.deps.home, "sockets", `${sessionId}.sock`),
        extensionPath: this.deps.extensionPath,
        cleanRoom: input.cleanRoom,
      });
      const cmd = [spec.binary, ...spec.args].map(shellQuote).join(" ");
      const win = this.deps.tmux.newWindow({ windowName, command: cmd, cwd });
      tmuxWindow = win.target;
    } else {
      this.deps.tmux.newWindow({
        windowName,
        command: `echo missing-pi ${input.role}`,
        cwd,
      });
    }

    const now = new Date().toISOString();
    const taskSession: TaskSession = {
      sessionId,
      role: input.role,
      model: input.model,
      thinking: input.thinking,
      family,
      tmuxWindow,
      worktreePath,
      status: fake ? "settled" : "running",
      startedAt: now,
      lastEventAt: now,
    };
    const fleetSession: FleetSession = {
      sessionId,
      taskId: task.id,
      role: input.role,
      model: input.model,
      thinking: input.thinking,
      family,
      tmuxWindow,
      status: fake ? "settled" : "running",
      worktreePath,
      startedAt: now,
    };
    this.sessions.set(sessionId, fleetSession);

    task = {
      ...task,
      sessions: [...task.sessions.filter((s) => s.sessionId !== sessionId), taskSession],
      worktreePath: worktreePath ?? task.worktreePath,
      branch: branch ?? task.branch,
      updatedAt: now,
    };

    if (input.role === "builder" && task.phase !== "BUILDING") {
      task = this.transition(task, "BUILDING", "builder spawned");
    } else if (input.role === "scout" && task.phase === "QUEUED") {
      task = this.transition(task, "BUILDING", "scout spawned");
    } else if (input.role === "planner" && task.phase === "DISPATCH_RESOLVED") {
      task = this.transition(task, "PLANNING", "planner spawned");
    } else if (input.role === "validator" && task.phase === "DISPATCH_RESOLVED") {
      task = this.transition(task, "GATE_AUTHORING", "validator spawned");
    } else {
      this.saveTask(task);
    }

    this.sink({
      type: "session.spawned",
      payload: {
        sessionId,
        taskId: task.id,
        role: input.role,
        model: input.model,
        family,
        tmuxWindow,
        worktreePath,
      },
    });

    // Fake Pi auto-settles for zero-token idle proofs and local-only SHIP.
    if (fake) {
      this.deps.watcher.classify({
        class: "AGENT_SETTLED",
        taskId: task.id,
        sessionId,
        summary: `${input.role} settled (fake pi)`,
      });
    }

    return { session: fleetSession, task: this.requireTask(task.id) };
  }

  private stopCrewmate(raw: Record<string, unknown>): { sessionId: string } {
    const input = stopCrewmateInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    this.deps.tmux.killWindow(session.tmuxWindow);
    this.sessions.set(input.sessionId, { ...session, status: "stopped" });
    this.sink({
      type: "session.stopped",
      payload: {
        sessionId: input.sessionId,
        taskId: session.taskId,
        reason: input.reason,
      },
    });
    return { sessionId: input.sessionId };
  }

  private respawnCrewmate(raw: Record<string, unknown>): unknown {
    const input = respawnCrewmateInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined || session.taskId === null) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    this.stopCrewmate({ sessionId: input.sessionId, reason: input.reason });
    return this.spawnCrewmate({
      taskId: session.taskId,
      role: session.role,
      model: session.model,
      thinking: session.thinking,
      cleanRoom: true,
      vars: {},
    });
  }

  private dispatchFusion(raw: Record<string, unknown>): { runId: string; contractOk?: boolean } {
    const input = dispatchFusionInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    if (input.kind === "plan-fusion") {
      const families = new Set(input.casts.map((c) => c.family));
      if (this.cfg().policies.distinctPlannerFamilies && families.size < 2) {
        throw new ToolSurfaceError(
          "POLICY_VIOLATION",
          "plan-fusion requires ≥2 distinct families",
        );
      }
    }
    const runId = nextUlid();
    const dir = join(this.deps.home, "runs", task.id, "fusion", runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const instruction =
      input.instruction ?? `Fusion kind=${input.kind} for ${task.title}\n`;
    writeFileSync(join(dir, "instruction.md"), instruction, { mode: 0o600 });

    // When a fused artifact is supplied as instruction for kind=fusion, enforce contract.
    let contractOk: boolean | undefined;
    if (input.kind === "fusion" && input.instruction !== undefined) {
      // Dynamic import avoided — pure check inline for packaging simplicity.
      const hasTags =
        /\[ARCHITECT\]/i.test(input.instruction) &&
        /\[BUILDER\]/i.test(input.instruction) &&
        /\[FUSION\]/i.test(input.instruction) &&
        /consensus\s*&\s*divergence/i.test(input.instruction);
      contractOk = hasTags;
      if (!hasTags) {
        throw new ToolSurfaceError(
          "FUSION_CONTRACT",
          "fusion artifact missing required spans or Consensus & Divergence",
        );
      }
      writeFileSync(join(dir, "fused.md"), input.instruction, { mode: 0o600 });
    }

    this.sink({
      type: "fusion.dispatched",
      payload: { taskId: task.id, kind: input.kind, runId },
    });
    if (input.kind === "plan-fusion" && task.phase === "PLANNING") {
      this.transition(task, "PLAN_FUSED", "plan-fusion complete");
    }
    return contractOk === undefined ? { runId } : { runId, contractOk };
  }

  private authorGate(raw: Record<string, unknown>): { taskId: string; gatePath: string } {
    const input = authorGateInputSchema.parse(raw);
    let task = this.requireTask(input.taskId);
    if (task.phase === "DISPATCH_RESOLVED" || task.phase === "PLAN_FUSED") {
      task = this.transition(task, "GATE_AUTHORING", "author_gate");
    } else if (task.phase !== "GATE_AUTHORING") {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `run_gate authoring not legal in phase ${task.phase}`,
      );
    }
    const source =
      input.gateSource ??
      `#!/usr/bin/env python3\n# /// script\n# requires-python = ">=3.11"\n# dependencies = []\n# ///\nimport os\nif os.environ.get("AGENTOS_GATE_TARGET") == "baseline":\n    print("EXPECTED_RED")\n    print("FAIL baseline")\n    raise SystemExit(1)\nprint("PASS")\n`;
    const path = this.deps.gates.writeGateSource(task.id, source);
    return { taskId: task.id, gatePath: path };
  }

  private runGate(raw: Record<string, unknown>): {
    outcome: string;
    outputHash: string;
    failLines: string[];
  } {
    const input = runGateInputSchema.parse(raw);
    let task = this.requireTask(input.taskId);
    if (!canRunGate(task.phase, input.target)) {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `run_gate(${input.target}) illegal in phase ${task.phase}`,
      );
    }

    const project = this.deps.projects.get(task.projectId);
    const cwd =
      input.target === "baseline"
        ? this.deps.gates.gateWorkspace(task.id)
        : (task.worktreePath ?? project?.path ?? this.deps.home);

    const result = this.deps.gates.run({
      taskId: task.id,
      target: input.target,
      cwd,
      expectedRed: this.cfg().policies.redBaselineGateRequired,
    });

    this.failLines.set(task.id, result.failLines);
    this.sink({
      type: "gate.result",
      payload: {
        taskId: task.id,
        target: input.target,
        outcome: result.outcome,
        attempt: task.validationAttempt,
        outputHash: result.outputHash,
      },
    });

    if (input.target === "baseline") {
      if (result.outcome === "EXPECTED_RED" || result.outcome === "FAIL") {
        task = this.transition(task, "GATE_RED_VERIFIED", "baseline red proven");
      } else if (result.outcome === "PASS") {
        throw new ToolSurfaceError(
          "GATE_ERROR",
          "GATE DEFECT: baseline passed — refusing builder spawn",
        );
      } else {
        throw new ToolSurfaceError("GATE_ERROR", `baseline gate error: ${result.stderr}`);
      }
    } else {
      // candidate
      if (result.outcome === "PASS") {
        // stay in VALIDATING or move toward DELIVERING — Brain decides via advance/deliver
        if (task.phase === "BUILDING") {
          task = this.transition(task, "VALIDATING", "candidate gate pass");
        }
      } else if (result.outcome === "FAIL") {
        const attempt = task.validationAttempt + 1;
        task = {
          ...task,
          validationAttempt: attempt,
          updatedAt: new Date().toISOString(),
        };
        this.saveTask(task);
        if (attempt >= task.maxValidations) {
          task = this.transition(task, "VALIDATION_EXHAUSTED", "max validations reached");
        } else {
          task = this.transition(task, "BUILDING", "gate fail — rebuild");
        }
      } else {
        throw new ToolSurfaceError("GATE_ERROR", `candidate gate error: ${result.stderr}`);
      }
    }

    return {
      outcome: result.outcome,
      outputHash: result.outputHash,
      failLines: result.failLines,
    };
  }

  private sendToCrew(raw: Record<string, unknown>): { sent: boolean } {
    const input = sendToCrewInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    let message = input.message ?? "";
    if (input.gateFailRef !== undefined) {
      // Verbatim FAIL injection — Brain cannot paraphrase.
      const taskId = session.taskId;
      const lines =
        taskId !== null
          ? (this.failLines.get(taskId) ?? this.deps.gates.readLastFailLines(taskId))
          : [];
      message = lines.join("\n");
      if (message.length === 0) {
        throw new ToolSurfaceError("NOT_FOUND", "no gate fail lines held for verbatim inject");
      }
    }
    if (message.length === 0) {
      throw new ToolSurfaceError("VALIDATION_ERROR", "message or gateFailRef required");
    }
    try {
      this.deps.tmux.sendKeys(session.tmuxWindow, message);
    } catch {
      // fake tmux ok
    }
    return { sent: true };
  }

  private deliverTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = deliverTaskInputSchema.parse(raw);
    let task = this.requireTask(input.taskId);
    const deliverable: TaskPhase[] = [
      "BUILDING",
      "VALIDATING",
      "GATE_RED_VERIFIED",
      "DISPATCH_RESOLVED",
      "DELIVERING",
    ];
    if (!deliverable.includes(task.phase)) {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `cannot deliver from phase ${task.phase}`,
      );
    }

    if (task.phase !== "DELIVERING") {
      task = this.transition(task, "DELIVERING", "deliver_task");
    }

    const branch = task.branch ?? `ao/${task.id.slice(0, 10).toLowerCase()}`;
    const runDir = join(this.deps.home, "runs", task.id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(runDir, "delivery.json"),
      JSON.stringify(
        {
          mode: task.mode,
          branch,
          at: new Date().toISOString(),
          shape: task.shape,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    // Release worktrees
    for (const lease of this.deps.worktrees.list().filter((l) => l.taskId === task.id)) {
      this.deps.worktrees.release(lease.id, {});
    }

    task = {
      ...this.transition(task, "DONE", "delivered"),
      branch,
    };
    this.saveTask(task);
    return task;
  }

  private escalate(raw: Record<string, unknown>): { ok: true } {
    const input = escalateToCaptainInputSchema.parse(raw);
    if (input.taskId !== undefined) {
      const task = this.requireTask(input.taskId);
      if (!isTerminalPhase(task.phase)) {
        this.transition(task, "NEEDS_CAPTAIN", input.summary);
      }
    }
    this.sink({
      type: "captain.escalation",
      payload: {
        taskId: input.taskId ?? null,
        summary: input.summary,
        severity: input.severity,
      },
    });
    return { ok: true };
  }

  private notify(raw: Record<string, unknown>): { ok: true } {
    const input = notifyCaptainInputSchema.parse(raw);
    this.sink({
      type: "captain.escalation",
      payload: {
        taskId: null,
        summary: input.summary,
        severity: input.severity,
      },
    });
    return { ok: true };
  }

  private stowKnowledge(raw: Record<string, unknown>): { path: string } {
    const input = stowKnowledgeInputSchema.parse(raw);
    const project = this.deps.projects.get(input.projectId);
    if (project === null) {
      throw new ToolSurfaceError("NOT_FOUND", `project not found: ${input.projectId}`);
    }
    const rel = input.relativePath ?? `docs/notes/stow-${Date.now()}.md`;
    if (!rel.startsWith("docs/notes/")) {
      throw new ToolSurfaceError("POLICY_VIOLATION", "stow_knowledge path must be under docs/notes/");
    }
    const full = join(project.path, rel);
    mkdirSync(join(project.path, "docs", "notes"), { recursive: true });
    writeFileSync(full, input.notes, { mode: 0o600 });
    return { path: full };
  }

  private readPolicy(raw: Record<string, unknown>): unknown {
    const input = readPolicyInputSchema.parse(raw);
    const effective = this.deps.config.effective();
    return {
      domain: input.domain,
      value: effective.config[input.domain],
    };
  }

  private advancePhase(raw: Record<string, unknown>): TaskSnapshot {
    const input = advancePhaseInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    const to = input.to as TaskPhase;
    return this.transition(task, to, input.reason ?? null);
  }

  private requireTask(id: string): TaskSnapshot {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `task not found: ${id}`);
    }
    return task;
  }

  private transition(
    task: TaskSnapshot,
    to: TaskPhase,
    reason: string | null,
  ): TaskSnapshot {
    const from = task.phase;
    assertTransition(task.id, from, to);
    const updated: TaskSnapshot = {
      ...task,
      phase: to,
      failureCause: to === "FAILED" ? (task.failureCause ?? "UNKNOWN") : task.failureCause,
      needsCaptainSummary: to === "NEEDS_CAPTAIN" ? (reason ?? task.needsCaptainSummary) : task.needsCaptainSummary,
      updatedAt: new Date().toISOString(),
    };
    this.saveTask(updated);
    this.sink({
      type: "task.phase_changed",
      payload: { taskId: task.id, from, to, reason },
    });
    return updated;
  }

  private saveTask(task: TaskSnapshot): void {
    this.tasks.set(task.id, task);
    if (task.idempotencyKey !== null) {
      this.idempotency.set(task.idempotencyKey, task);
    }
    this.persistTask(task);
  }

  private persistTask(task: TaskSnapshot): void {
    const dir = join(this.deps.home, "runs", task.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "task.json"), `${JSON.stringify(task, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /** Mark a session lost (pane-died / reconcile). */
  markSessionLost(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.set(sessionId, { ...session, status: "lost" });
    this.sink({
      type: "session.lost",
      payload: { sessionId, taskId: session.taskId, reason },
    });
    if (session.taskId !== null) {
      const task = this.tasks.get(session.taskId);
      if (task !== undefined && !isTerminalPhase(task.phase)) {
        this.transition(task, "SESSION_LOST", reason);
      }
    }
  }
}

class ToolSurfaceError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolSurfaceError";
  }
}

function err(
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolError {
  return details !== undefined ? { code, message, details } : { code, message };
}

function extractTaskId(raw: Record<string, unknown>): string | null {
  const id = raw.taskId;
  return typeof id === "string" ? id : null;
}

function hashConfig(config: AgentOsConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
