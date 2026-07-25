import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { monotonicFactory } from "ulid";
import { ZodError } from "zod";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { enforceFusionContract } from "@agent-os/fusion-core";
import {
  answerCrewmateInputSchema,
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
  resolveDeliveryBlockInputSchema,
  respawnCrewmateInputSchema,
  runGateInputSchema,
  sendToCrewInputSchema,
  spawnCrewmateInputSchema,
  stowKnowledgeInputSchema,
  stopCrewmateInputSchema,
  updateTaskInputSchema,
  advancePhaseInputSchema,
  brainToolNameSchema,
  type AgentOsConfig,
  type BrainSnapshot,
  type BrainToolName,
  type DaemonControlFrame,
  type FleetSession,
  type FleetStateSnapshot,
  type FusionRun,
  type FusionSide,
  type PromptTemplateInfo,
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
import { resolveProviderKeyGrant } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { buildPiSpawnSpec } from "../pi/manager.js";
import { familyFromModel } from "../substrate/family.js";
import {
  assertTransition,
  canRunGate,
  canSpawnBuilder,
  canSpawnScout,
  canTransition,
  IllegalTransitionError,
  isTerminalPhase,
} from "../substrate/task-machine.js";
import type { ProjectRegistry } from "./projects.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { TmuxController } from "./tmux.js";
import type { WakeWatcher } from "./watcher.js";
import type { GateRunner } from "./gate-runner.js";
import type { FusionRunStore } from "./fusion-runs.js";
import { SessionKeyStore } from "./sessions.js";
import type { PromptService } from "../prompts/service.js";

/** Shipped instruction template per fusion kind (overridable per call/project). */
const DEFAULT_FUSION_TEMPLATES: Record<"opinion" | "fusion" | "plan-fusion", string> = {
  opinion: "fusion/opinion.md",
  fusion: "fusion/fusion.md",
  "plan-fusion": "fusion/fusion.md",
};

export type ToolEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

/**
 * The per-session control channel the tool surface needs. `SocketHub`
 * satisfies it; kept narrow so the fleet does not depend on the Pi layer.
 */
export interface SessionChannel {
  sessionSocketPath(sessionId: string): string;
  /** Open the per-session listener; must succeed before Pi is spawned. Throws on bind failure. */
  openSession(sessionId: string): string;
  closeSession(sessionId: string): Promise<void>;
  sendControl(sessionId: string, frame: DaemonControlFrame): boolean;
}

/**
 * Tools a non-Brain session may call over its own socket. Strictly read-only
 * plus report-upward (`notify_captain`); everything that writes or moves the
 * fleet is Brain-only (or Captain REST).
 */
const CREW_ALLOWED_TOOLS = new Set<BrainToolName>([
  "read_task",
  "read_policy",
  "read_run_artifacts",
  "notify_captain",
]);

/**
 * Captain REST only — never available on a session socket (Brain or crew).
 * Clears sticky deliveryBlocked after human inspection.
 */
const CAPTAIN_ONLY_TOOLS = new Set<BrainToolName>(["resolve_delivery_block"]);

/** A crewmate question awaiting an answer from the Brain or Captain. */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  taskId: string | null;
  question: string;
  askedAt: string;
}

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
  fusionRuns: FusionRunStore;
  sessionKeys: SessionKeyStore;
  /** Layered prompt packs; absent only in fixtures that never dispatch fusion. */
  prompts?: PromptService;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  extensionPath?: string;
  /** Per-session control channel used by the tool bridge. */
  sockets?: SessionChannel;
  /**
   * Explicit test seam: simulate crewmates instead of spawning Pi. Never
   * inferred — a missing Pi is a typed `PI_UNAVAILABLE` error, not a silent
   * downgrade to a window that echoes a string.
   */
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
  private readonly questions = new Map<string, PendingQuestion>();
  private brainSessionId: string | null = null;
  /**
   * sessionId → fusion side ownership for O(1) usage attribution and settle
   * completion. Entries stay until the run completes or the session stops so
   * late ext.usage frames after agent_settled are still attributed.
   */
  private readonly fusionBySessionId = new Map<
    string,
    { taskId: string; runId: string; sideIndex: number }
  >();
  /** sessionId → SessionKeyStore directory for this spawn. */
  private readonly sessionDirs = new Map<string, string>();

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

  /**
   * Attribute an `ext.usage` frame to the fusion side that owns its session.
   * No-op for sessions that are not part of a fusion run.
   */
  attributeFusionUsage(
    sessionId: string,
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
  ): void {
    const ref = this.fusionBySessionId.get(sessionId);
    if (ref === undefined) return;
    this.deps.fusionRuns.recordSideUsage(
      ref.taskId,
      ref.runId,
      sessionId,
      usage,
      ref.sideIndex,
    );
  }

  /** Fusion runs recorded for a task, newest first. */
  listFusionRuns(taskId: string): FusionRun[] {
    return this.deps.fusionRuns.listForTask(taskId);
  }

  /**
   * Session directory for a {project, role, model} triple. A changed model
   * yields a different key, so transcripts never cross model families.
   */
  ensureSessionKey(input: { projectId: string; role: string; model: string }): string {
    return this.deps.sessionKeys.ensure(input).dir;
  }

  /** The session id whose extension channel is allowed to orchestrate. */
  setBrainSessionId(sessionId: string | null): void {
    this.brainSessionId = sessionId;
  }

  /**
   * Route a tool call that arrived over a session's extension socket.
   *
   * Authorization is by session, not by claim: only the live Brain session may
   * orchestrate. Crewmates get a small self-service subset — they can read the
   * task they are working on, ask for policy, and report — so a compromised or
   * confused crewmate cannot spawn fleets or deliver work.
   */
  invokeFromSession(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
  ): ToolCallResult {
    const parsed = brainToolNameSchema.safeParse(tool);
    if (!parsed.success) {
      return {
        invocationId: nextUlid(),
        ok: false,
        error: err("VALIDATION_ERROR", `unknown tool: ${tool}`),
        durationMs: 0,
      };
    }
    const name = parsed.data;
    if (CAPTAIN_ONLY_TOOLS.has(name)) {
      return {
        invocationId: nextUlid(),
        ok: false,
        error: err(
          "UNAUTHORIZED_TOOL",
          `${name} is Captain-only — not available over a session socket`,
        ),
        durationMs: 0,
      };
    }
    const isBrain = this.brainSessionId !== null && sessionId === this.brainSessionId;
    if (!isBrain && !CREW_ALLOWED_TOOLS.has(name)) {
      return {
        invocationId: nextUlid(),
        ok: false,
        error: err(
          "UNAUTHORIZED_TOOL",
          `session ${sessionId} is not the Brain — ${name} is not available to crewmates`,
        ),
        durationMs: 0,
      };
    }
    return this.invoke(name, input);
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

  /** Hydrate from durable task store (daemon boot). Rebuilds in-memory session rows. */
  hydrateTask(task: TaskSnapshot): void {
    const normalized: TaskSnapshot = {
      ...task,
      deliveryBlocked: task.deliveryBlocked ?? null,
    };
    this.tasks.set(normalized.id, normalized);
    if (normalized.idempotencyKey !== null) {
      this.idempotency.set(normalized.idempotencyKey, normalized);
    }
    task = normalized;
    for (const s of task.sessions) {
      const fleetSession: FleetSession = {
        sessionId: s.sessionId,
        taskId: task.id,
        role: s.role,
        model: s.model,
        thinking: s.thinking,
        family: s.family,
        tmuxWindow: s.tmuxWindow,
        status: s.status,
        worktreePath: s.worktreePath,
        startedAt: s.startedAt,
      };
      this.sessions.set(s.sessionId, fleetSession);
    }
  }

  /**
   * Rebuild fusion side ownership from durable run.json after a daemon restart.
   * Sides with a sessionId that have not yet settled remain in-flight so
   * settle/session_end can still write artifacts and emit fusion.completed.
   */
  hydrateFusionOwnership(): void {
    for (const task of this.tasks.values()) {
      for (const run of this.deps.fusionRuns.listForTask(task.id)) {
        run.sides.forEach((side, sideIndex) => {
          if (side.sessionId === null) return;
          if (side.settledAt != null || side.artifactPath !== null) return;
          this.fusionBySessionId.set(side.sessionId, {
            taskId: task.id,
            runId: run.runId,
            sideIndex,
          });
          const key = SessionKeyStore.computeKey({
            projectId: task.projectId,
            role: side.role,
            model: side.model,
          });
          const record = this.deps.sessionKeys.get(key);
          if (record !== null) {
            this.sessionDirs.set(side.sessionId, record.dir);
          }
        });
      }
    }
  }

  /**
   * After boot hydrate: re-open per-session listeners for non-terminal live
   * sessions so surviving Pi panes can re-hello.
   */
  rebindSessionListeners(): void {
    if (this.deps.sockets === undefined) return;
    for (const session of this.sessions.values()) {
      if (session.status !== "starting" && session.status !== "running") continue;
      try {
        this.deps.sockets.openSession(session.sessionId);
      } catch {
        // Bind failure is non-fatal at boot; reconcile will mark the session lost
        // if the pane is also gone.
      }
    }
  }

  /**
   * Fallback liveness: any starting/running session whose tmux window is gone
   * becomes SESSION_LOST. Prefer the extension session_end path; this is the
   * pane-scraping fallback.
   */
  reconcileDeadPanes(): string[] {
    const lost: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.status !== "starting" && session.status !== "running") continue;
      if (this.deps.tmux.hasWindow(session.tmuxWindow)) continue;
      this.markSessionLost(session.sessionId, "tmux pane missing (reconcile)");
      lost.push(session.sessionId);
    }
    return lost;
  }

  /**
   * Boot/restart reconcile for the session-key gate (master plan §6.5 / G6).
   *
   * For each non-terminal task that already has crewmate sessions, compare the
   * resolved cast against SessionKeyStore and respawn ONLY roles whose session
   * directory is absent — surviving dirs (and their live panes) are left alone.
   * Live sessions whose key dir vanished are marked lost before respawn so a
   * wiped directory cannot leave an orphan "running" row blocking the gate.
   */
  reconcileMissingCastRoles(): Array<{ taskId: string; role: string; model: string }> {
    const respawned: Array<{ taskId: string; role: string; model: string }> = [];
    for (const task of this.listTasks()) {
      if (isTerminalPhase(task.phase)) continue;
      if (task.cast.length === 0 || task.sessions.length === 0) continue;

      const expected = task.cast.map((c) => ({ role: c.role, model: c.model }));
      const missing = this.deps.sessionKeys.missingRoles(task.projectId, expected);
      for (const slot of missing) {
        const castEntry = task.cast.find(
          (c) => c.role === slot.role && c.model === slot.model,
        );
        if (castEntry === undefined) continue;
        try {
          for (const s of [...this.sessions.values()]) {
            if (
              s.taskId === task.id &&
              s.role === slot.role &&
              s.model === slot.model &&
              (s.status === "starting" || s.status === "running" || s.status === "settled")
            ) {
              this.markSessionLost(
                s.sessionId,
                "session-key directory missing (reconcile)",
              );
            }
          }
          this.spawnCrewmate({
            taskId: task.id,
            role: castEntry.role,
            model: castEntry.model,
            thinking: castEntry.thinking,
            cleanRoom: castEntry.cleanRoom,
            vars: {},
          });
          respawned.push({ taskId: task.id, role: slot.role, model: slot.model });
        } catch (error) {
          // A failed respawn must not abort boot-time rehydrate or sibling slots.
          const message = error instanceof Error ? error.message : String(error);
          const summary = `session-key reconcile failed to respawn ${slot.role}/${slot.model} for task ${task.id}: ${message}`;
          this.sink({
            type: "captain.escalation",
            payload: {
              taskId: task.id,
              summary,
              severity: "warn",
            },
          });
          process.stderr.write(`[agentos] ${summary}\n`);
        }
      }
    }
    return respawned;
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

    // Orchestration tools blocked in BRAIN_DOWN except read_* and Captain REST.
    if (
      this.brainDown &&
      tool !== "read_fleet_state" &&
      tool !== "read_task" &&
      tool !== "read_policy" &&
      tool !== "read_run_artifacts" &&
      tool !== "notify_captain"
    ) {
      // Captain REST may still create_task / resolve_delivery_block.
      if (tool !== "create_task" && tool !== "resolve_delivery_block") {
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
      // Bad tool input is the caller's error, not an internal fault — the Brain
      // needs a path-precise VALIDATION_ERROR it can act on.
      if (error instanceof ZodError) {
        return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
          ok: false,
          error: err("VALIDATION_ERROR", `invalid input for ${tool}`, {
            issues: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          }),
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
        return this.answerCrewmate(raw);
      case "deliver_task":
        return this.deliverTask(raw);
      case "resolve_delivery_block":
        return this.resolveDeliveryBlock(raw);
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
      deliveryBlocked: null,
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
    this.requireTask(input.taskId);
    // Halt → release → stamp happens inside transition for terminal phases.
    return this.transition(this.requireTask(input.taskId), "CANCELLED", input.reason);
  }

  /**
   * Reclaim worktree slots for a session and/or task. No finalSha so the pool
   * verified-resets clean trees and quarantines dirty ones. Task-linked
   * quarantine stamps deliveryBlocked on the owning task.
   */
  private releaseWorktreeLeases(filter: {
    sessionId?: string;
    taskId?: string | null;
    /** When true, skip leases whose session is still live (running/settled). */
    onlyHaltedSessions?: boolean;
  }): void {
    for (const lease of this.deps.worktrees.list()) {
      if (lease.state !== "leased" && lease.state !== "reclaiming") continue;
      const sessionMatch =
        filter.sessionId !== undefined && lease.sessionId === filter.sessionId;
      const taskMatch =
        filter.taskId !== undefined &&
        filter.taskId !== null &&
        lease.taskId === filter.taskId;
      if (!sessionMatch && !taskMatch) continue;
      if (filter.onlyHaltedSessions === true && lease.sessionId !== null) {
        const session = this.sessions.get(lease.sessionId);
        if (
          session !== undefined &&
          session.status !== "stopped" &&
          session.status !== "lost"
        ) {
          continue;
        }
      }
      this.releaseOneWorktreeLease(lease.id);
    }
  }

  /**
   * Boot/reconcile: release leases whose session is gone. Uses the shared
   * release helper so dirty quarantine stamps deliveryBlocked on the task.
   */
  reclaimOrphanedLeases(isLiveSession: (sessionId: string | null) => boolean): number {
    let reclaimed = 0;
    for (const lease of this.deps.worktrees.list()) {
      if (lease.state !== "leased" && lease.state !== "reclaiming") continue;
      if (isLiveSession(lease.sessionId)) continue;
      this.releaseOneWorktreeLease(lease.id);
      reclaimed += 1;
    }
    return reclaimed;
  }

  /**
   * Release a single lease. When the tree quarantines and was task-linked,
   * stamp deliveryBlocked on the owning task so deliver_task cannot mark DONE
   * after the lease association is cleared. Sole choke point for task-linked
   * quarantine stamps (stop, lost, reclaim, SCOUT audit, deliver dirty path).
   */
  private releaseOneWorktreeLease(
    leaseId: string,
    options: { forceQuarantine?: boolean; finalSha?: string } = {},
  ): void {
    const lease = this.deps.worktrees.list().find((l) => l.id === leaseId);
    if (lease === undefined) return;
    const owningTaskId = lease.taskId;
    const releasedPath = lease.path;
    let result;
    try {
      result = this.deps.worktrees.release(leaseId, {
        ...(options.forceQuarantine === true ? { forceQuarantine: true } : {}),
        ...(options.finalSha !== undefined ? { finalSha: options.finalSha } : {}),
      });
    } catch {
      // best-effort — do not block stop/lost/cancel on a reclaim race
      return;
    }
    // Only clear path refs when the tree returns to idle (verified-reset). Idle
    // trees may be re-issued; keeping refs would make DONE cleanliness checks
    // judge a path owned by a different task. Quarantined trees stay associated
    // so deliver_task can still refuse against the preserved dirty path after
    // Captain clears deliveryBlocked.
    if (result.state === "idle") {
      this.clearWorktreePathRefs(releasedPath);
    }
    if (result.state !== "quarantined" || owningTaskId === null) return;
    const task = this.tasks.get(owningTaskId);
    if (task === undefined || isTerminalPhase(task.phase)) return;
    if (task.deliveryBlocked !== null) return;
    const dirtyPaths = this.readDirtyPaths(result.path);
    const reason =
      result.quarantineReason ??
      "worktree quarantined on release; uncommitted builder work preserved";
    this.blockDelivery(task, leaseId, reason, dirtyPaths);
  }

  /**
   * When a lease is released, clear task.worktreePath / session.worktreePath that
   * still point at that path. Prevents idle reuse from leaving non-terminal tasks
   * associated with a tree owned by a different lease/task.
   */
  private clearWorktreePathRefs(worktreePath: string): void {
    const target = resolve(worktreePath);
    for (const [sessionId, session] of this.sessions) {
      if (session.worktreePath === null) continue;
      if (resolve(session.worktreePath) !== target) continue;
      this.sessions.set(sessionId, { ...session, worktreePath: null });
    }
    for (const task of this.tasks.values()) {
      if (isTerminalPhase(task.phase)) {
        // Terminal tasks keep historical paths for audit; they no longer drive
        // delivery cleanliness against live pool state.
        continue;
      }
      let changed = false;
      let worktreePathField = task.worktreePath;
      if (worktreePathField !== null && resolve(worktreePathField) === target) {
        worktreePathField = null;
        changed = true;
      }
      const sessions = task.sessions.map((s) => {
        if (s.worktreePath === null || resolve(s.worktreePath) !== target) return s;
        changed = true;
        return { ...s, worktreePath: null };
      });
      if (!changed) continue;
      this.saveTask({
        ...task,
        worktreePath: worktreePathField,
        sessions,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private readDirtyPaths(worktreePath: string): string[] {
    if (process.env.AGENTOS_FAKE_GIT === "1") return [];
    const dirty = spawnSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (dirty.error !== undefined || dirty.status !== 0) return [];
    return dirty.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim() || line);
  }

  private readTask(raw: Record<string, unknown>): TaskSnapshot {
    const input = readTaskInputSchema.parse(raw);
    return this.requireTask(input.taskId);
  }

  private readRunArtifacts(raw: Record<string, unknown>): {
    taskId: string;
    path: string;
    files: string[];
  } {
    const input = readTaskInputSchema.parse(raw);
    const dir = join(this.deps.home, "runs", input.taskId);
    return { taskId: input.taskId, path: dir, files: listFilesRecursive(dir) };
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

    const nextBase = {
      ...task,
      cast,
      policyOverrides,
      updatedAt: new Date().toISOString(),
    };
    this.saveTask(nextBase);
    let next = nextBase;
    if (task.phase === "QUEUED") {
      next = this.transition(nextBase, "DISPATCH_RESOLVED", "cast resolved");
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
    if (isTerminalPhase(task.phase)) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `task ${task.id} is terminal (${task.phase}); cannot spawn`,
      );
    }
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
    let leaseId: string | null = null;
    let sessionSocketOpened = false;
    let cwd: string;

    const poolRoles = new Set(["builder", "scout", "planner", "fusion", "healthcheck"]);
    if (input.role === "validator") {
      cwd = this.deps.gates.gateWorkspace(task.id);
      worktreePath = cwd;
    } else if (input.role === "brain") {
      cwd = this.deps.home;
      worktreePath = null;
    } else if (poolRoles.has(input.role)) {
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
        leaseId = lease.id;
        cwd = lease.path;
      } catch (error) {
        if (error instanceof Error && error.message.includes("exhausted")) {
          task = this.transition(task, "WAITING_WORKTREE", error.message);
          throw new ToolSurfaceError("CONFLICT", error.message);
        }
        if (
          error instanceof Error &&
          (error.message.includes("git worktree add failed") ||
            error.message.includes("git worktree branch"))
        ) {
          throw new ToolSurfaceError("SPAWN_FAILED", error.message);
        }
        throw error;
      }
    } else {
      throw new ToolSurfaceError(
        "SPAWN_FAILED",
        `role ${input.role} has no isolated cwd; refusing to spawn in the primary checkout`,
      );
    }

    if (cwd === project.path) {
      throw new ToolSurfaceError(
        "SPAWN_FAILED",
        `refusing to spawn ${input.role} in the Captain's primary checkout`,
      );
    }

    // Per-model session key: a model change yields a new directory so transcripts
    // never cross families. buildPiSpawnSpec hands it to Pi via --session-dir +
    // PI_CODING_AGENT_SESSION_DIR; AGENTOS_SESSION_DIR is extension output only.
    const sessionDir = this.deps.sessionKeys.ensure({
      projectId: task.projectId,
      role: input.role,
      model: input.model,
    }).dir;
    this.sessionDirs.set(sessionId, sessionDir);

    try {
      const fake = this.deps.fakePi === true || process.env.AGENTOS_FAKE_PI === "1";

      let tmuxWindow = `agentos:${windowName}`;
      if (fake) {
        // Deterministic side output so fusion gates can assert artifacts without
        // a paid model. Per-session path matches the real extension layout so
        // sequential runs never share a file. Stay alive so pane-liveness
        // reconcile does not spuriously SESSION_LOST on short-lived echo.
        const outputsDir = join(sessionDir, "outputs");
        mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(outputsDir, `${sessionId}.md`),
          `fake-pi ${input.role} ${input.model} session=${sessionId}\n`,
          { mode: 0o600 },
        );
        this.deps.tmux.newWindow({
          windowName,
          argv: [
            "sh",
            "-c",
            `echo fake-pi ${input.role} ${sessionId}; exec sleep 86400`,
          ],
          cwd,
        });
      } else {
        if (this.deps.pi?.binary == null) {
          throw new ToolSurfaceError(
            "PI_UNAVAILABLE",
            "Pi is not installed — run onboarding to install the pinned Pi before spawning crewmates",
          );
        }
        if (
          this.deps.extensionPath === undefined ||
          !existsSync(this.deps.extensionPath)
        ) {
          throw new ToolSurfaceError(
            "PI_UNAVAILABLE",
            "agent-os Pi extension is unavailable — refusing to spawn a crewmate without telemetry",
          );
        }
        // Control channel is a hard precondition of spawn — never launch Pi with a dead socket.
        let socketPath: string;
        try {
          if (this.deps.sockets !== undefined) {
            socketPath = this.deps.sockets.openSession(sessionId);
            sessionSocketOpened = true;
          } else {
            socketPath = join(this.deps.home, "sockets", `${sessionId}.sock`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ToolSurfaceError(
            "SPAWN_FAILED",
            `session control channel failed to open: ${message}`,
          );
        }

        const prompt =
          input.prompt ??
          `Agent OS role=${input.role}. Task: ${task.title}\n\n${task.intent}`;
        const grant = resolveProviderKeyGrant(
          this.deps.home,
          input.model,
          this.deps.connections,
        );
        const spec = buildPiSpawnSpec({
          agentosHome: this.deps.home,
          detection: this.deps.pi,
          args: ["--mode", "json", "-p", prompt, "--model", input.model],
          cwd,
          sessionId,
          role: input.role,
          socketPath,
          extensionPath: this.deps.extensionPath,
          sessionDir,
          cleanRoom: input.cleanRoom,
          grantProviderKey: grant,
        });
        const win = this.deps.tmux.newWindow({
          windowName,
          argv: [spec.binary, ...spec.args],
          env: spec.env,
          cwd,
        });
        tmuxWindow = win.target;
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
        status: "running",
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
        status: "running",
        worktreePath,
        startedAt: now,
      };
      this.sessions.set(sessionId, fleetSession);

      // task.worktreePath is the builder/delivery tree only — scout/planner/etc.
      // must not clobber the path run_gate(candidate) and deliver_task depend on.
      task = {
        ...task,
        sessions: [...task.sessions.filter((s) => s.sessionId !== sessionId), taskSession],
        worktreePath:
          input.role === "builder" && worktreePath !== null
            ? worktreePath
            : task.worktreePath,
        branch:
          input.role === "builder" && branch !== null ? branch : task.branch,
        updatedAt: now,
      };
      this.saveTask(task);

      if (input.role === "builder" && task.phase !== "BUILDING") {
        task = this.transition(task, "BUILDING", "builder spawned");
      } else if (input.role === "planner" && task.phase === "DISPATCH_RESOLVED") {
        task = this.transition(task, "PLANNING", "planner spawned");
      } else if (input.role === "validator" && task.phase === "DISPATCH_RESOLVED") {
        task = this.transition(task, "GATE_AUTHORING", "validator spawned");
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
      // Status stays "running" (historical harness contract); the wake is what
      // the Brain sees. Fusion sides finalize via completeFusionSide after the
      // dispatch path registers ownership.
      if (fake) {
        this.deps.watcher.classify({
          class: "AGENT_SETTLED",
          taskId: task.id,
          sessionId,
          summary: `${input.role} settled (fake pi)`,
        });
      }

      return { session: fleetSession, task: this.requireTask(task.id) };
    } catch (error) {
      this.sessionDirs.delete(sessionId);
      if (sessionSocketOpened) {
        void this.deps.sockets?.closeSession(sessionId).catch(() => undefined);
      }
      if (leaseId !== null) {
        this.releaseOneWorktreeLease(leaseId);
      }
      throw error;
    }
  }

  private stopCrewmate(raw: Record<string, unknown>): { sessionId: string } {
    const input = stopCrewmateInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    if (session.role === "scout") {
      this.auditScoutSession(input.sessionId);
    }
    // Finalize any in-flight fusion side before dropping ownership so a stop
    // cannot leave the run stranded on fusion.dispatched.
    this.completeFusionSide(input.sessionId);
    this.deps.tmux.killWindow(session.tmuxWindow);
    void this.deps.sockets?.closeSession(input.sessionId).catch(() => undefined);
    this.releaseWorktreeLeases({ sessionId: input.sessionId });
    this.clearFusionSession(input.sessionId);
    const now = new Date().toISOString();
    // Re-read after release so cleared worktreePath refs are not re-stamped.
    const released = this.sessions.get(input.sessionId) ?? session;
    this.sessions.set(input.sessionId, { ...released, status: "stopped" });
    if (session.taskId !== null) {
      const task = this.tasks.get(session.taskId);
      if (task !== undefined) {
        this.saveTask({
          ...task,
          sessions: task.sessions.map((s) =>
            s.sessionId === input.sessionId
              ? { ...s, status: "stopped", lastEventAt: now }
              : s,
          ),
          updatedAt: now,
        });
      }
    }
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

  /**
   * `/opinion`, `/fusion` and plan-fusion (master plan §6.3).
   *
   * The instruction is rendered ONCE from the layered prompt pack and handed to
   * every side byte-for-byte. That is the clean-room contract: each family
   * answers the same question in isolation, and `promptsIdentical` on the run
   * record is the durable proof — not a claim in a comment.
   */
  private dispatchFusion(raw: Record<string, unknown>): {
    runId: string;
    promptsIdentical: boolean;
    aggregatorFamily: string | null;
    contractOk?: boolean;
    spawned: boolean;
  } {
    const input = dispatchFusionInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    const policies = this.cfg().policies;

    // Family is always derived from model server-side. Client-supplied
    // cast.family is ignored for policy and durable records so mislabels
    // cannot bypass cross-family invariants.
    const casts = input.casts.map((cast) => ({
      ...cast,
      family: familyFromModel(cast.model),
    }));

    // Cross-family invariants: an opinion or a plan-fusion whose sides all
    // share a family is not a second opinion, it is an echo.
    const families = new Set(casts.map((c) => c.family));
    if (input.kind === "plan-fusion" && policies.distinctPlannerFamilies && families.size < 2) {
      throw new ToolSurfaceError("POLICY_VIOLATION", "plan-fusion requires ≥2 distinct families");
    }
    if (input.kind === "opinion" && casts.length >= 2 && families.size < 2) {
      throw new ToolSurfaceError(
        "POLICY_VIOLATION",
        "/opinion requires ≥2 distinct model families — a same-family panel is not an independent opinion",
        { families: [...families] },
      );
    }

    // Default spawn policy by kind (§6.3): opinion / plan-fusion spawn clean-room
    // sides; fusion with a completed artifact is a contract check only.
    const spawnSides =
      input.spawnSides ?? (input.kind === "opinion" || input.kind === "plan-fusion");

    const runId = nextUlid();
    const project = this.deps.projects.get(task.projectId);

    // Render the instruction from the layered prompt pack when a ref is given.
    const templateRef =
      input.instructionTemplateRef ??
      (input.instruction === undefined ? DEFAULT_FUSION_TEMPLATES[input.kind] : undefined);
    let instruction = input.instruction ?? "";
    let templateInfo: PromptTemplateInfo | null = null;
    let renderedHash: string | null = null;

    if (templateRef !== undefined && this.deps.prompts !== undefined) {
      const vars: Record<string, string> = {
        TASK_TITLE: task.title,
        TASK_INTENT: task.intent,
        QUESTION: input.vars.QUESTION ?? task.title,
        CONTEXT: input.vars.CONTEXT ?? task.intent,
        ...input.vars,
      };
      try {
        const rendered = this.deps.prompts.render(
          templateRef,
          vars,
          project?.trusted === true ? join(project.path, ".agentos", "prompts") : undefined,
        );
        instruction = rendered.rendered;
        templateInfo = rendered.info;
        renderedHash = rendered.renderedHash;
      } catch (error) {
        // An undefined {{VAR}} or a missing ref is the caller's error, stated
        // precisely — never a half-rendered instruction sent to a model.
        throw new ToolSurfaceError(
          "VALIDATION_ERROR",
          error instanceof Error ? error.message : String(error),
          { templateRef },
        );
      }
    }
    if (instruction.length === 0) {
      instruction = `Fusion kind=${input.kind} for ${task.title}\n`;
    }
    const instructionHash = sha256(instruction);

    // Every side receives the SAME rendered bytes.
    const sides: FusionSide[] = casts.map((cast) => ({
      role: cast.role,
      model: cast.model,
      family: cast.family,
      sessionId: null,
      promptHash: instructionHash,
      artifactPath: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }));
    const promptsIdentical = new Set(sides.map((s) => s.promptHash)).size === 1;

    // Aggregator family retention: the fusion agent runs on the ARCHITECT
    // side's family — the first planner in the cast — and that choice is
    // recorded on the run rather than silently made.
    const architect = casts.find((c) => c.role === "planner") ?? casts[0];
    const aggregatorFamily = architect?.family ?? null;

    let contractOk: boolean | null = null;
    if (input.kind === "fusion" && input.instruction !== undefined) {
      const contract = enforceFusionContract(input.instruction);
      contractOk = contract.ok;
      if (!contract.ok) {
        throw new ToolSurfaceError(
          "FUSION_CONTRACT",
          `fusion artifact contract failed: ${contract.errors.join("; ")}`,
          { errors: contract.errors },
        );
      }
    }

    const run: FusionRun = {
      runId,
      taskId: task.id,
      kind: input.kind,
      templateRef: templateInfo?.ref ?? templateRef ?? null,
      templateLayer: templateInfo?.layer ?? null,
      templateHash: templateInfo?.contentHash ?? null,
      renderedHash,
      promptsIdentical,
      sides,
      aggregatorFamily,
      contractOk,
      createdAt: new Date().toISOString(),
    };
    this.deps.fusionRuns.create(run);
    this.deps.fusionRuns.writeInstruction(task.id, runId, instruction);
    if (input.kind === "fusion" && input.instruction !== undefined) {
      this.deps.fusionRuns.writeFused(task.id, runId, input.instruction);
    }

    this.sink({
      type: "fusion.dispatched",
      payload: { taskId: task.id, kind: input.kind, runId },
    });

    // Spawn one clean-room Pi per side, each with the identical instruction and
    // its own per-model session key. side_completed / completed fire on settle.
    if (spawnSides) {
      const spawnedSessionIds: Array<string | null> = sides.map(() => null);
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i]!;
        const cast = casts[i]!;
        try {
          const result = this.spawnCrewmate({
            taskId: task.id,
            role: side.role,
            model: side.model,
            thinking: cast.thinking,
            cleanRoom: cast.cleanRoom,
            vars: {},
            prompt: instruction,
          });
          const sessionId = result.session.sessionId;
          spawnedSessionIds[i] = sessionId;
          this.fusionBySessionId.set(sessionId, {
            taskId: task.id,
            runId,
            sideIndex: i,
          });
          // Persist immediately so kill-9 mid-loop can hydrate ownership and
          // early ext.usage frames can attribute by sideIndex.
          const latest = this.deps.fusionRuns.get(task.id, runId) ?? run;
          const withSession = latest.sides.map((s, j) =>
            j === i ? { ...s, sessionId: s.sessionId ?? sessionId } : s,
          );
          this.deps.fusionRuns.save({ ...latest, sides: withSession });
          // Fake-Pi writes per-session output during spawn and never sends
          // agent_settled over the extension channel — finalize as soon as
          // ownership is registered. Real Pi finalizes via settle / session_end.
          if (this.deps.fakePi === true || process.env.AGENTOS_FAKE_PI === "1") {
            this.completeFusionSide(sessionId);
          }
        } catch (error) {
          // Partial spawn must not leave a durable in-flight run: stop any
          // already-spawned crewmates (pane/socket/lease), finalize sides,
          // complete the run with error, then rethrow the typed tool error.
          const message =
            error instanceof ToolSurfaceError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error);
          this.failRemainingFusionSides(
            task.id,
            runId,
            spawnedSessionIds,
            i,
            message,
          );
          throw error;
        }
      }
    } else {
      // Pure contract / bookkeeping dispatch — no sides to wait on.
      this.emitFusionCompleted(run);
      if (input.kind === "plan-fusion" && task.phase === "PLANNING") {
        this.transition(task, "PLAN_FUSED", "plan-fusion complete");
      }
    }

    return contractOk === null
      ? { runId, promptsIdentical, aggregatorFamily, spawned: spawnSides }
      : { runId, promptsIdentical, aggregatorFamily, contractOk, spawned: spawnSides };
  }

  /**
   * After a mid-cast spawn failure: stop already-spawned crewmates (pane,
   * socket, lease), capture any unfinished spawned sides, mark the rest
   * settled (no artifact), and emit fusion.completed with the failure so
   * Console never sits on "dispatched" while an orphan holds a pool slot.
   */
  private failRemainingFusionSides(
    taskId: string,
    runId: string,
    spawnedSessionIds: Array<string | null>,
    failedAtIndex: number,
    errorMessage: string,
  ): void {
    for (let i = 0; i < failedAtIndex; i++) {
      const sessionId = spawnedSessionIds[i];
      if (sessionId == null) continue;
      const live = this.sessions.get(sessionId);
      if (
        live === undefined ||
        live.status === "stopped" ||
        live.status === "lost"
      ) {
        continue;
      }
      try {
        this.stopCrewmate({
          sessionId,
          reason: `fusion spawn failed at side ${failedAtIndex}: ${errorMessage}`,
        });
      } catch {
        // Best-effort teardown; finalize below even if stop races.
      }
    }

    const latest = this.deps.fusionRuns.get(taskId, runId);
    if (latest === null) return;
    const now = new Date().toISOString();

    const sides = latest.sides.map((s, i) => {
      const sessionId = s.sessionId ?? spawnedSessionIds[i] ?? null;
      if (i < failedAtIndex) {
        if (s.settledAt != null || s.artifactPath !== null) {
          return { ...s, sessionId };
        }
        const content = sessionId !== null ? this.readSideOutput(sessionId) : null;
        const artifactPath =
          content === null
            ? null
            : this.deps.fusionRuns.writeSideArtifact(
                taskId,
                runId,
                i,
                s.model,
                content,
              );
        this.sink({
          type: "fusion.side_completed",
          payload: {
            taskId,
            runId,
            role: s.role,
            model: s.model,
            family: s.family,
            promptHash: s.promptHash,
            artifactPath,
          },
        });
        return { ...s, sessionId, artifactPath, settledAt: now };
      }
      return {
        ...s,
        sessionId,
        settledAt: s.settledAt ?? now,
      };
    });
    this.deps.fusionRuns.save({ ...latest, sides });

    this.clearFusionRunSessionState(runId, sides.map((s) => s.sessionId));
    const finalRun = this.deps.fusionRuns.get(taskId, runId);
    if (finalRun !== null) {
      this.emitFusionCompleted(finalRun, errorMessage);
    }
  }

  /**
   * Capture a fusion side's output when its session settles, emit
   * fusion.side_completed, and finish the run when every side is done.
   * The settled side's pane is killed and its worktree lease released so it
   * does not hold a pool slot. fusionBySessionId stays until the run
   * completes so late usage frames after agent_settled still attribute.
   */
  private completeFusionSide(sessionId: string, error?: string | null): void {
    const ref = this.fusionBySessionId.get(sessionId);
    if (ref === undefined) return;

    const run = this.deps.fusionRuns.get(ref.taskId, ref.runId);
    if (run === null) {
      this.fusionBySessionId.delete(sessionId);
      return;
    }

    const side = run.sides[ref.sideIndex];
    if (side === undefined) {
      this.fusionBySessionId.delete(sessionId);
      return;
    }
    if (side.settledAt != null || side.artifactPath !== null) {
      // Already recorded (e.g. double settle from agent_settled + session_end).
      this.tryCompleteFusionRun(ref.taskId, ref.runId, error);
      this.releaseSettledFusionCrewmate(sessionId);
      return;
    }

    const content = this.readSideOutput(sessionId);
    const artifactPath =
      content === null
        ? null
        : this.deps.fusionRuns.writeSideArtifact(
            ref.taskId,
            ref.runId,
            ref.sideIndex,
            side.model,
            content,
          );

    const settledAt = new Date().toISOString();
    const sides = run.sides.map((s, i) =>
      i === ref.sideIndex
        ? {
            ...s,
            sessionId: s.sessionId ?? sessionId,
            artifactPath,
            settledAt,
          }
        : s,
    );
    this.deps.fusionRuns.save({ ...run, sides });

    this.sink({
      type: "fusion.side_completed",
      payload: {
        taskId: ref.taskId,
        runId: ref.runId,
        role: side.role,
        model: side.model,
        family: side.family,
        promptHash: side.promptHash,
        artifactPath,
      },
    });

    this.tryCompleteFusionRun(ref.taskId, ref.runId, error);
    this.releaseSettledFusionCrewmate(sessionId);
  }

  /**
   * Stop a settled fusion side's pane and free its worktree lease without
   * dropping fusion ownership (that stays until the whole run completes).
   */
  private releaseSettledFusionCrewmate(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      // Artifact already captured; free the dir map even if the session row is gone.
      this.sessionDirs.delete(sessionId);
      return;
    }
    if (session.status === "stopped" || session.status === "lost") {
      this.sessionDirs.delete(sessionId);
      return;
    }

    try {
      this.deps.tmux.killWindow(session.tmuxWindow);
    } catch {
      // Pane may already be gone (real session_end / prior halt).
    }
    void this.deps.sockets?.closeSession(sessionId).catch(() => undefined);
    this.releaseWorktreeLeases({ sessionId });
    const now = new Date().toISOString();
    const released = this.sessions.get(sessionId) ?? session;
    this.sessions.set(sessionId, { ...released, status: "stopped" });
    // Artifact already read; drop the session-dir mapping so happy-path settle
    // does not retain unbounded sessionId→dir entries (fake-Pi has no session_end).
    this.sessionDirs.delete(sessionId);
    if (session.taskId !== null) {
      const task = this.tasks.get(session.taskId);
      if (task !== undefined) {
        this.saveTask({
          ...task,
          sessions: task.sessions.map((s) =>
            s.sessionId === sessionId
              ? { ...s, status: "stopped", lastEventAt: now }
              : s,
          ),
          updatedAt: now,
        });
      }
    }
    this.sink({
      type: "session.stopped",
      payload: {
        sessionId,
        taskId: session.taskId,
        reason: "fusion side settled",
      },
    });
  }

  /**
   * Read the extension-written side answer for this session only.
   * Path is `$SESSION_DIR/outputs/$sessionId.md` so sequential runs that share
   * a per-model session key never re-attribute a prior run's bytes.
   * Null / empty / whitespace-only reads are treated as no artifact.
   */
  private readSideOutput(sessionId: string): string | null {
    const sessionDir = this.sessionDirs.get(sessionId);
    if (sessionDir === undefined) return null;
    const outputPath = join(sessionDir, "outputs", `${sessionId}.md`);
    if (!existsSync(outputPath)) return null;
    try {
      const content = readFileSync(outputPath, "utf8");
      if (content.trim().length === 0) return null;
      return content;
    } catch {
      return null;
    }
  }

  private tryCompleteFusionRun(
    taskId: string,
    runId: string,
    error?: string | null,
  ): void {
    const run = this.deps.fusionRuns.get(taskId, runId);
    if (run === null) return;
    // A side is done when it has settled (possibly without an artifact) or,
    // for older records, when an artifact path was already written.
    if (!run.sides.every((s) => s.settledAt != null || s.artifactPath !== null)) {
      return;
    }

    // Drop ownership + session-dir maps for this run once every side is done
    // (fake-Pi never emits session_end, so clearFusionSession alone is not enough).
    this.clearFusionRunSessionState(
      runId,
      run.sides.map((s) => s.sessionId),
    );

    this.emitFusionCompleted(run, error);

    if (
      run.kind === "plan-fusion" &&
      (error == null || error.length === 0)
    ) {
      const task = this.tasks.get(taskId);
      if (task !== undefined && task.phase === "PLANNING") {
        this.transition(task, "PLAN_FUSED", "plan-fusion complete");
      }
    }
  }

  private emitFusionCompleted(run: FusionRun, error?: string | null): void {
    this.sink({
      type: "fusion.completed",
      payload: {
        taskId: run.taskId,
        runId: run.runId,
        kind: run.kind,
        promptsIdentical: run.promptsIdentical,
        aggregatorFamily: run.aggregatorFamily,
        contractOk: run.contractOk,
        ...(error != null && error.length > 0 ? { error } : {}),
      },
    });
  }

  /** Drop fusion ownership and session-dir entries for a finished/failed run. */
  private clearFusionRunSessionState(
    runId: string,
    sessionIds: Array<string | null | undefined>,
  ): void {
    for (const [sid, ref] of this.fusionBySessionId) {
      if (ref.runId === runId) {
        this.fusionBySessionId.delete(sid);
        this.sessionDirs.delete(sid);
      }
    }
    for (const sessionId of sessionIds) {
      if (sessionId == null) continue;
      this.fusionBySessionId.delete(sessionId);
      this.sessionDirs.delete(sessionId);
    }
  }

  private clearFusionSession(sessionId: string): void {
    this.fusionBySessionId.delete(sessionId);
    this.sessionDirs.delete(sessionId);
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
    let cwd: string;
    if (input.target === "baseline") {
      cwd = this.deps.gates.gateWorkspace(task.id);
    } else {
      // Candidate gates never run in the Captain's primary checkout — same
      // isolation rule as spawn_crewmate.
      const builderPath = this.resolveBuilderWorktreePath(task);
      if (builderPath === null) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `run_gate(candidate) requires an isolated builder worktree for task ${task.id}; none is associated`,
        );
      }
      if (project !== null && resolve(builderPath) === resolve(project.path)) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `run_gate(candidate) refusing Captain's primary checkout for task ${task.id}`,
        );
      }
      cwd = builderPath;
    }

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
    // Prefer the live extension inject path when the session socket is up;
    // fall back to tmux send-keys for panes whose control channel has dropped.
    let sent =
      this.deps.sockets?.sendControl(input.sessionId, {
        type: "ctl.injectMessage",
        sessionId: input.sessionId,
        message,
        ts: new Date().toISOString(),
      }) ?? false;
    if (!sent) {
      try {
        this.deps.tmux.sendKeys(session.tmuxWindow, message);
        sent = true;
      } catch {
        sent = false;
      }
    }
    if (!sent) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `no live channel to session ${input.sessionId} — message not delivered`,
      );
    }
    return { sent };
  }

  /** Record a blocking question a crewmate asked over its extension socket. */
  recordQuestion(input: {
    questionId: string;
    sessionId: string;
    question: string;
  }): PendingQuestion {
    const session = this.sessions.get(input.sessionId);
    const pending: PendingQuestion = {
      questionId: input.questionId,
      sessionId: input.sessionId,
      taskId: session?.taskId ?? null,
      question: input.question,
      askedAt: new Date().toISOString(),
    };
    this.questions.set(input.questionId, pending);
    this.sink({
      type: "crew.question",
      payload: {
        questionId: pending.questionId,
        sessionId: pending.sessionId,
        taskId: pending.taskId,
        question: pending.question,
      },
    });
    this.deps.watcher.classify({
      class: "NEEDS_INPUT",
      taskId: pending.taskId,
      sessionId: pending.sessionId,
      summary: pending.question.slice(0, 500),
    });
    return pending;
  }

  listQuestions(): PendingQuestion[] {
    return [...this.questions.values()];
  }

  /**
   * Route an answer back to the exact session that asked. Delivered over the
   * session's control socket; falls back to `send-keys` for a human-attached
   * pane whose extension channel has dropped.
   */
  private answerCrewmate(raw: Record<string, unknown>): {
    questionId: string;
    sessionId: string;
    delivered: boolean;
  } {
    const input = answerCrewmateInputSchema.parse(raw);
    const pending = this.questions.get(input.questionId);
    if (pending === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `question not found: ${input.questionId}`);
    }
    const session = this.sessions.get(pending.sessionId);
    if (session === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${pending.sessionId}`);
    }

    let delivered =
      this.deps.sockets?.sendControl(pending.sessionId, {
        type: "ctl.injectMessage",
        sessionId: pending.sessionId,
        message: input.answer,
        ts: new Date().toISOString(),
      }) ?? false;
    if (!delivered) {
      try {
        this.deps.tmux.sendKeys(session.tmuxWindow, input.answer);
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    if (!delivered) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `no live channel to session ${pending.sessionId} — answer not delivered`,
      );
    }

    this.questions.delete(input.questionId);
    this.sink({
      type: "crew.answered",
      payload: {
        questionId: input.questionId,
        sessionId: pending.sessionId,
        delivered: true,
      },
    });
    return { questionId: input.questionId, sessionId: pending.sessionId, delivered: true };
  }

  /**
   * SCOUT sessions are read-only by policy. Enforcement is an audit of the real
   * worktree: any tracked modification or untracked file quarantines the lease
   * and escalates. Only a successful empty porcelain status is clean — git
   * failure or a missing .git on a real lease fails closed. Called when a
   * scout session settles or is stopped.
   */
  auditScoutSession(sessionId: string): { clean: boolean; changedPaths: string[] } {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.role !== "scout") {
      return { clean: true, changedPaths: [] };
    }
    if (!this.cfg().policies.scoutReadOnly) {
      return { clean: true, changedPaths: [] };
    }
    const path = session.worktreePath;
    if (path === null) {
      return { clean: true, changedPaths: [] };
    }

    // Fake-git marker trees are not auditable via git; real leases must have .git.
    if (process.env.AGENTOS_FAKE_GIT === "1") {
      return { clean: true, changedPaths: [] };
    }
    if (!existsSync(join(path, ".git"))) {
      return this.failScoutAudit(
        session,
        sessionId,
        path,
        ["(audit could not be performed: worktree is not a git repository)"],
        `SCOUT ${sessionId} worktree is not a git repository — write policy could not be verified`,
      );
    }

    const status = spawnSync("git", ["-C", path, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (status.error !== undefined || status.status !== 0) {
      const detail = (
        status.error?.message ||
        status.stderr ||
        status.stdout ||
        `exit ${String(status.status)}`
      )
        .toString()
        .trim();
      return this.failScoutAudit(
        session,
        sessionId,
        path,
        [`(audit could not be performed: git status failed: ${detail})`],
        `SCOUT ${sessionId} git status failed — write policy could not be verified: ${detail}`,
      );
    }

    const changedPaths = status.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (changedPaths.length === 0) {
      return { clean: true, changedPaths: [] };
    }

    return this.failScoutAudit(
      session,
      sessionId,
      path,
      changedPaths,
      `SCOUT ${sessionId} wrote ${changedPaths.length} path(s) in a read-only worktree`,
    );
  }

  private failScoutAudit(
    session: FleetSession,
    sessionId: string,
    path: string,
    changedPaths: string[],
    summary: string,
  ): { clean: boolean; changedPaths: string[] } {
    let quarantined = false;
    for (const lease of this.deps.worktrees.list().filter((l) => l.sessionId === sessionId)) {
      this.releaseOneWorktreeLease(lease.id, { forceQuarantine: true });
      quarantined = true;
    }
    this.sink({
      type: "scout.write_violation",
      payload: {
        sessionId,
        taskId: session.taskId ?? sessionId,
        worktreePath: path,
        changedPaths,
        quarantined,
      },
    });
    if (session.taskId !== null) {
      this.invoke("escalate_to_captain", {
        taskId: session.taskId,
        summary,
        severity: "critical",
      });
    }
    return { clean: false, changedPaths };
  }

  /**
   * Halt every live session for a task: scout audit, kill tmux window, close
   * session socket, persist status stopped. Does not release worktree leases —
   * callers release next (with finalSha on successful deliver, or plain release
   * on cancel / abort).
   */
  private haltTaskSessions(taskId: string, reason: string): void {
    const live = [...this.sessions.values()].filter(
      (s) =>
        s.taskId === taskId && s.status !== "stopped" && s.status !== "lost",
    );
    for (const session of live) {
      try {
        if (session.role === "scout") {
          this.auditScoutSession(session.sessionId);
        }
        this.deps.tmux.killWindow(session.tmuxWindow);
        void this.deps.sockets?.closeSession(session.sessionId).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot halt task ${taskId}: session ${session.sessionId} is still live and could not be stopped (${message})`,
        );
      }
      if (this.deps.tmux.hasWindow(session.tmuxWindow)) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot halt task ${taskId}: session ${session.sessionId} is still live (tmux window ${session.tmuxWindow} remains)`,
        );
      }
      const now = new Date().toISOString();
      const current = this.sessions.get(session.sessionId) ?? session;
      this.sessions.set(session.sessionId, { ...current, status: "stopped" });
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        this.saveTask({
          ...task,
          sessions: task.sessions.map((s) =>
            s.sessionId === session.sessionId
              ? { ...s, status: "stopped", lastEventAt: now }
              : s,
          ),
          updatedAt: now,
        });
      }
      this.sink({
        type: "session.stopped",
        payload: {
          sessionId: session.sessionId,
          taskId,
          reason,
        },
      });
    }
  }

  /**
   * Single choke point when a task leaves the live set: finalize in-flight
   * fusion sides, halt every session, then release every task-linked lease
   * (clean → verified-reset, dirty → quarantine + deliveryBlocked stamp).
   * Used by cancel/FAILED terminal paths and as the deliver abort reclaim.
   */
  private haltAndReleaseTask(taskId: string, reason: string): void {
    // Same completeFusionSide path as stop_crewmate / markSessionLost so
    // cancel_task / FAILED / DONE cannot strand runs on fusion.dispatched.
    // Pass reason so fusion.completed.error distinguishes abort from success.
    this.finalizeFusionSidesForTask(taskId, reason);
    this.haltTaskSessions(taskId, reason);
    this.releaseWorktreeLeases({ taskId });
  }

  /**
   * Settle every in-flight fusion side for a task via the shared
   * completeFusionSide helper (artifact capture, side_completed, and
   * fusion.completed when the last side settles). When `error` is set
   * (cancel / FAILED / DONE abort), it is attached to fusion.completed.
   */
  private finalizeFusionSidesForTask(
    taskId: string,
    error?: string | null,
  ): void {
    const ownedSessionIds = [
      ...new Set(
        [...this.fusionBySessionId.entries()]
          .filter(([, ref]) => ref.taskId === taskId)
          .map(([sessionId]) => sessionId),
      ),
    ];
    for (const sessionId of ownedSessionIds) {
      this.completeFusionSide(sessionId, error);
    }

    // Durable runs may still have unsettled sides that lost map ownership
    // (e.g. a prior halt path). Re-arm and settle so hydrate cannot re-arm
    // a run with no live settle path on the next boot.
    for (const run of this.deps.fusionRuns.listForTask(taskId)) {
      const sideCount = run.sides.length;
      for (let sideIndex = 0; sideIndex < sideCount; sideIndex++) {
        const latest = this.deps.fusionRuns.get(taskId, run.runId);
        if (latest === null) break;
        const side = latest.sides[sideIndex];
        if (side === undefined) continue;
        if (side.settledAt != null || side.artifactPath !== null) continue;
        if (side.sessionId === null) {
          const settledAt = new Date().toISOString();
          const sides = latest.sides.map((s, i) =>
            i === sideIndex ? { ...s, settledAt } : s,
          );
          this.deps.fusionRuns.save({ ...latest, sides });
          this.sink({
            type: "fusion.side_completed",
            payload: {
              taskId,
              runId: latest.runId,
              role: side.role,
              model: side.model,
              family: side.family,
              promptHash: side.promptHash,
              artifactPath: null,
            },
          });
          this.tryCompleteFusionRun(taskId, latest.runId, error);
          continue;
        }
        this.fusionBySessionId.set(side.sessionId, {
          taskId,
          runId: latest.runId,
          sideIndex,
        });
        this.completeFusionSide(side.sessionId, error);
      }
    }
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

    // Sticky refuse before any side effects (DELIVERING transition / delivery.json).
    this.assertNotDeliveryBlocked(task);

    if (task.phase !== "DELIVERING") {
      task = this.transition(task, "DELIVERING", "deliver_task");
    }

    // After halt begins, abort must reclaim leases only for sessions already
    // stopped/lost. Never release a tree a live Pi still has as cwd (partial
    // halt failure); reconcile reclaims those once panes are gone.
    let deliveryComplete = false;
    try {
      this.haltTaskSessions(task.id, "deliver_task halt");
      task = this.requireTask(task.id);
      this.assertNotDeliveryBlocked(task);

      const branch = task.branch ?? `ao/${task.id.slice(0, 10).toLowerCase()}`;

      // Only verified-reset when porcelain is clean. Dirty trees quarantine and
      // surface CONFLICT so uncommitted builder work is never discarded on DONE.
      // delivery.json is written only after every lease clears the clean gate.
      for (const lease of this.deps.worktrees.list().filter((l) => l.taskId === task.id)) {
        if (process.env.AGENTOS_FAKE_GIT === "1") {
          this.releaseOneWorktreeLease(lease.id);
          continue;
        }

        const dirty = spawnSync("git", ["-C", lease.path, "status", "--porcelain"], {
          encoding: "utf8",
          timeout: 15_000,
        });
        if (dirty.error !== undefined || dirty.status !== 0) {
          const detail = (
            dirty.error?.message ||
            dirty.stderr ||
            dirty.stdout ||
            `git status exit ${String(dirty.status)}`
          )
            .toString()
            .trim();
          const reason = `worktree status failed (${detail}); quarantined`;
          this.blockDelivery(task, lease.id, reason, []);
          this.releaseOneWorktreeLease(lease.id, { forceQuarantine: true });
          throw new ToolSurfaceError(
            "CONFLICT",
            `cannot deliver task ${task.id}: ${reason}`,
          );
        }
        if (dirty.stdout.trim().length > 0) {
          const dirtyPaths = dirty.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => line.slice(3).trim() || line);
          const reason =
            "worktree has uncommitted changes; quarantined for Captain inspection";
          this.blockDelivery(task, lease.id, reason, dirtyPaths);
          this.releaseOneWorktreeLease(lease.id, { forceQuarantine: true });
          throw new ToolSurfaceError(
            "CONFLICT",
            `cannot deliver task ${task.id}: ${reason}`,
          );
        }

        let finalSha: string | undefined;
        const rev = spawnSync("git", ["-C", lease.path, "rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: 15_000,
        });
        if (rev.status === 0) {
          const sha = rev.stdout.trim();
          if (sha.length > 0) finalSha = sha;
        }
        this.releaseOneWorktreeLease(
          lease.id,
          finalSha !== undefined ? { finalSha } : {},
        );
      }

      // Single choke point before durable delivery marker / DONE.
      task = this.requireTask(task.id);
      this.assertDoneInvariant(task);

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

      // DONE is only written here; clear the stamp only after the invariant holds.
      // Sessions and leases are already halted/released — transition will no-op those steps.
      task = {
        ...this.transition(task, "DONE", "delivered", { allowDone: true }),
        branch,
        deliveryBlocked: null,
      };
      this.saveTask(task);
      deliveryComplete = true;
      return task;
    } finally {
      if (!deliveryComplete) {
        this.releaseWorktreeLeases({
          taskId: input.taskId,
          onlyHaltedSessions: true,
        });
      }
    }
  }

  /**
   * Captain-only (REST invoke): clear a sticky deliveryBlocked stamp. Never
   * runs as a side effect of phase moves. Emits an audit event with the reason.
   */
  private resolveDeliveryBlock(raw: Record<string, unknown>): TaskSnapshot {
    const input = resolveDeliveryBlockInputSchema.parse(raw);
    const task = this.requireTask(input.taskId);
    if (task.deliveryBlocked === null) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `task ${task.id} has no delivery block to resolve`,
      );
    }
    const previous = task.deliveryBlocked;
    const updated: TaskSnapshot = {
      ...task,
      deliveryBlocked: null,
      updatedAt: new Date().toISOString(),
    };
    this.saveTask(updated);
    this.sink({
      type: "task.delivery_block_resolved",
      payload: {
        taskId: task.id,
        reason: input.reason,
        previousLeaseId: previous.leaseId,
        previousReason: previous.reason,
        clearedBy: "captain",
      },
    });
    return updated;
  }

  /** Persist a sticky delivery refusal on the task (survives lease quarantine). */
  private blockDelivery(
    task: TaskSnapshot,
    leaseId: string,
    reason: string,
    dirtyPaths: string[],
  ): void {
    this.saveTask({
      ...task,
      deliveryBlocked: {
        leaseId,
        reason,
        dirtyPaths,
        blockedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  }

  private assertNotDeliveryBlocked(task: TaskSnapshot): void {
    if (task.deliveryBlocked === null) return;
    throw new ToolSurfaceError(
      "CONFLICT",
      `cannot deliver task ${task.id}: delivery blocked (${task.deliveryBlocked.reason}); Captain must resolve before delivery`,
      {
        leaseId: task.deliveryBlocked.leaseId,
        dirtyPaths: task.deliveryBlocked.dirtyPaths,
      },
    );
  }

  /**
   * Delivery invariant (single choke point): a task may only reach DONE via
   * deliver_task. Preconditions are re-derived from durable state at call time:
   * no unresolved deliveryBlocked, all leases released, and clean porcelain on
   * every worktree ever associated with the task. If cleanliness cannot be
   * proven, refuse.
   */
  private assertDoneInvariant(task: TaskSnapshot): void {
    this.assertNotDeliveryBlocked(task);
    const outstanding = this.deps.worktrees
      .list()
      .filter(
        (l) =>
          l.taskId === task.id &&
          (l.state === "leased" || l.state === "reclaiming"),
      );
    if (outstanding.length > 0) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `cannot mark task ${task.id} DONE: ${String(outstanding.length)} worktree lease(s) still held`,
      );
    }
    this.assertAssociatedWorktreesClean(task);
  }

  /**
   * Paths of worktrees ever associated with this task, from durable task state
   * and the lease pool (including quarantined leases whose taskId was cleared).
   */
  private associatedWorktreePaths(task: TaskSnapshot): string[] {
    const paths = new Set<string>();
    if (task.worktreePath !== null) paths.add(task.worktreePath);
    for (const s of task.sessions) {
      if (s.worktreePath !== null) paths.add(s.worktreePath);
    }
    for (const lease of this.deps.worktrees.list()) {
      if (lease.taskId === task.id) paths.add(lease.path);
    }
    if (task.deliveryBlocked !== null) {
      const blocked = this.deps.worktrees
        .list()
        .find((l) => l.id === task.deliveryBlocked!.leaseId);
      if (blocked !== undefined) paths.add(blocked.path);
    }
    return [...paths];
  }

  private assertAssociatedWorktreesClean(task: TaskSnapshot): void {
    if (process.env.AGENTOS_FAKE_GIT === "1") return;
    const gateWorkspace = join(this.deps.home, "runs", task.id, "gate-workspace");
    for (const path of this.associatedWorktreePaths(task)) {
      if (resolve(path) === resolve(gateWorkspace)) continue;
      if (!existsSync(path)) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot mark task ${task.id} DONE: associated worktree missing (${path}); cleanliness cannot be proven`,
        );
      }
      if (!existsSync(join(path, ".git"))) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot mark task ${task.id} DONE: associated worktree is not a git repo (${path})`,
        );
      }
      const dirty = spawnSync("git", ["-C", path, "status", "--porcelain"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      if (dirty.error !== undefined || dirty.status !== 0) {
        const detail = (
          dirty.error?.message ||
          dirty.stderr ||
          dirty.stdout ||
          `git status exit ${String(dirty.status)}`
        )
          .toString()
          .trim();
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot mark task ${task.id} DONE: cannot prove worktree clean (${path}): ${detail}`,
        );
      }
      if (dirty.stdout.trim().length > 0) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `cannot mark task ${task.id} DONE: associated worktree has uncommitted changes (${path})`,
        );
      }
    }
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
    const notesRoot = resolve(project.path, "docs", "notes");
    const full = resolve(project.path, rel);
    const notesPrefix = notesRoot.endsWith(sep) ? notesRoot : `${notesRoot}${sep}`;
    if (!full.startsWith(notesPrefix)) {
      throw new ToolSurfaceError("POLICY_VIOLATION", "stow_knowledge path must be under docs/notes/");
    }
    mkdirSync(notesRoot, { recursive: true });
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
    if (to === "DONE") {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `task ${task.id} may only reach DONE via deliver_task (clean tree, no deliveryBlocked, leases released)`,
      );
    }
    if (to === "CANCELLED") {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `task ${task.id} may only reach CANCELLED via cancel_task`,
      );
    }
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
    options: { allowDone?: boolean } = {},
  ): TaskSnapshot {
    const current = this.tasks.get(task.id) ?? task;
    const from = current.phase;
    // DONE is only reachable through deliver_task after assertDoneInvariant.
    if (to === "DONE" && options.allowDone !== true) {
      throw new ToolSurfaceError(
        "ILLEGAL_TRANSITION",
        `task ${task.id} may only reach DONE via deliver_task (clean tree, no deliveryBlocked, leases released)`,
      );
    }
    if (to === "DONE") {
      this.assertDoneInvariant(current);
    }
    assertTransition(task.id, from, to);
    // Terminal exit choke point: halt every live session, then release leases
    // (stamp deliveryBlocked on dirty quarantine). No-op when deliver_task
    // already halted/released for DONE.
    if (isTerminalPhase(to)) {
      this.haltAndReleaseTask(task.id, reason ?? `phase ${to}`);
    }
    // Phase-only delta on fresh store state (halt/release may have mutated
    // sessions, worktree refs, deliveryBlocked). deliveryBlocked is never
    // cleared here — only resolve_delivery_block or successful deliver_task.
    const base = this.tasks.get(task.id) ?? current;
    const updated: TaskSnapshot = {
      ...base,
      phase: to,
      failureCause: to === "FAILED" ? (base.failureCause ?? "UNKNOWN") : base.failureCause,
      needsCaptainSummary:
        to === "NEEDS_CAPTAIN" ? (reason ?? base.needsCaptainSummary) : base.needsCaptainSummary,
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

  /** Record a session status reported by its extension (running → settled). */
  markSessionStatus(sessionId: string, status: FleetSession["status"]): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.set(sessionId, { ...session, status });
    const task = session.taskId !== null ? this.tasks.get(session.taskId) : undefined;
    if (task !== undefined) {
      this.saveTask({
        ...task,
        sessions: task.sessions.map((s) =>
          s.sessionId === sessionId
            ? { ...s, status, lastEventAt: new Date().toISOString() }
            : s,
        ),
        updatedAt: new Date().toISOString(),
      });
    }
    if (status === "settled" && session.role === "scout") {
      this.auditScoutSession(sessionId);
    }
    if (status === "settled") {
      this.completeFusionSide(sessionId);
    }
  }

  /** Mark a session lost (pane-died / reconcile). */
  markSessionLost(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.status === "lost" || session.status === "stopped") return;
    // Finalize any in-flight fusion side before dropping ownership so a
    // pane-lost side cannot leave the run stranded on fusion.dispatched.
    this.completeFusionSide(sessionId);
    // Kill a still-live pane so reconcile/respawn cannot share
    // AGENTOS_SESSION_DIR/outputs with an orphan process.
    const afterFusion = this.sessions.get(sessionId) ?? session;
    if (afterFusion.status !== "stopped" && afterFusion.status !== "lost") {
      try {
        this.deps.tmux.killWindow(afterFusion.tmuxWindow);
      } catch {
        // Pane may already be gone.
      }
    }
    void this.deps.sockets?.closeSession(sessionId).catch(() => undefined);
    this.releaseWorktreeLeases({ sessionId });
    const released = this.sessions.get(sessionId) ?? session;
    this.sessions.set(sessionId, { ...released, status: "lost" });
    this.clearFusionSession(sessionId);
    this.sink({
      type: "session.lost",
      payload: { sessionId, taskId: session.taskId, reason },
    });
    if (session.taskId !== null) {
      const task = this.tasks.get(session.taskId);
      if (task !== undefined) {
        const withSession: TaskSnapshot = {
          ...task,
          sessions: task.sessions.map((s) =>
            s.sessionId === sessionId
              ? { ...s, status: "lost", lastEventAt: new Date().toISOString() }
              : s,
          ),
          updatedAt: new Date().toISOString(),
        };
        this.saveTask(withSession);
        // Losing one cast side must not declare the whole task lost while
        // siblings are still healthy — only promote when nothing healthy remains.
        const healthyLeft = [...this.sessions.values()].some(
          (s) =>
            s.taskId === session.taskId &&
            (s.status === "starting" ||
              s.status === "running" ||
              s.status === "settled"),
        );
        if (
          !healthyLeft &&
          !isTerminalPhase(withSession.phase) &&
          withSession.phase !== "SESSION_LOST" &&
          canTransition(withSession.phase, "SESSION_LOST")
        ) {
          this.transition(withSession, "SESSION_LOST", reason);
        }
      }
    }
  }

  /**
   * Clean Pi exit (ext.lifecycle session_end): release the worktree lease so
   * settle-and-exit does not exhaust the pool. Reuses the shared release helper
   * (verified-reset when clean, quarantine + deliveryBlocked when dirty).
   * Also settles any fusion side still waiting on this session.
   */
  releaseSessionOnEnd(sessionId: string): void {
    // session_end without a prior agent_settled still finalizes fusion sides.
    this.completeFusionSide(sessionId);
    this.clearFusionSession(sessionId);
    this.releaseWorktreeLeases({ sessionId });
  }

  /**
   * Builder/delivery worktree for candidate gates. Prefer a live builder session
   * path, then task.worktreePath (builder-only field). Never the primary checkout.
   */
  private resolveBuilderWorktreePath(task: TaskSnapshot): string | null {
    const liveBuilders = [...this.sessions.values()].filter(
      (s) =>
        s.taskId === task.id &&
        s.role === "builder" &&
        s.worktreePath !== null &&
        s.status !== "stopped" &&
        s.status !== "lost",
    );
    if (liveBuilders.length > 0) {
      const path = liveBuilders[liveBuilders.length - 1]!.worktreePath;
      if (path !== null) return path;
    }
    if (task.worktreePath !== null) return task.worktreePath;
    const fromHistory = [...task.sessions]
      .reverse()
      .find((s) => s.role === "builder" && s.worktreePath !== null);
    return fromHistory?.worktreePath ?? null;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Repo-relative listing of everything durable under a run directory. */
function listFilesRecursive(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}
