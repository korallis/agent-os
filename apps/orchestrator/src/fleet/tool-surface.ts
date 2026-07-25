import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { monotonicFactory } from "ulid";
import { ZodError } from "zod";
import { spawnSync } from "node:child_process";
import JSON5 from "json5";
import { enforceFusionContract } from "@agent-os/fusion-core";
import {
  answerCrewmateInputSchema,
  authorGateInputSchema,
  cancelTaskInputSchema,
  createTaskInputSchema,
  deliverTaskInputSchema,
  dispatchFusionInputSchema,
  escalateToCaptainInputSchema,
  familiesConflict,
  notifyCaptainInputSchema,
  readPolicyInputSchema,
  suggestCastInputSchema,
  readTaskInputSchema,
  resolveCastInputSchema,
  resolveDeliveryBlockInputSchema,
  readSecondmateBearingsInputSchema,
  respawnCrewmateInputSchema,
  provisionSecondmateInputSchema,
  routeToSecondmateInputSchema,
  runGateInputSchema,
  sendToCrewInputSchema,
  spawnCrewmateInputSchema,
  stowKnowledgeInputSchema,
  stopCrewmateInputSchema,
  updateTaskInputSchema,
  advancePhaseInputSchema,
  brainToolNameSchema,
  secondmateCharterSchema,
  type AgentOsConfig,
  type BrainSnapshot,
  type BrainToolName,
  type DaemonControlFrame,
  type FleetSession,
  type FleetStateSnapshot,
  type FusionRun,
  type FusionSide,
  type PromptTemplateInfo,
  type SecondmateBearings,
  type OrchestratorEvent,
  type RoleCast,
  type TaskPhase,
  type TaskSession,
  type TaskSnapshot,
  type ToolError,
  type ToolErrorCode,
} from "@agent-os/protocol";
import type { QuotaSample } from "@agent-os/protocol";
import type { ConfigService } from "../config/service.js";
import type { ConnectionRegistry } from "../pi/connections.js";
import { resolveProviderKeyGrant } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { buildPiSpawnSpec } from "../pi/manager.js";
import { familyFromModel } from "../substrate/family.js";
import { buildCandidates, suggestCast, type BalancerSuggestion } from "./balancer.js";
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
import { GateRunner } from "./gate-runner.js";
import type { FusionRunStore } from "./fusion-runs.js";
import type { SecondmateRegistry } from "./secondmates.js";
import {
  SecondmateCapacityError,
  SecondmateHandoverError,
  type SecondmateFleet,
} from "./secondmate-fleet.js";
import type { PiAuthBroker } from "../pi/auth-broker.js";
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
 * Tools a non-Brain session may call over its own socket. Strictly self-scoped:
 * read own task/policy and report upward. Never `read_run_artifacts` — that
 * would let an /opinion side cross-read peer artifacts and break clean-room
 * independence. Everything that writes, moves the fleet, or reads run trees
 * is Brain-only (or Captain REST).
 */
const CREW_ALLOWED_TOOLS = new Set<BrainToolName>([
  "read_task",
  "read_policy",
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

/**
 * Durable secondmate handover intent/acceptance under runs/<taskId>/handover.json.
 *
 * Invariant: from the moment remote acceptance becomes possible until the primary
 * is durably terminal, exactly one durable record claims the task, it is
 * crash-safe (tmp+rename), and only a definite outcome may clear it. While any
 * record exists, retargeting to a different secondmate is refused — pending
 * claims as firmly as accepted (the remote may already own the work).
 * - pending: written before the remote POST; kept on ambiguous POST failure
 *   (timeout/network/200-without-id) so reconcile can re-drive with the remote
 *   idempotency key; cleared only on definite refusal (clean 4xx / capacity).
 * - accepted: written with remoteTaskId before primary CANCELLED; survives kill-9
 *   between those steps so reconcile can finish primary release.
 */
export type HandoverRecord = {
  taskId: string;
  secondmateName: string;
  domain: string;
  status: "pending" | "accepted";
  remoteTaskId: string | null;
  updatedAt: string;
};

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
  /** Phase 7 secondmate fleet: registry + routing/bearings operations. */
  secondmates?: { registry: SecondmateRegistry; fleet: SecondmateFleet };
  /** Shared Pi auth broker — every spawn grant goes through this choke point. */
  authBroker?: PiAuthBroker;
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
  /**
   * `/afk` autonomy posture. When present and armed, an escalation whose text
   * matches a Captain-recorded FAQ entry is answered from that entry instead of
   * parking the task. Absent (or unarmed) means every escalation waits, which
   * is the correct default.
   */
  afk?: AfkAutoAnswer;
  /** Live quota samples for balancer headroom ranking. */
  quotaSamples?: () => QuotaSample[];
  /** Whether reported cost covers every request — balancer refinement only. */
  costCoverage?: () => "complete" | "partial" | "absent";
}

/** The only thing the tool surface needs from `/afk` — testable in isolation. */
export interface AfkAutoAnswer {
  isActive(): boolean;
  tryAnswer(question: string): { answer: string; rationale: string } | null;
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
  private readonly questions = new Map<string, PendingQuestion>();
  private brainSessionId: string | null = null;
  private latestBearings: SecondmateBearings[] = [];
  /**
   * sessionId → fusion side ownership for O(1) usage attribution and settle
   * completion. Lifetime is owned by clearFusionRunSessionState only: entries
   * stay until the whole run completes so late ext.usage after agent_settled
   * or session_end still attributes while siblings are in flight.
   */
  private readonly fusionBySessionId = new Map<
    string,
    { taskId: string; runId: string; sideIndex: number }
  >();
  /** sessionId → SessionKeyStore directory for this spawn. */
  private readonly sessionDirs = new Map<string, string>();
  /**
   * Serializes create_task admission (capacity check + insert) on this home.
   * Depth detects re-entrant creates from event handlers during the exclusive
   * section; concurrent create_task calls cannot interleave mid-section because
   * the section is synchronous (no await).
   */
  private admissionDepth = 0;
  /**
   * Per-task exclusive claim for route_to_secondmate. Taken before the remote
   * POST so overlapping routes for one taskId cannot both hand work over.
   * Cleared in finally; terminal phase then blocks any later retry.
   */
  private readonly routingInProgress = new Set<string>();
  /** `${taskId}:${role}` → wedge respawns already consumed (ladder ledger). */
  private readonly wedgeRespawns = new Map<string, number>();
  /**
   * sessionIds whose wedge ladder has completed (emit + outcome, or Captain
   * notify sunk). Backed by task.wedgeLadderCompletedSessionIds so a restart
   * cannot re-open a finished escalate seat and re-arm a cleared obligation.
   */
  private readonly wedgeLadderCompleted = new Set<string>();
  /**
   * Hot activity stamps waiting for a coalesced durable write. lastActivityAt
   * stays current in memory; lastEventAt is flushed on reconcile / saveTask.
   */
  private readonly pendingActivityAt = new Map<string, string>();


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

  /**
   * True when the Captain stamped a cross-family override onto this task.
   * Overrides are evidence-stamped in `policyOverrides` — never implicit.
   */
  private hasFamilyOverride(task: TaskSnapshot): boolean {
    return task.policyOverrides.some((o) => o.policyId === "crossFamilyBuilderValidator");
  }

  /** True when the Captain stamped a red-baseline override onto this task. */
  private hasRedBaselineOverride(task: TaskSnapshot): boolean {
    return task.policyOverrides.some((o) => o.policyId === "redBaselineGateRequired");
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
    const gate = this.authorizeSessionTool(sessionId, tool);
    if (!gate.ok) return gate.result;
    return this.invoke(gate.name, input);
  }

  /** Async session entry — required for route_to_secondmate / read_secondmate_bearings. */
  async invokeFromSessionAsync(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const gate = this.authorizeSessionTool(sessionId, tool);
    if (!gate.ok) return gate.result;
    return this.invokeAsync(gate.name, input);
  }

  private authorizeSessionTool(
    sessionId: string,
    tool: string,
  ):
    | { ok: true; name: BrainToolName }
    | { ok: false; result: ToolCallResult } {
    const parsed = brainToolNameSchema.safeParse(tool);
    if (!parsed.success) {
      return {
        ok: false,
        result: {
          invocationId: nextUlid(),
          ok: false,
          error: err("VALIDATION_ERROR", `unknown tool: ${tool}`),
          durationMs: 0,
        },
      };
    }
    const name = parsed.data;
    if (CAPTAIN_ONLY_TOOLS.has(name)) {
      return {
        ok: false,
        result: {
          invocationId: nextUlid(),
          ok: false,
          error: err(
            "UNAUTHORIZED_TOOL",
            `${name} is Captain-only — not available over a session socket`,
          ),
          durationMs: 0,
        },
      };
    }
    const isBrain = this.brainSessionId !== null && sessionId === this.brainSessionId;
    if (!isBrain && !CREW_ALLOWED_TOOLS.has(name)) {
      return {
        ok: false,
        result: {
          invocationId: nextUlid(),
          ok: false,
          error: err(
            "UNAUTHORIZED_TOOL",
            `session ${sessionId} is not the Brain — ${name} is not available to crewmates`,
          ),
          durationMs: 0,
        },
      };
    }
    return { ok: true, name };
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
      secondmateBearings: this.latestBearings,
    };
  }

  /** Hydrate from durable task store (daemon boot). Rebuilds in-memory session rows. */
  hydrateTask(task: TaskSnapshot): void {
    const wedgeRespawnsByRole = task.wedgeRespawnsByRole ?? {};
    const wedgePendingCaptainNotifies = task.wedgePendingCaptainNotifies ?? [];
    const wedgeLadderCompletedSessionIds = task.wedgeLadderCompletedSessionIds ?? [];
    const pendingQuestions = task.pendingQuestions ?? [];
    const normalized: TaskSnapshot = {
      ...task,
      deliveryBlocked: task.deliveryBlocked ?? null,
      redProof: task.redProof ?? null,
      lastFailLedger: task.lastFailLedger ?? null,
      wedgeRespawnsByRole,
      wedgePendingCaptainNotifies,
      wedgeLadderCompletedSessionIds,
      pendingQuestions,
    };
    this.tasks.set(normalized.id, normalized);
    if (normalized.idempotencyKey !== null) {
      this.idempotency.set(normalized.idempotencyKey, normalized);
    }
    // Restore daemon-authoritative proof/ledger into process memory (HMAC-checked).
    if (normalized.redProof !== null) {
      this.deps.gates.installRedProof(normalized.id, normalized.redProof);
    }
    if (normalized.lastFailLedger !== null) {
      this.deps.gates.installFailLedger(normalized.id, normalized.lastFailLedger);
    }
    for (const [role, count] of Object.entries(wedgeRespawnsByRole)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        this.wedgeRespawns.set(`${normalized.id}:${role}`, count);
      }
    }
    for (const sessionId of wedgeLadderCompletedSessionIds) {
      this.wedgeLadderCompleted.add(sessionId);
    }
    // Replace this task's pending-questions view from durable snapshot so
    // wedge exemption and answer_crewmate survive daemon restart.
    for (const [questionId, q] of this.questions) {
      if (q.taskId === normalized.id) this.questions.delete(questionId);
    }
    for (const q of pendingQuestions) {
      this.questions.set(q.questionId, {
        questionId: q.questionId,
        sessionId: q.sessionId,
        taskId: normalized.id,
        question: q.question,
        askedAt: q.askedAt,
      });
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
        lastActivityAt: s.lastEventAt ?? null,
      };
      this.sessions.set(s.sessionId, fleetSession);
    }
  }

  /**
   * Rebuild RED proofs from the append-only event log (kill -9 path).
   * HMAC is verified against the daemon key — forged or re-signed-without-key
   * entries are rejected. Later valid events win.
   */
  hydrateRedProofFromEvent(payload: {
    taskId: string;
    gateSourceHash: string;
    outcome: "EXPECTED_RED" | "FAIL";
    provenAt: string;
    hmac: string;
  }): void {
    const proof = this.deps.gates.installRedProofFromEvent(payload.taskId, payload);
    if (proof === null) return;
    const task = this.tasks.get(payload.taskId);
    if (task === undefined) return;
    this.tasks.set(payload.taskId, {
      ...task,
      redProof: proof,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Rebuild fusion side ownership from durable run.json after a daemon restart.
   * Sides with a sessionId that have not yet settled remain in-flight so
   * settle/session_end can still write artifacts and emit fusion.completed.
   * Open runs are then reconciled via the shared finalize path so a kill-9
   * mid-dispatch (null sessionId), halt-without-settle (stopped/settled
   * without settledAt), missing pane, or all-settled-missing-completedAt
   * cannot leave a run permanently on fusion.dispatched.
   */
  hydrateFusionOwnership(): void {
    for (const task of this.tasks.values()) {
      for (const run of this.deps.fusionRuns.listForTask(task.id)) {
        if (run.completedAt != null) continue;
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

    // Boot counterpart of halt finalize: any side that can no longer make
    // progress on its own (never spawned, non-live status, missing pane),
    // plus all-settled-missing-completedAt. One shared helper so boot cannot
    // diverge from runtime.
    for (const task of this.tasks.values()) {
      for (const run of this.deps.fusionRuns.listForTask(task.id)) {
        if (run.completedAt != null) continue;
        const hasNeverSpawned = run.sides.some(
          (s) =>
            s.sessionId === null &&
            s.settledAt == null &&
            s.artifactPath === null,
        );
        this.finalizeOpenFusionRun(
          task.id,
          run.runId,
          hasNeverSpawned
            ? "fusion side never spawned (daemon interrupted mid-dispatch)"
            : undefined,
        );
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
   * Structural WEDGED detection and the respawn→escalate ladder
   * (master plan §11 Phase 3).
   *
   * A wedged seat is the nastiest failure mode the fleet has: its pane is
   * ALIVE, so every liveness check passes, but it has produced nothing for
   * longer than the configured stale window. Left alone it holds a worktree
   * lease and a cast slot forever while looking perfectly healthy — which is
   * exactly why it has to be said out loud rather than waited on.
   *
   * The ladder is deliberately shallow and evidence-stamped: respawn ONCE per
   * task+role (bounded by supervision.respawnPerStage), then escalate. A
   * substrate that respawns forever converts a wedged model into an infinite
   * spend, and the second wedge is far more likely to be the task than the seat.
   *
   * Respawn ledger + preflight (one policy):
   * - The ledger counts attempts that reached the destructive step (stop). It
   *   is spent before the attempt so a crash after stop cannot lose the spend,
   *   and rolled back only when the attempt demonstrably did not reach stop
   *   (in-process catch and restart incomplete-recovery share one helper).
   *   Once stop has happened the spend stands even if the subsequent spawn fails.
   * - If the task is already NEEDS_CAPTAIN, or the role cannot legally spawn
   *   in the current phase, do not stop the seat at all: escalate directly,
   *   spend nothing, and leave the live seat for the Captain to inspect.
   *   Destroying a seat to attempt a spawn the substrate will refuse both
   *   burns the role's only respawn and removes the evidence the Captain
   *   would have wanted to look at — so we never reach stop on a known-
   *   illegal spawn, and nothing is spent.
   *
   * Captain-notify durability (one invariant):
   * - Once the substrate has decided the Captain must be told — or is about to
   *   consume a seat on a path that may need the Captain — that obligation is
   *   recorded on the task (`wedgePendingCaptainNotifies`) before ledger spend
   *   and before stop. It survives seat state (stopped / lost / wedged / dead
   *   pane), process death and restart, and is discharged exactly once when
   *   `captain.escalation` is actually sunk. A successful respawn clears the
   *   provisional entry without escalate; failure discharges it; incomplete
   *   recovery (pre-stop crash) rolls the ledger back and clears without
   *   escalate. Seat shape is secondary to that.
   */
  reconcileWedgedSessions(now = Date.now()): Array<{ sessionId: string; action: string }> {
    // Coalesce hot activity stamps before idle checks so the durable clock
    // is approximately current without per-frame task.json writes.
    this.flushPendingActivity();

    // Discharge outstanding Captain-notify obligations first — independent of
    // any seat. Stopped / dead-pane / reopened-wedged seats never re-enter the
    // classify loop in a way that can complete notify; this pass is the only
    // path that can finish a pending obligation after restart or partial fail.
    this.dischargePendingWedgeCaptainNotifies();

    const supervision = this.deps.config.effective().config.supervision;
    const thresholdMinutes = supervision.staleMinutes.build;
    const respawnCap = supervision.respawnPerStage;
    const acted: Array<{ sessionId: string; action: string }> = [];

    for (const session of [...this.sessions.values()]) {
      // Re-admit durable-wedged seats that never finished the ladder (crash
      // between classify and outcome, or a notify that never sunk). Completion
      // is durable on the task so a successful discharge does not re-open after
      // restart; absence of completion + empty pending still re-enters so a
      // never-notified wedge escalates on the next boot (exactly-once).
      const reopened =
        session.status === "wedged" && !this.isWedgeLadderCompleted(session.sessionId);
      if (session.status !== "running" && session.status !== "starting" && !reopened) {
        continue;
      }
      // A missing pane on a live seat is SESSION_LOST, not wedged — that path
      // already exists and means something different to the Captain. Reopened
      // durable-wedged seats still need ladder completion (escalate-only) even
      // when the pane is gone; do not require a live window for that outcome.
      if (!reopened && !this.deps.tmux.hasWindow(session.tmuxWindow)) continue;

      if (
        !reopened &&
        [...this.questions.values()].some((q) => q.sessionId === session.sessionId)
      ) {
        continue;
      }

      const since = session.lastActivityAt ?? session.startedAt;
      const idleMs = now - Date.parse(since);
      if (!Number.isFinite(idleMs)) continue;
      const idleMinutes = idleMs / 60_000;
      // Already-classified (reopened) seats skip the idle gate — they need the
      // outcome half of the ladder completed, not a second silence wait.
      if (!reopened && idleMinutes < thresholdMinutes) continue;

      const used = this.getWedgeRespawns(session.taskId, session.role);
      const canRespawn = used < respawnCap;
      const task =
        session.taskId !== null ? (this.tasks.get(session.taskId) ?? null) : null;
      const spawnLegal =
        task !== null && this.canLegallySpawnForWedgeRespawn(task, session.role);

      // Pending notify already records the obligation; top-of-loop discharge
      // owns retries. Do not re-emit session.wedged or re-enter escalate.
      if (reopened) {
        const hasPending = (task?.wedgePendingCaptainNotifies ?? []).some(
          (n) => n.sessionId === session.sessionId,
        );
        if (hasPending) {
          continue;
        }
      }

      // In-memory only until the outcome is known — durable wedged before
      // respawn/escalate strands the seat if we crash mid-ladder (rehydrate
      // would skip running|starting-only candidates with an unspent ledger).
      // Reopened seats keep their durable wedged status; do not rewrite.
      if (!reopened) {
        this.sessions.set(session.sessionId, { ...session, status: "wedged" });
      }

      let action: "respawned" | "escalated";
      let escalateSummary: string | null = null;
      // Reopened durable-wedged seats already took the escalate branch (that is
      // the only path that persists status=wedged). Finish escalate-only —
      // never re-attempt respawn or re-wedge a terminal row.
      if (reopened) {
        action = "escalated";
        escalateSummary = `Seat ${session.role} wedged — completing deferred Captain notify (no activity for ${Math.round(idleMinutes)}m)`;
      } else if (canRespawn && spawnLegal) {
        // Write-ahead Captain-notify BEFORE ledger spend and stop so a crash
        // after stop cannot leave a spent budget with no obligation. Success
        // clears without escalate; failure/incomplete recovery discharges.
        escalateSummary = `Seat ${session.role} wedged and could not be respawned — no activity for ${Math.round(idleMinutes)}m`;
        if (session.taskId !== null) {
          this.recordPendingWedgeCaptainNotify(session.taskId, {
            sessionId: session.sessionId,
            role: session.role,
            summary: escalateSummary,
            severity: "critical",
            writeAheadRespawn: true,
            respawnsUsedBeforeAttempt: used,
          });
        }
        action = "escalated";
        let respawnLanded = false;
        try {
          this.setWedgeRespawns(session.taskId, session.role, used + 1);
          this.respawnCrewmate({
            sessionId: session.sessionId,
            reason: `structural WEDGED — no activity for ${Math.round(idleMinutes)}m (threshold ${thresholdMinutes}m)`,
          });
          respawnLanded = true;
        } catch {
          const current = this.sessions.get(session.sessionId) ?? session;
          // respawnCrewmate stops first; once status is stopped/lost the seat
          // was consumed even if spawn failed — spend stands. Leave those
          // terminal rows alone: rewriting them as wedged with a dead pane
          // strands a seat nothing reconsiders. Write-ahead pending already
          // records the Captain obligation and is discharged below.
          if (current.status !== "stopped" && current.status !== "lost") {
            this.rollbackWedgeRespawnSpend(session.taskId, session.role, used);
            this.persistSessionWedged(current);
          }
        }
        if (respawnLanded) {
          action = "respawned";
          // Drop the write-ahead without stamping replacementSessionId. Discharge
          // derives success from the live seat spawn already wrote into the task
          // snapshot; a separate bookkeeping stamp is not required for correctness.
          if (session.taskId !== null) {
            this.clearPendingWedgeCaptainNotify(session.taskId, session.sessionId);
          }
          escalateSummary = null;
        }
      } else if (canRespawn && !spawnLegal) {
        // Known-illegal spawn: never stop. Escalate with the seat still live.
        action = "escalated";
        const phase = task?.phase ?? "unknown";
        escalateSummary =
          task?.phase === "NEEDS_CAPTAIN"
            ? `Seat ${session.role} wedged while task is already NEEDS_CAPTAIN — leaving the seat live for the Captain (no activity for ${Math.round(idleMinutes)}m)`
            : `Seat ${session.role} wedged but cannot legally respawn in phase ${phase} — leaving the seat live for the Captain (no activity for ${Math.round(idleMinutes)}m)`;
        const current = this.sessions.get(session.sessionId) ?? session;
        this.persistSessionWedged(current);
      } else {
        // Cap consumed: the Captain decides, because a second wedge on the same
        // role is far more likely to be the task than the seat.
        action = "escalated";
        escalateSummary = `Seat ${session.role} wedged again after ${used} respawn${used === 1 ? "" : "s"} — no activity for ${Math.round(idleMinutes)}m. The task, not the model, is the likely cause.`;
        const current = this.sessions.get(session.sessionId) ?? session;
        this.persistSessionWedged(current);
      }

      // Evidence must agree with the durable ledger after the outcome (including
      // any rollback for a pre-stop failure).
      const respawnsUsed = this.getWedgeRespawns(session.taskId, session.role);
      // Captain-notify obligation is recorded BEFORE evidence emit / sink so a
      // throw or process death cannot leave the Captain uninformed. Cleared
      // only after captain.escalation is actually sunk.
      if (escalateSummary !== null && session.taskId !== null) {
        this.recordPendingWedgeCaptainNotify(session.taskId, {
          sessionId: session.sessionId,
          role: session.role,
          summary: escalateSummary,
          severity: "critical",
        });
      }
      this.emitSessionWedged(session, {
        idleMinutes,
        thresholdMinutes,
        respawnsUsed,
        respawnCap,
        action,
      });
      if (escalateSummary !== null) {
        if (session.taskId !== null) {
          const discharged = this.dischargePendingWedgeCaptainNotify(
            session.taskId,
            session.sessionId,
          );
          if (!discharged) {
            // Leave out of wedgeLadderCompleted so a later tick (or the top-of-
            // reconcile discharge pass) retries. Seat state is irrelevant.
            acted.push({ sessionId: session.sessionId, action });
            continue;
          }
        } else {
          const result = this.escalate(
            {
              taskId: undefined,
              summary: escalateSummary,
              severity: "critical",
            },
            { bypassAfk: true },
          );
          if (!result.sank) {
            acted.push({ sessionId: session.sessionId, action });
            continue;
          }
        }
      }
      // Only after a successful escalate (or a finished no-escalate respawn).
      // Mark durable so a restart cannot re-arm a cleared Captain-notify.
      this.markWedgeLadderCompleted(session.sessionId, session.taskId);
      acted.push({ sessionId: session.sessionId, action });
    }
    return acted;
  }

  /**
   * Whether a wedge respawn would clear the phase/role gates that spawnCrewmate
   * enforces. Used to preflight so we never stop a seat for a spawn we already
   * know the substrate will refuse.
   */
  private canLegallySpawnForWedgeRespawn(task: TaskSnapshot, role: string): boolean {
    if (isTerminalPhase(task.phase) || task.phase === "NEEDS_CAPTAIN") {
      return false;
    }
    if (role === "scout") {
      return canSpawnScout(task.phase);
    }
    if (role === "builder") {
      const enforceRedBaseline =
        this.cfg().policies.redBaselineGateRequired && !this.hasRedBaselineOverride(task);
      if (enforceRedBaseline && !this.deps.gates.hasRedProofForCurrentSource(task.id)) {
        return false;
      }
      return canSpawnBuilder(task.phase, { redBaselineRequired: enforceRedBaseline });
    }
    return true;
  }

  private getWedgeRespawns(taskId: string | null, role: string): number {
    const key = `${taskId ?? "none"}:${role}`;
    if (taskId !== null) {
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        const durable = task.wedgeRespawnsByRole?.[role];
        if (typeof durable === "number" && Number.isFinite(durable) && durable >= 0) {
          return durable;
        }
      }
    }
    return this.wedgeRespawns.get(key) ?? 0;
  }

  private setWedgeRespawns(taskId: string | null, role: string, count: number): void {
    const key = `${taskId ?? "none"}:${role}`;
    this.wedgeRespawns.set(key, count);
    if (taskId === null) return;
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    this.saveTask({
      ...task,
      wedgeRespawnsByRole: { ...(task.wedgeRespawnsByRole ?? {}), [role]: count },
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Restore the durable wedge-respawn ledger to the pre-attempt count.
   *
   * The ledger records ATTEMPTS THAT REACHED THE DESTRUCTIVE STEP. An attempt
   * that died before stopping anything cost nothing and must not be charged,
   * whether it died by exception or by process death. Those two are the same
   * event from the ledger's point of view — both the in-process catch path and
   * the restart incomplete-recovery path call this single helper so they cannot
   * drift.
   */
  private rollbackWedgeRespawnSpend(
    taskId: string | null,
    role: string,
    countBeforeSpend: number,
  ): void {
    this.setWedgeRespawns(taskId, role, countBeforeSpend);
  }

  private persistSessionWedged(session: FleetSession): void {
    this.pendingActivityAt.delete(session.sessionId);
    this.sessions.set(session.sessionId, { ...session, status: "wedged" });
    // Terminal wedge: drop unanswered questions for this seat (durable + memory).
    // The open-question exemption never reaches here while a question is live.
    this.clearPendingQuestionsForSession(session.sessionId);
    if (session.taskId === null) return;
    const task = this.tasks.get(session.taskId);
    if (task === undefined) return;
    const now = new Date().toISOString();
    this.saveTask({
      ...task,
      sessions: task.sessions.map((s) =>
        s.sessionId === session.sessionId ? { ...s, status: "wedged", lastEventAt: now } : s,
      ),
      updatedAt: now,
    });
  }

  /**
   * Drop unanswered questions for a seat that is stopped, lost, or terminally
   * wedged — both the process-local map and the durable task snapshot.
   * Does not run on the open-question wedge-exemption path (that seat stays live).
   * Prior crew.question events remain in the event stream as evidence the ask
   * happened; there is no separate "question died with seat" event type.
   */
  private clearPendingQuestionsForSession(sessionId: string): void {
    const doomed = [...this.questions.values()].filter((q) => q.sessionId === sessionId);
    if (doomed.length === 0) {
      // Still scrub durable rows that lost their memory entry (partial rehydrate).
      for (const task of [...this.tasks.values()]) {
        const pending = task.pendingQuestions ?? [];
        const remaining = pending.filter((q) => q.sessionId !== sessionId);
        if (remaining.length === pending.length) continue;
        this.saveTask({
          ...task,
          pendingQuestions: remaining,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    const taskIds = new Set<string>();
    for (const q of doomed) {
      this.questions.delete(q.questionId);
      if (q.taskId !== null) taskIds.add(q.taskId);
    }
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task === undefined) continue;
      const pending = task.pendingQuestions ?? [];
      const remaining = pending.filter((q) => q.sessionId !== sessionId);
      if (remaining.length === pending.length) continue;
      this.saveTask({
        ...task,
        pendingQuestions: remaining,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Durable record that the Captain must be told about this wedge outcome.
   * Idempotent per sessionId (latest summary wins). Survives seat mutation and
   * daemon restart until dischargePendingWedgeCaptainNotify clears it (or a
   * successful respawn clears the provisional entry without escalate).
   */
  private recordPendingWedgeCaptainNotify(
    taskId: string,
    entry: {
      sessionId: string;
      role: string;
      summary: string;
      severity: "info" | "warn" | "critical";
      replacementSessionId?: string;
      writeAheadRespawn?: boolean;
      respawnsUsedBeforeAttempt?: number;
    },
  ): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    const now = new Date().toISOString();
    const prior = (task.wedgePendingCaptainNotifies ?? []).filter(
      (n) => n.sessionId !== entry.sessionId,
    );
    this.saveTask({
      ...task,
      wedgePendingCaptainNotifies: [
        ...prior,
        {
          sessionId: entry.sessionId,
          role: entry.role,
          summary: entry.summary,
          severity: entry.severity,
          recordedAt: now,
          ...(entry.replacementSessionId !== undefined
            ? { replacementSessionId: entry.replacementSessionId }
            : {}),
          ...(entry.writeAheadRespawn !== undefined
            ? { writeAheadRespawn: entry.writeAheadRespawn }
            : {}),
          ...(entry.respawnsUsedBeforeAttempt !== undefined
            ? { respawnsUsedBeforeAttempt: entry.respawnsUsedBeforeAttempt }
            : {}),
        },
      ],
      updatedAt: now,
    });
  }

  /**
   * Drop a provisional Captain-notify without escalating. Used only when a
   * seat-consuming respawn fully succeeded so the write-ahead obligation is
   * no longer needed. Does not mark ladder completion (caller does that).
   */
  private clearPendingWedgeCaptainNotify(taskId: string, sessionId: string): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    const pending = task.wedgePendingCaptainNotifies ?? [];
    const remaining = pending.filter((n) => n.sessionId !== sessionId);
    if (remaining.length === pending.length) return;
    this.saveTask({
      ...task,
      wedgePendingCaptainNotifies: remaining,
      updatedAt: new Date().toISOString(),
    });
  }

  private isWedgeLadderCompleted(sessionId: string): boolean {
    return this.wedgeLadderCompleted.has(sessionId);
  }

  /**
   * Record ladder completion in memory and on the task snapshot so a restart
   * cannot re-open a finished seat and re-arm a cleared Captain-notify.
   */
  private markWedgeLadderCompleted(sessionId: string, taskId: string | null): void {
    this.wedgeLadderCompleted.add(sessionId);
    if (taskId === null) return;
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    const existing = task.wedgeLadderCompletedSessionIds ?? [];
    if (existing.includes(sessionId)) return;
    this.saveTask({
      ...task,
      wedgeLadderCompletedSessionIds: [...existing, sessionId],
      updatedAt: new Date().toISOString(),
    });
  }

  /** True when the exact session id is starting, running, or settled. */
  private isSessionLive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    return (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "settled"
    );
  }

  /**
   * Derive whether a wedge respawn already landed from durable session state.
   * Success = a live same-task same-role seat that is not the wedged session and
   * was created at/after the pending entry's recordedAt (spawn writes after the
   * write-ahead). Peers started earlier must not satisfy this.
   *
   * Optional replacementSessionId is only an optimisation: it may agree with
   * the derived seat, but derivation always wins when they disagree.
   */
  private findDerivedWedgeReplacement(
    taskId: string,
    entry: {
      sessionId: string;
      role: string;
      recordedAt: string;
      // exactOptionalPropertyTypes: optional keys may be present as undefined
      replacementSessionId?: string | undefined;
    },
  ): string | null {
    const recordedMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedMs)) return null;

    const candidates: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.taskId !== taskId) continue;
      if (session.role !== entry.role) continue;
      if (session.sessionId === entry.sessionId) continue;
      if (!this.isSessionLive(session.sessionId)) continue;
      const startMs = Date.parse(session.startedAt);
      if (!Number.isFinite(startMs) || startMs < recordedMs) continue;
      candidates.push(session.sessionId);
    }
    if (candidates.length === 0) return null;

    const stamped = entry.replacementSessionId;
    if (typeof stamped === "string" && stamped.length > 0 && candidates.includes(stamped)) {
      return stamped;
    }
    return candidates[0] ?? null;
  }

  private retirePendingWedgeCaptainNotify(taskId: string, sessionId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task === undefined) return false;
    const pending = task.wedgePendingCaptainNotifies ?? [];
    const remaining = pending.filter((n) => n.sessionId !== sessionId);
    if (remaining.length === pending.length) return false;
    const completed = task.wedgeLadderCompletedSessionIds ?? [];
    const needsCompleted = !completed.includes(sessionId);
    this.saveTask({
      ...task,
      wedgePendingCaptainNotifies: remaining,
      wedgeLadderCompletedSessionIds: needsCompleted ? [...completed, sessionId] : completed,
      updatedAt: new Date().toISOString(),
    });
    this.wedgeLadderCompleted.add(sessionId);
    return true;
  }

  /**
   * Sink captain.escalation for one pending entry and clear it only when the
   * escalation event was actually sunk (not AFK-auto-answered, not thrown).
   * Returns false when there was nothing to discharge, the sink did not land
   * (entry left in place for a later tick), or a provisional write-ahead was
   * dropped without completing the ladder.
   *
   * Successful respawn is derived from durable seat state (live same-role seat
   * created after the write-ahead), not from a follow-up replacementSessionId
   * stamp that may never land. A same-role peer started earlier never retires.
   */
  private dischargePendingWedgeCaptainNotify(taskId: string, sessionId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task === undefined) return false;
    const pending = task.wedgePendingCaptainNotifies ?? [];
    const entry = pending.find((n) => n.sessionId === sessionId);
    if (entry === undefined) return false;

    const derivedReplacement = this.findDerivedWedgeReplacement(taskId, entry);
    if (derivedReplacement !== null) {
      return this.retirePendingWedgeCaptainNotify(taskId, sessionId);
    }

    if (entry.writeAheadRespawn === true) {
      const original = this.sessions.get(sessionId);
      if (
        original !== undefined &&
        (original.status === "running" || original.status === "starting")
      ) {
        // Crash/incomplete before stop: attempt never reached the destructive
        // step — roll the ledger back (same helper as the in-process catch) and
        // drop the provisional write-ahead so the next classify can re-attempt.
        const before =
          typeof entry.respawnsUsedBeforeAttempt === "number" &&
          Number.isFinite(entry.respawnsUsedBeforeAttempt) &&
          entry.respawnsUsedBeforeAttempt >= 0
            ? entry.respawnsUsedBeforeAttempt
            : Math.max(0, this.getWedgeRespawns(taskId, entry.role) - 1);
        this.rollbackWedgeRespawnSpend(taskId, entry.role, before);
        this.clearPendingWedgeCaptainNotify(taskId, sessionId);
        return false;
      }
    }

    let sank = false;
    try {
      // Structural wedges must reach the Captain — never FAQ-auto-answer them.
      const result = this.escalate(
        {
          taskId,
          summary: entry.summary,
          severity: entry.severity,
        },
        { bypassAfk: true },
      );
      sank = result.sank;
    } catch {
      return false;
    }
    if (!sank) return false;
    // Re-read after escalate (may have rewritten the task) and clear this entry.
    const after = this.tasks.get(taskId);
    if (after === undefined) {
      this.wedgeLadderCompleted.add(sessionId);
      return true;
    }
    const remaining = (after.wedgePendingCaptainNotifies ?? []).filter(
      (n) => n.sessionId !== sessionId,
    );
    const completed = after.wedgeLadderCompletedSessionIds ?? [];
    const needsCompleted = !completed.includes(sessionId);
    if (
      remaining.length !== (after.wedgePendingCaptainNotifies ?? []).length ||
      needsCompleted
    ) {
      this.saveTask({
        ...after,
        wedgePendingCaptainNotifies: remaining,
        wedgeLadderCompletedSessionIds: needsCompleted
          ? [...completed, sessionId]
          : completed,
        updatedAt: new Date().toISOString(),
      });
    }
    this.wedgeLadderCompleted.add(sessionId);
    return true;
  }

  /**
   * Complete every outstanding wedge Captain-notify on every task, regardless
   * of seat status. Called at the top of reconcileWedgedSessions so stopped /
   * lost / dead-pane outcomes cannot strand the obligation.
   */
  private dischargePendingWedgeCaptainNotifies(): void {
    for (const task of [...this.tasks.values()]) {
      const pending = [...(task.wedgePendingCaptainNotifies ?? [])];
      for (const entry of pending) {
        this.dischargePendingWedgeCaptainNotify(task.id, entry.sessionId);
      }
    }
  }

  private emitSessionWedged(
    session: FleetSession,
    detail: {
      idleMinutes: number;
      thresholdMinutes: number;
      respawnsUsed: number;
      respawnCap: number;
      action: "respawned" | "escalated";
    },
  ): void {
    this.sink({
      type: "session.wedged",
      payload: {
        sessionId: session.sessionId,
        taskId: session.taskId,
        role: session.role,
        idleMinutes: Number(detail.idleMinutes.toFixed(2)),
        thresholdMinutes: detail.thresholdMinutes,
        respawnsUsed: detail.respawnsUsed,
        respawnCap: detail.respawnCap,
        action: detail.action,
      },
    });
  }

  /**
   * Boot/restart reconcile for the session-key gate (master plan §6.5 / G6).
   *
   * For each non-terminal task that already has crewmate sessions, compare the
   * resolved cast against SessionKeyStore and respawn ONLY roles whose session
   * directory is absent — surviving dirs (and their live panes) are left alone.
   * Live sessions whose key dir vanished are marked lost before respawn so a
   * wiped directory cannot leave an orphan "running" row blocking the gate.
   *
   * When a PiAuthBroker is configured, use reconcileMissingCastRolesAsync so
   * every respawn takes the cross-process spawn-grant lock (grant resolution
   * refuses to run unlocked).
   */
  reconcileMissingCastRoles(): Array<{ taskId: string; role: string; model: string }> {
    if (this.deps.authBroker !== undefined) {
      throw new ToolSurfaceError(
        "INTERNAL",
        "reconcileMissingCastRoles requires reconcileMissingCastRolesAsync when PiAuthBroker is configured",
      );
    }
    return this.runMissingCastRoleReconcile((raw) => {
      this.spawnCrewmate(raw);
    });
  }

  /**
   * Same as reconcileMissingCastRoles, but each respawn runs under
   * PiAuthBroker.withSpawnGrant so boot/restart cannot bypass the choke point.
   */
  async reconcileMissingCastRolesAsync(): Promise<
    Array<{ taskId: string; role: string; model: string }>
  > {
    if (this.deps.authBroker === undefined) {
      return this.reconcileMissingCastRoles();
    }
    const broker = this.deps.authBroker;
    return this.runMissingCastRoleReconcileAsync(async (raw) => {
      await broker.withSpawnGrant(async () => {
        this.spawnCrewmate(raw);
      });
    });
  }

  private runMissingCastRoleReconcile(
    spawn: (raw: Record<string, unknown>) => void,
  ): Array<{ taskId: string; role: string; model: string }> {
    const respawned: Array<{ taskId: string; role: string; model: string }> = [];
    for (const slot of this.collectMissingCastSlots()) {
      try {
        this.markMissingCastSlotLost(slot);
        spawn({
          taskId: slot.taskId,
          role: slot.role,
          model: slot.model,
          thinking: slot.thinking,
          cleanRoom: slot.cleanRoom,
          vars: {},
        });
        respawned.push({ taskId: slot.taskId, role: slot.role, model: slot.model });
      } catch (error) {
        this.reportReconcileSpawnFailure(slot, error);
      }
    }
    return respawned;
  }

  private async runMissingCastRoleReconcileAsync(
    spawn: (raw: Record<string, unknown>) => Promise<void>,
  ): Promise<Array<{ taskId: string; role: string; model: string }>> {
    const respawned: Array<{ taskId: string; role: string; model: string }> = [];
    for (const slot of this.collectMissingCastSlots()) {
      try {
        this.markMissingCastSlotLost(slot);
        await spawn({
          taskId: slot.taskId,
          role: slot.role,
          model: slot.model,
          thinking: slot.thinking,
          cleanRoom: slot.cleanRoom,
          vars: {},
        });
        respawned.push({ taskId: slot.taskId, role: slot.role, model: slot.model });
      } catch (error) {
        this.reportReconcileSpawnFailure(slot, error);
      }
    }
    return respawned;
  }

  private collectMissingCastSlots(): Array<{
    taskId: string;
    role: string;
    model: string;
    thinking: RoleCast["thinking"];
    cleanRoom: boolean;
  }> {
    const slots: Array<{
      taskId: string;
      role: string;
      model: string;
      thinking: RoleCast["thinking"];
      cleanRoom: boolean;
    }> = [];
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
        slots.push({
          taskId: task.id,
          role: castEntry.role,
          model: castEntry.model,
          thinking: castEntry.thinking,
          cleanRoom: castEntry.cleanRoom,
        });
      }
    }
    return slots;
  }

  private markMissingCastSlotLost(slot: {
    taskId: string;
    role: string;
    model: string;
  }): void {
    for (const s of [...this.sessions.values()]) {
      if (
        s.taskId === slot.taskId &&
        s.role === slot.role &&
        s.model === slot.model &&
        (s.status === "starting" || s.status === "running" || s.status === "settled")
      ) {
        this.markSessionLost(s.sessionId, "session-key directory missing (reconcile)");
      }
    }
  }

  private reportReconcileSpawnFailure(
    slot: { taskId: string; role: string; model: string },
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const summary = `session-key reconcile failed to respawn ${slot.role}/${slot.model} for task ${slot.taskId}: ${message}`;
    this.sink({
      type: "captain.escalation",
      payload: {
        taskId: slot.taskId,
        summary,
        severity: "warn",
      },
    });
    process.stderr.write(`[agentos] ${summary}\n`);
  }

  /**
   * Structural choke: when a broker is configured, provider grant resolution
   * may only run while this process holds the cross-process auth lock.
   */
  private assertSpawnGrantHeld(): void {
    if (this.deps.authBroker === undefined) return;
    if (!this.deps.authBroker.holdsAuthLock()) {
      throw new ToolSurfaceError(
        "INTERNAL",
        "provider grant resolution requires PiAuthBroker.withSpawnGrant (auth lock not held)",
      );
    }
  }

  invoke(
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    options: { idempotencyKey?: string } = {},
  ): ToolCallResult {
    if (
      tool === "route_to_secondmate" ||
      tool === "read_secondmate_bearings" ||
      tool === "provision_secondmate"
    ) {
      const started = Date.now();
      const invocationId = nextUlid();
      return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: false,
        error: err(
          "INTERNAL",
          `${tool} requires invokeAsync (I/O probe / remote handover / provision)`,
        ),
      });
    }
    // Spawn/fusion take the cross-process auth lock asynchronously when a
    // broker is configured — refuse the sync path so the event loop never
    // busy-waits under contention.
    if (
      this.deps.authBroker !== undefined &&
      (tool === "spawn_crewmate" ||
        tool === "respawn_crewmate" ||
        tool === "dispatch_fusion")
    ) {
      const started = Date.now();
      const invocationId = nextUlid();
      return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: false,
        error: err(
          "INTERNAL",
          `${tool} requires invokeAsync when PiAuthBroker is configured (async spawn grant)`,
        ),
      });
    }
    return this.finishInvoke(tool, rawInput, options, () => this.dispatch(tool, rawInput));
  }

  /**
   * Async tool entry for secondmate I/O and spawn-grant paths.
   * Sync tools are delegated to the same finish path.
   */
  async invokeAsync(
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    options: { idempotencyKey?: string } = {},
  ): Promise<ToolCallResult> {
    if (tool === "route_to_secondmate") {
      return this.finishInvokeAsync(tool, rawInput, options, () =>
        this.routeToSecondmate(rawInput),
      );
    }
    if (tool === "read_secondmate_bearings") {
      return this.finishInvokeAsync(tool, rawInput, options, () =>
        this.readSecondmateBearings(rawInput),
      );
    }
    if (tool === "provision_secondmate") {
      return this.finishInvokeAsync(tool, rawInput, options, async () =>
        this.provisionSecondmate(rawInput),
      );
    }
    if (tool === "spawn_crewmate") {
      return this.finishInvokeAsync(tool, rawInput, options, () =>
        this.spawnCrewmateAsync(rawInput),
      );
    }
    if (tool === "respawn_crewmate") {
      return this.finishInvokeAsync(tool, rawInput, options, () =>
        this.respawnCrewmateAsync(rawInput),
      );
    }
    if (tool === "dispatch_fusion") {
      return this.finishInvokeAsync(tool, rawInput, options, () =>
        this.dispatchFusionAsync(rawInput),
      );
    }
    return this.invoke(tool, rawInput, options);
  }

  private finishInvoke(
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    options: { idempotencyKey?: string },
    run: () => unknown,
  ): ToolCallResult {
    const started = Date.now();
    const invocationId = nextUlid();

    if (options.idempotencyKey !== undefined) {
      const cached = this.toolIdempotency.get(`${tool}:${options.idempotencyKey}`);
      if (cached !== undefined) return cached;
    }

    if (
      this.brainDown &&
      tool !== "read_fleet_state" &&
      tool !== "read_task" &&
      tool !== "read_policy" &&
      tool !== "read_run_artifacts" &&
      tool !== "notify_captain" &&
      tool !== "read_secondmate_bearings"
    ) {
      if (tool !== "create_task" && tool !== "resolve_delivery_block") {
        return this.finish(invocationId, tool, null, started, {
          ok: false,
          error: err("BRAIN_DOWN", "brain is down — orchestration tools are blocked"),
        });
      }
    }

    try {
      const data = run();
      const result = this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: true,
        data,
      });
      if (options.idempotencyKey !== undefined) {
        this.toolIdempotency.set(`${tool}:${options.idempotencyKey}`, result);
      }
      return result;
    } catch (error) {
      return this.mapInvokeError(invocationId, tool, rawInput, started, error);
    }
  }

  private async finishInvokeAsync(
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    options: { idempotencyKey?: string },
    run: () => Promise<unknown>,
  ): Promise<ToolCallResult> {
    const started = Date.now();
    const invocationId = nextUlid();

    if (options.idempotencyKey !== undefined) {
      const cached = this.toolIdempotency.get(`${tool}:${options.idempotencyKey}`);
      if (cached !== undefined) return cached;
    }

    if (
      this.brainDown &&
      tool !== "read_fleet_state" &&
      tool !== "read_task" &&
      tool !== "read_policy" &&
      tool !== "read_run_artifacts" &&
      tool !== "notify_captain" &&
      tool !== "read_secondmate_bearings"
    ) {
      if (tool !== "create_task" && tool !== "resolve_delivery_block") {
        return this.finish(invocationId, tool, null, started, {
          ok: false,
          error: err("BRAIN_DOWN", "brain is down — orchestration tools are blocked"),
        });
      }
    }

    try {
      const data = await run();
      const result = this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: true,
        data,
      });
      if (options.idempotencyKey !== undefined) {
        this.toolIdempotency.set(`${tool}:${options.idempotencyKey}`, result);
      }
      return result;
    } catch (error) {
      return this.mapInvokeError(invocationId, tool, rawInput, started, error);
    }
  }

  private mapInvokeError(
    invocationId: string,
    tool: BrainToolName,
    rawInput: Record<string, unknown>,
    started: number,
    error: unknown,
  ): ToolCallResult {
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
    if (error instanceof SecondmateHandoverError) {
      return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: false,
        error: err("CONFLICT", error.message, error.details),
      });
    }
    if (error instanceof SecondmateCapacityError) {
      return this.finish(invocationId, tool, extractTaskId(rawInput), started, {
        ok: false,
        error: err("POLICY_VIOLATION", error.message, error.details),
      });
    }
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
      case "read_secondmate_bearings":
      case "provision_secondmate":
        throw new ToolSurfaceError(
          "INTERNAL",
          `${tool} must be invoked via invokeAsync`,
        );
      case "stow_knowledge":
        return this.stowKnowledge(raw);
      case "suggest_cast":
        return this.suggestCastAdvisory(raw);
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

  /**
   * When this home is a secondmate (charter.json5 present), refuse create_task
   * once active+queued load reaches charter.maxConcurrentTasks. Primary homes
   * without a secondmate charter are uncapped here.
   */
  private assertLocalAdmissionCapacity(): void {
    const charterPath = join(this.deps.home, "config", "charter.json5");
    if (!existsSync(charterPath)) return;
    let cap: number;
    try {
      const parsed = secondmateCharterSchema.parse(
        JSON5.parse(readFileSync(charterPath, "utf8")),
      );
      cap = parsed.maxConcurrentTasks;
    } catch {
      // Malformed secondmate charter: fail closed on admission.
      throw new ToolSurfaceError(
        "CONFLICT",
        "secondmate charter is unreadable — cannot admit tasks",
      );
    }
    const load = this.admissionLoad();
    if (load >= cap) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `secondmate is at capacity (${load}/${cap} concurrent tasks)`,
        { load, cap },
      );
    }
  }

  /** Matches fleet summary active + queued for capacity admission. */
  private admissionLoad(): number {
    const activePhases = new Set<TaskPhase>([
      "BUILDING",
      "VALIDATING",
      "PLANNING",
      "GATE_AUTHORING",
      "DELIVERING",
      "PLAN_FUSED",
      "GATE_RED_VERIFIED",
      "DISPATCH_RESOLVED",
    ]);
    let load = 0;
    for (const task of this.listTasks()) {
      if (activePhases.has(task.phase) || task.phase === "QUEUED" || task.phase === "WAITING_WORKTREE") {
        load += 1;
      }
    }
    return load;
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
    const mode = input.spec.mode;

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
      redProof: null,
      lastFailLedger: null,
      wedgeRespawnsByRole: {},
      wedgePendingCaptainNotifies: [],
      wedgeLadderCompletedSessionIds: [],
      pendingQuestions: [],
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
      configSnapshotHash: hashConfig(this.cfg()),
      policyOverrides: [],
    };

    // Capacity check + insert share one exclusive section so concurrent creates
    // on this home cannot both pass the cap (see runAdmissionExclusive).
    this.runAdmissionExclusive(() => {
      this.assertLocalAdmissionCapacity();
      this.tasks.set(task.id, task);
      if (task.idempotencyKey !== null) {
        this.idempotency.set(task.idempotencyKey, task);
      }
      this.persistTask(task);
    });
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

  /**
   * Run capacity check + task insert atomically w.r.t. other creates on this
   * home. Synchronous: no await inside `fn`, so the event loop cannot interleave
   * another create mid-section. Re-entrant admission (nested create from a
   * sink/handler) is refused rather than racing the load count.
   */
  private runAdmissionExclusive<T>(fn: () => T): T {
    if (this.admissionDepth > 0) {
      throw new ToolSurfaceError(
        "CONFLICT",
        "task admission is already in progress on this home",
      );
    }
    this.admissionDepth += 1;
    try {
      return fn();
    } finally {
      this.admissionDepth -= 1;
    }
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

    // Cross-family builder ≠ validator. Route through familiesConflict so
    // unrecognised origins ("other") fail closed rather than comparing unequal
    // labels and looking independently validated.
    const builder = cast.find((c) => c.role === "builder");
    const validator = cast.find((c) => c.role === "validator");
    if (
      policies.crossFamilyBuilderValidator &&
      builder !== undefined &&
      validator !== undefined &&
      familiesConflict(builder.model, validator.model) &&
      !input.familyCheckOverride
    ) {
      throw new ToolSurfaceError(
        "POLICY_VIOLATION",
        `builder family (${builder.family}) must be a provably different known family from validator family (${validator.family})`,
        { builder: builder.model, validator: validator.model },
      );
    }

    // Distinct planner families for plan-fusion casts — same predicate: a pair
    // is independent only when familiesConflict is false (both known, different).
    const planners = cast.filter((c) => c.role === "planner");
    if (policies.distinctPlannerFamilies && planners.length >= 2 && !input.familyCheckOverride) {
      let hasDistinctPair = false;
      for (let i = 0; i < planners.length; i++) {
        for (let j = i + 1; j < planners.length; j++) {
          const a = planners[i];
          const b = planners[j];
          if (a !== undefined && b !== undefined && !familiesConflict(a.model, b.model)) {
            hasDistinctPair = true;
            break;
          }
        }
        if (hasDistinctPair) break;
      }
      if (!hasDistinctPair) {
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

  /**
   * Production spawn path: holds the cross-process auth lock for grant resolution
   * without busy-waiting the event loop.
   */
  private async spawnCrewmateAsync(raw: Record<string, unknown>): Promise<{
    session: FleetSession;
    task: TaskSnapshot;
  }> {
    if (this.deps.authBroker !== undefined) {
      return this.deps.authBroker.withSpawnGrant(async () => this.spawnCrewmate(raw));
    }
    return this.spawnCrewmate(raw);
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

    const redBaselineConfigured = this.cfg().policies.redBaselineGateRequired;
    if (input.role === "builder" && input.redBaselineOverride) {
      task = {
        ...task,
        policyOverrides: [
          ...task.policyOverrides,
          {
            policyId: "redBaselineGateRequired",
            configuredValue: "overridden",
            layer: "task",
            stampedAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      this.saveTask(task);
    }
    const enforceRedBaseline =
      redBaselineConfigured && !this.hasRedBaselineOverride(task);

    if (input.role === "builder") {
      if (enforceRedBaseline && !this.deps.gates.hasRedProofForCurrentSource(task.id)) {
        throw new ToolSurfaceError(
          "POLICY_VIOLATION",
          `cannot spawn builder: missing RED baseline proof for current gate source (EXPECTED_RED must be established before the builder starts)`,
          { taskId: task.id, phase: task.phase },
        );
      }
      if (!canSpawnBuilder(task.phase, { redBaselineRequired: enforceRedBaseline })) {
        throw new ToolSurfaceError(
          "ILLEGAL_TRANSITION",
          `cannot spawn builder in phase ${task.phase}`,
        );
      }
    }

    const family = familyFromModel(input.model);

    // Cross-family is a scheduler invariant, not a cast-time courtesy. Enforce
    // it again at spawn — server-derived from the model string — so a caller
    // that skips or reshapes resolve_cast cannot slip a same-family
    // builder/validator pair past the check (master plan §11 Phase 5:
    // "same-family builder/validator impossible via API, CLI, profile import,
    // recovery, AND Brain tool calls"). Uses familiesConflict so "other" fails
    // closed the same way resolve_cast does.
    if (this.cfg().policies.crossFamilyBuilderValidator && !this.hasFamilyOverride(task)) {
      const counterpartRole = input.role === "validator" ? "builder" : "validator";
      if (input.role === "validator" || input.role === "builder") {
        const counterparts: string[] = [];
        for (const cast of task.cast.filter((c) => c.role === counterpartRole)) {
          counterparts.push(cast.model);
        }
        for (const session of task.sessions.filter((s) => s.role === counterpartRole)) {
          counterparts.push(session.model);
        }
        for (const counterpart of counterparts) {
          if (familiesConflict(input.model, counterpart)) {
            throw new ToolSurfaceError(
              "POLICY_VIOLATION",
              `cannot spawn ${input.role} on family ${family}: conflicts with the task's ${counterpartRole} (same family or unrecognised origin)`,
              { role: input.role, family, counterpartRole, model: input.model, counterpart },
            );
          }
        }
      }
    }
    const sessionId = nextUlid();
    const windowName = `${input.role}-${sessionId.slice(0, 8).toLowerCase()}`;

    let worktreePath: string | null = null;
    let branch: string | null = task.branch;
    let leaseId: string | null = null;
    let sessionSocketOpened = false;
    let cwd: string;

    const poolRoles = new Set(["builder", "scout", "planner", "fusion", "healthcheck"]);
    if (input.role === "validator") {
      // Write-jail: a validator only ever sees the gate workspace, never the
      // product tree it is judging.
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
    // Preflight before ensure; remove a newly created key dir on launch failure
    // so missingRoles does not treat an orphan as "role present".
    const fake = this.deps.fakePi === true || process.env.AGENTOS_FAKE_PI === "1";
    const piDetection = this.deps.pi;
    const extensionPath = this.deps.extensionPath;
    const sessionKeyInput = {
      projectId: task.projectId,
      role: input.role,
      model: input.model,
    };
    let sessionKeyCreated = false;

    try {
      if (!fake) {
        if (piDetection?.binary == null) {
          throw new ToolSurfaceError(
            "PI_UNAVAILABLE",
            "Pi is not installed — run onboarding to install the pinned Pi before spawning crewmates",
          );
        }
        if (extensionPath === undefined || !existsSync(extensionPath)) {
          throw new ToolSurfaceError(
            "PI_UNAVAILABLE",
            "agent-os Pi extension is unavailable — refusing to spawn a crewmate without telemetry",
          );
        }
      }

      const sessionKeyExisted = this.deps.sessionKeys.has(sessionKeyInput);
      const sessionDir = this.deps.sessionKeys.ensure(sessionKeyInput).dir;
      sessionKeyCreated = !sessionKeyExisted;
      this.sessionDirs.set(sessionId, sessionDir);

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
        // Narrowed by preflight above; TypeScript cannot see the throw path.
        if (piDetection == null || extensionPath === undefined) {
          throw new ToolSurfaceError(
            "PI_UNAVAILABLE",
            "Pi detection or extension path missing after preflight",
          );
        }
        const gateWorkspace =
          input.role === "builder" || input.role === "validator"
            ? this.deps.gates.gateWorkspace(task.id)
            : undefined;
        // Seat allowlist root: builder = leased worktree; validator = gate workspace.
        const seatWorkspace =
          input.role === "builder" || input.role === "validator" ? cwd : undefined;
        const runSpawn = (): string => {
          // Structural choke: grant resolution is impossible without the lock
          // when a broker is configured (assertSpawnGrantHeld). Callers must
          // enter via withSpawnGrant — spawnCrewmateAsync, dispatchFusionAsync,
          // reconcileMissingCastRolesAsync — not a bare spawnCrewmate.
          this.assertSpawnGrantHeld();
          const grant = resolveProviderKeyGrant(
            this.deps.home,
            input.model,
            this.deps.connections,
          );
          const spec = buildPiSpawnSpec({
            agentosHome: this.deps.home,
            detection: piDetection,
            args: ["--mode", "json", "-p", prompt, "--model", input.model],
            cwd,
            sessionId,
            role: input.role,
            socketPath,
            extensionPath,
            sessionDir,
            thinking: input.thinking,
            cleanRoom: input.cleanRoom,
            grantProviderKey: grant,
            ...(gateWorkspace !== undefined ? { gateWorkspace } : {}),
            ...(seatWorkspace !== undefined ? { seatWorkspace } : {}),
          });
          const win = this.deps.tmux.newWindow({
            windowName,
            argv: [spec.binary, ...spec.args],
            env: spec.env,
            cwd,
          });
          return win.target;
        };
        tmuxWindow = runSpawn();
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
        lastActivityAt: null,
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
        task = this.transition(task, "BUILDING", "builder spawned", {
          redBaselineRequired: enforceRedBaseline ? true : false,
        });
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
      // A PROGRESS wake is classified first so the zero-token absorb path is
      // exercised end-to-end (same class a real extension lifecycle would emit).
      // Synthetic ext.usage mirrors a real provider frame so analytics and
      // Console gates can assert non-zero telemetry without a paid model.
      if (fake) {
        const slash = input.model.indexOf("/");
        const provider = slash === -1 ? "unknown" : input.model.slice(0, slash);
        const modelName = slash === -1 ? input.model : input.model.slice(slash + 1);
        this.sink({
          type: "ext.usage",
          payload: {
            sessionId,
            provider,
            model: modelName,
            inputTokens: 128,
            outputTokens: 64,
            costUsd: null,
          },
        });
        this.deps.watcher.classify({
          class: "PROGRESS",
          taskId: task.id,
          sessionId,
          summary: `progress on ${task.title}`,
        });
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
      if (sessionKeyCreated) {
        this.deps.sessionKeys.remove(sessionKeyInput);
      }
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
    this.pendingActivityAt.delete(input.sessionId);
    if (session.role === "scout") {
      this.auditScoutSession(input.sessionId);
    }
    // Finalize any in-flight fusion side so a stop cannot leave the run
    // stranded on fusion.dispatched. Pass reason so the last side's stop is
    // not reported as a clean fusion.completed success. Ownership stays until
    // the whole run completes (clearFusionRunSessionState). Suppress
    // releaseSettled's session.stopped — this method owns the single terminal
    // lifecycle event with the caller reason.
    this.completeFusionSide(input.sessionId, input.reason, {
      suppressStopEvent: true,
    });
    const afterFusion = this.sessions.get(input.sessionId) ?? session;
    if (afterFusion.status !== "stopped" && afterFusion.status !== "lost") {
      this.deps.tmux.killWindow(session.tmuxWindow);
      void this.deps.sockets?.closeSession(input.sessionId).catch(() => undefined);
      this.releaseWorktreeLeases({ sessionId: input.sessionId });
    }
    this.clearFusionSession(input.sessionId);
    const now = new Date().toISOString();
    // Re-read after release so cleared worktreePath refs are not re-stamped.
    const released = this.sessions.get(input.sessionId) ?? session;
    this.sessions.set(input.sessionId, { ...released, status: "stopped" });
    this.clearPendingQuestionsForSession(input.sessionId);
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

  private async respawnCrewmateAsync(raw: Record<string, unknown>): Promise<unknown> {
    const input = respawnCrewmateInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined || session.taskId === null) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    this.stopCrewmate({ sessionId: input.sessionId, reason: input.reason });
    return this.spawnCrewmateAsync({
      taskId: session.taskId,
      role: session.role,
      model: session.model,
      thinking: session.thinking,
      cleanRoom: true,
      vars: {},
    });
  }

  /**
   * Production fusion path: one cross-process spawn-grant window covers grant
   * resolution for every side (no event-loop busy-wait).
   */
  private async dispatchFusionAsync(raw: Record<string, unknown>): Promise<{
    runId: string;
    promptsIdentical: boolean;
    aggregatorFamily: string | null;
    contractOk?: boolean;
    spawned: boolean;
  }> {
    if (this.deps.authBroker !== undefined) {
      return this.deps.authBroker.withSpawnGrant(async () => this.dispatchFusion(raw));
    }
    return this.dispatchFusion(raw);
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
    // share a family is not a second opinion, it is an echo. Independence is
    // proved only by familiesConflict === false (both known, different) — a
    // Set of labels would still accept anthropic + other as "two families".
    const families = new Set(casts.map((c) => c.family));
    let hasDistinctPair = false;
    for (let i = 0; i < casts.length; i++) {
      for (let j = i + 1; j < casts.length; j++) {
        const a = casts[i];
        const b = casts[j];
        if (a !== undefined && b !== undefined && !familiesConflict(a.model, b.model)) {
          hasDistinctPair = true;
          break;
        }
      }
      if (hasDistinctPair) break;
    }
    if (input.kind === "plan-fusion" && policies.distinctPlannerFamilies && !hasDistinctPair) {
      throw new ToolSurfaceError("POLICY_VIOLATION", "plan-fusion requires ≥2 distinct families");
    }
    if (input.kind === "opinion" && casts.length >= 2 && !hasDistinctPair) {
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
      completedAt: null,
      error: null,
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
            // §6.3: /opinion and plan-fusion are always clean-room — ignore cast.
            cleanRoom:
              input.kind === "opinion" || input.kind === "plan-fusion"
                ? true
                : cast.cleanRoom,
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
   * socket, lease), then settle remaining sides and complete the run through
   * the shared finalize helper so Console never sits on "dispatched".
   */
  private failRemainingFusionSides(
    taskId: string,
    runId: string,
    spawnedSessionIds: Array<string | null>,
    failedAtIndex: number,
    errorMessage: string,
  ): void {
    const stopReason = `fusion spawn failed at side ${failedAtIndex}: ${errorMessage}`;
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
          reason: stopReason,
        });
      } catch {
        // Best-effort teardown; finalize below even if stop races.
      }
    }

    // Same lifecycle as halt/boot: never-spawned sides, remaining session
    // sides, tryComplete with the failure latched.
    this.finalizeOpenFusionRun(taskId, runId, errorMessage);
  }

  /**
   * Latch a non-empty failure reason onto the durable FusionRun. Reasons
   * accumulate (semicolon-separated, de-duplicated) so a clean last settle
   * cannot erase an earlier side stop/lost/abort.
   */
  private latchFusionError(
    taskId: string,
    runId: string,
    error?: string | null,
  ): FusionRun | null {
    const run = this.deps.fusionRuns.get(taskId, runId);
    if (run === null) return null;
    if (error == null || error.length === 0) return run;
    const existing = run.error ?? null;
    const next = mergeFusionErrors(existing, error);
    if (next === existing) return run;
    const updated: FusionRun = { ...run, error: next };
    this.deps.fusionRuns.save(updated);
    return updated;
  }

  /**
   * Capture a fusion side's output when its session settles, emit
   * fusion.side_completed, and finish the run when every side is done.
   * The settled side's pane is killed and its worktree lease released so it
   * does not hold a pool slot. fusionBySessionId stays until the run
   * completes so late usage frames after agent_settled still attribute.
   */
  private completeFusionSide(
    sessionId: string,
    error?: string | null,
    options: { suppressStopEvent?: boolean } = {},
  ): void {
    const ref = this.fusionBySessionId.get(sessionId);
    if (ref === undefined) return;

    // Latch immediately so a later clean settle cannot drop this reason.
    this.latchFusionError(ref.taskId, ref.runId, error);

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
      this.tryCompleteFusionRun(ref.taskId, ref.runId);
      this.releaseSettledFusionCrewmate(sessionId, options);
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

    this.tryCompleteFusionRun(ref.taskId, ref.runId);
    this.releaseSettledFusionCrewmate(sessionId, options);
  }

  /**
   * Stop a settled fusion side's pane and free its worktree lease without
   * dropping fusion ownership (that stays until the whole run completes).
   * When `suppressStopEvent` is set, the caller owns the single terminal
   * lifecycle event (stop_crewmate / markSessionLost).
   */
  private releaseSettledFusionCrewmate(
    sessionId: string,
    options: { suppressStopEvent?: boolean } = {},
  ): void {
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

    this.pendingActivityAt.delete(sessionId);
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
    if (options.suppressStopEvent !== true) {
      this.sink({
        type: "session.stopped",
        payload: {
          sessionId,
          taskId: session.taskId,
          reason: "fusion side settled",
        },
      });
    }
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
    // Latch any late reason before the all-sides check so order of settle
    // cannot drop a prior failure when the last side is clean.
    const run = this.latchFusionError(taskId, runId, error);
    if (run === null) return;
    if (run.completedAt != null) return;
    // A side is done when it has settled (possibly without an artifact) or,
    // for older records, when an artifact path was already written.
    if (!run.sides.every((s) => s.settledAt != null || s.artifactPath !== null)) {
      return;
    }

    // Sole owner of fusionBySessionId lifetime: drop only when every side is done.
    this.clearFusionRunSessionState(
      runId,
      run.sides.map((s) => s.sessionId),
    );

    this.emitFusionCompleted(run);

    const latchedError = this.deps.fusionRuns.get(taskId, runId)?.error ?? run.error;
    if (
      run.kind === "plan-fusion" &&
      (latchedError == null || latchedError.length === 0)
    ) {
      const task = this.tasks.get(taskId);
      if (task !== undefined && task.phase === "PLANNING") {
        this.transition(task, "PLAN_FUSED", "plan-fusion complete");
      }
    }
  }

  private emitFusionCompleted(run: FusionRun, error?: string | null): void {
    const latest =
      this.latchFusionError(run.taskId, run.runId, error) ??
      this.deps.fusionRuns.get(run.taskId, run.runId) ??
      run;
    if (latest.completedAt != null) return;
    const completedAt = new Date().toISOString();
    const durableError =
      latest.error != null && latest.error.length > 0 ? latest.error : null;
    this.deps.fusionRuns.save({
      ...latest,
      completedAt,
      error: durableError,
    });
    this.sink({
      type: "fusion.completed",
      payload: {
        taskId: latest.taskId,
        runId: latest.runId,
        kind: latest.kind,
        promptsIdentical: latest.promptsIdentical,
        aggregatorFamily: latest.aggregatorFamily,
        contractOk: latest.contractOk,
        ...(durableError != null ? { error: durableError } : {}),
      },
    });
  }

  /**
   * Drop fusion ownership and session-dir entries for a finished/failed run.
   * This is the only path that clears fusionBySessionId for a live run —
   * stop/lost/session_end must not drop ownership while siblings are in flight.
   */
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

  /**
   * Drop the session-dir mapping only. Fusion ownership is intentionally not
   * cleared here — that is clearFusionRunSessionState's job at run completion.
   */
  private clearFusionSession(sessionId: string): void {
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

      // A candidate verdict only means something if THIS revision of the gate
      // was proven red at baseline. Editing the gate drops the proof, so a
      // validator cannot weaken the gate after the fact and call the build
      // green (master plan §11 Phase 5: "gate revisions re-prove RED").
      // Captain-stamped redBaselineOverride disables the policy holistically
      // (spawn + candidate), not only the spawn half.
      const enforceRedBaseline =
        this.cfg().policies.redBaselineGateRequired &&
        !this.hasRedBaselineOverride(task);
      if (enforceRedBaseline && !this.deps.gates.hasRedProofForCurrentSource(task.id)) {
        throw new ToolSurfaceError(
          "GATE_ERROR",
          `gate revision has no RED baseline proof for task ${task.id} — re-run run_gate(baseline) before judging a candidate`,
          { gateSourceHash: this.deps.gates.gateSourceHash(task.id) },
        );
      }
    }

    const enforceRedBaselineForRun =
      this.cfg().policies.redBaselineGateRequired &&
      !this.hasRedBaselineOverride(task);
    const result = this.deps.gates.run({
      taskId: task.id,
      target: input.target,
      cwd,
      expectedRed: enforceRedBaselineForRun,
    });

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

    // Stamp daemon-owned proof/ledger onto the durable task record.
    // Emit gate.red_proven before task.json so kill -9 can rebuild from the log.
    const proof = this.deps.gates.getRedProof(task.id);
    const ledger = this.deps.gates.getFailLedger(task.id);
    if (
      input.target === "baseline" &&
      (result.outcome === "EXPECTED_RED" || result.outcome === "FAIL") &&
      proof !== null
    ) {
      // HMAC travels with the event so hydrate can verify — never re-sign.
      this.sink({
        type: "gate.red_proven",
        payload: {
          taskId: task.id,
          gateSourceHash: proof.gateSourceHash,
          outcome: proof.outcome,
          provenAt: proof.provenAt,
          hmac: proof.hmac,
        },
      });
    }
    if (proof !== null || ledger !== null) {
      task = {
        ...task,
        redProof: proof ?? task.redProof,
        lastFailLedger: ledger ?? task.lastFailLedger,
        updatedAt: new Date().toISOString(),
      };
      this.saveTask(task);
    }

    if (input.target === "baseline") {
      if (result.outcome === "EXPECTED_RED" || result.outcome === "FAIL") {
        // Mid-build re-prove stays in BUILDING/VALIDATING so the rebuild loop
        // can continue after the daemon records a fresh RED proof. First-time
        // proof advances into GATE_RED_VERIFIED.
        if (task.phase !== "BUILDING" && task.phase !== "VALIDATING") {
          task = this.transition(task, "GATE_RED_VERIFIED", "baseline red proven");
        }
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
          lastFailLedger: ledger ?? task.lastFailLedger,
          updatedAt: new Date().toISOString(),
        };
        this.saveTask(task);
        if (attempt >= task.maxValidations) {
          task = this.transition(task, "VALIDATION_EXHAUSTED", "max validations reached");
        } else {
          task = this.transition(task, "BUILDING", "gate fail — rebuild");
        }
      } else {
        // GATE_ERROR is not RED: an infrastructure failure must not burn a
        // validation attempt or advance the task toward exhaustion.
        throw new ToolSurfaceError(
          "GATE_ERROR",
          `candidate gate error (infrastructure, not a RED verdict): ${result.stderr}`,
          { infrastructureError: result.infrastructureError },
        );
      }
    }

    return {
      outcome: result.outcome,
      outputHash: result.outputHash,
      failLines: result.failLines,
    };
  }

  private sendToCrew(raw: Record<string, unknown>): { sent: boolean; failHash?: string } {
    const input = sendToCrewInputSchema.parse(raw);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    let message = input.message ?? "";
    let failHash: string | undefined;
    if (input.gateFailRef !== undefined) {
      // Verbatim FAIL injection. Substrate injects the ledger's exact bytes and
      // compares to the stored hash — no split/trim/filter reconstruction.
      const taskId = session.taskId;
      if (taskId === null) {
        throw new ToolSurfaceError(
          "GATE_ERROR",
          "verbatim FAIL hash unavailable — refusing to inject unverifiable gate output",
        );
      }
      const ledger = this.deps.gates.getFailLedger(taskId);
      if (ledger === null || ledger.text.length === 0) {
        throw new ToolSurfaceError("NOT_FOUND", "no gate fail lines held for verbatim inject");
      }
      if (ledger.hash.length === 0) {
        throw new ToolSurfaceError(
          "GATE_ERROR",
          "verbatim FAIL hash missing — refusing to inject unverifiable gate output",
          { taskId },
        );
      }
      message = ledger.text;
      const actual = GateRunner.hashText(message);
      if (ledger.hash !== actual) {
        throw new ToolSurfaceError(
          "GATE_ERROR",
          "verbatim FAIL hash mismatch — refusing to inject altered gate output",
          { expected: ledger.hash, actual },
        );
      }
      failHash = ledger.hash;
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
    return failHash === undefined ? { sent } : { sent, failHash };
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
    this.touchSessionActivity(input.sessionId);
    if (pending.taskId !== null) {
      const task = this.tasks.get(pending.taskId);
      if (task !== undefined) {
        const prior = (task.pendingQuestions ?? []).filter(
          (q) => q.questionId !== pending.questionId,
        );
        this.saveTask({
          ...task,
          pendingQuestions: [
            ...prior,
            {
              questionId: pending.questionId,
              sessionId: pending.sessionId,
              question: pending.question,
              askedAt: pending.askedAt,
            },
          ],
          updatedAt: new Date().toISOString(),
        });
      }
    }
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
    this.touchSessionActivity(pending.sessionId);
    if (pending.taskId !== null) {
      const task = this.tasks.get(pending.taskId);
      if (task !== undefined) {
        this.saveTask({
          ...task,
          pendingQuestions: (task.pendingQuestions ?? []).filter(
            (q) => q.questionId !== input.questionId,
          ),
          updatedAt: new Date().toISOString(),
        });
      }
    }
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
   * (cancel / FAILED / deliver abort), it is latched onto the durable run
   * and reported on fusion.completed regardless of settle order.
   */
  private finalizeFusionSidesForTask(
    taskId: string,
    error?: string | null,
  ): void {
    // Latch the abort reason once per open run before settling sides so a
    // clean mid-loop settle cannot erase it.
    if (error != null && error.length > 0) {
      for (const run of this.deps.fusionRuns.listForTask(taskId)) {
        if (run.completedAt != null) continue;
        this.latchFusionError(taskId, run.runId, error);
      }
    }

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

    // Durable open runs: never-spawned sides, lost ownership, tryComplete.
    // Same finalizeOpenFusionRun used by boot hydrate — one lifecycle rule.
    for (const run of this.deps.fusionRuns.listForTask(taskId)) {
      if (run.completedAt != null) continue;
      this.finalizeOpenFusionRun(taskId, run.runId, error);
    }
  }

  /**
   * Single durable-run finalize: settle never-spawned (null sessionId) sides,
   * complete session-owned sides that cannot still make progress (or are
   * force-finalized on error paths), leave live sides for settle/session_end,
   * and tryComplete when every side is done (including all-settled runs that
   * still lack completedAt).
   * Used by halt/cancel, mid-spawn failure, and boot hydrate so the rule is not forked.
   */
  private finalizeOpenFusionRun(
    taskId: string,
    runId: string,
    error?: string | null,
  ): void {
    if (error != null && error.length > 0) {
      this.latchFusionError(taskId, runId, error);
    }

    const force = error != null && error.length > 0;
    const initial = this.deps.fusionRuns.get(taskId, runId);
    if (initial === null || initial.completedAt != null) return;

    const sideCount = initial.sides.length;
    for (let sideIndex = 0; sideIndex < sideCount; sideIndex++) {
      const latest = this.deps.fusionRuns.get(taskId, runId);
      if (latest === null) break;
      if (latest.completedAt != null) break;
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
      // Property, not a status enum: can this side still receive lifecycle
      // events? Only starting/running rows with a live pane can. Anything else
      // (settled/stopped/lost/wedged/missing row/gone pane/unknown) must be
      // finalized here — default to finalize when progress is no or unknown.
      const canStillMakeProgress = this.fusionSideCanStillMakeProgress(
        side.sessionId,
      );
      // Force (halt / mid-spawn fail / never-spawned sibling) completes live
      // sides; boot hydrate only settles sides that can no longer settle alone.
      if (force || !canStillMakeProgress) {
        this.completeFusionSide(side.sessionId, error);
      }
    }

    // Crash window: all sides already settled but completedAt still null.
    this.tryCompleteFusionRun(taskId, runId, error);
  }

  /**
   * Whether a fusion side can still emit agent_settled / session_end on its own.
   * True only for a known session in a live status whose tmux window still
   * exists. Missing sessions, non-live statuses (including settled-without-
   * settledAt), gone panes, and unknown rows all return false so boot recovery
   * finalizes them through completeFusionSide rather than waiting forever.
   */
  private fusionSideCanStillMakeProgress(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.status !== "starting" && session.status !== "running") {
      return false;
    }
    try {
      return this.deps.tmux.hasWindow(session.tmuxWindow);
    } catch {
      // Unknown liveness → cannot assume progress; finalize on boot/halt.
      return false;
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
    // Success finalizes fusion via DONE → haltAndReleaseTask; abort paths
    // finalize in finally so runs cannot sit on fusion.dispatched.
    let deliveryComplete = false;
    let deliverAbortReason: string | null = null;
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
      const deliveryTarget = join(runDir, "delivery.json");
      const deliveryTmp = `${deliveryTarget}.${process.pid}.tmp`;
      writeFileSync(
        deliveryTmp,
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
      renameSync(deliveryTmp, deliveryTarget);

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
    } catch (error) {
      deliverAbortReason =
        error instanceof ToolSurfaceError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw error;
    } finally {
      if (!deliveryComplete) {
        // Dirty tree / status failure / deliveryBlocked / partial halt: finalize
        // any in-flight fusion via the shared helper before reclaiming leases.
        this.finalizeFusionSidesForTask(
          input.taskId,
          deliverAbortReason ?? "deliver_task aborted",
        );
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

  private escalate(
    raw: Record<string, unknown>,
    options?: { bypassAfk?: boolean },
  ): {
    ok: true;
    autoAnswered: boolean;
    answer: string | null;
    /** True when captain.escalation was actually sunk (not FAQ-auto-answered). */
    sank: boolean;
  } {
    const input = escalateToCaptainInputSchema.parse(raw);

    // `/afk`: answer only what the Captain pre-decided. A question with no
    // matching FAQ entry falls through to the normal escalation below and
    // waits — inventing an answer would be worse than the delay, because the
    // Brain would act on an instruction the Captain never gave.
    // Structural wedge discharges pass bypassAfk so FAQ needles cannot swallow
    // a seat-failure that must reach the Captain.
    if (
      options?.bypassAfk !== true &&
      this.deps.afk !== undefined &&
      this.deps.afk.isActive()
    ) {
      const answered = this.deps.afk.tryAnswer(input.summary);
      if (answered !== null) {
        return { ok: true, autoAnswered: true, answer: answered.answer, sank: false };
      }
    }

    if (input.taskId !== undefined) {
      const task = this.requireTask(input.taskId);
      if (!isTerminalPhase(task.phase)) {
        if (task.phase === "NEEDS_CAPTAIN") {
          this.saveTask({
            ...task,
            needsCaptainSummary: input.summary,
            updatedAt: new Date().toISOString(),
          });
        } else {
          this.transition(task, "NEEDS_CAPTAIN", input.summary);
        }
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
    return { ok: true, autoAnswered: false, answer: null, sank: true };
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

  private async provisionSecondmate(raw: Record<string, unknown>): Promise<{
    secondmate: {
      name: string;
      home: string;
      port: number;
      domain: string;
      brainModel: string | null;
      createdAt: string;
    };
  }> {
    if (this.deps.secondmates === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", "secondmate fleet unavailable");
    }
    const input = provisionSecondmateInputSchema.parse(raw);
    try {
      const secondmate = await this.deps.secondmates.registry.provision(input);
      return { secondmate };
    } catch (error) {
      if (error instanceof ZodError) throw error;
      throw new ToolSurfaceError(
        "CONFLICT",
        error instanceof Error ? error.message : "provision failed",
      );
    }
  }

  /**
   * Hand a task to a secondmate. POST the task to the secondmate first; only
   * after acceptance is it released on the primary. A failed POST leaves the
   * task on the primary with a typed error — dropping work is worse than
   * refusing to route. Named routing checks the target's own charter (domains +
   * acceptsRouting); routeFor is for auto-pick/discovery only.
   * Capacity (maxConcurrentTasks) is enforced on the live secondmate.
   *
   * Crash-safety: write pending intent before the remote POST, then durable
   * acceptance (with remoteTaskId) before primary CANCELLED. Pending is cleared
   * only on definite remote refusal; ambiguous failures keep pending so the
   * reconcile tick (and boot) can re-drive with the remote idempotency key.
   */
  private async routeToSecondmate(raw: Record<string, unknown>): Promise<{
    name: string;
    taskId: string;
    remoteTaskId: string;
    accepted: boolean;
    domain: string;
  }> {
    const input = routeToSecondmateInputSchema.parse(raw);
    if (this.deps.secondmates === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", "secondmate fleet unavailable");
    }
    const task = this.requireTask(input.taskId);
    const prior = this.readHandoverRecord(task.id);
    if (prior !== null) {
      if (prior.secondmateName !== input.name) {
        throw new ToolSurfaceError(
          "CONFLICT",
          `task ${task.id} already has in-flight handover to secondmate ${prior.secondmateName}`,
        );
      }
      if (prior.status === "accepted" && prior.remoteTaskId !== null) {
        return this.finalizeAcceptedHandover(prior);
      }
    }
    if (isTerminalPhase(task.phase)) {
      throw new ToolSurfaceError("CONFLICT", `task ${task.id} is terminal (${task.phase})`);
    }

    if (this.routingInProgress.has(task.id)) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `task ${task.id} is already being routed`,
      );
    }
    this.routingInProgress.add(task.id);

    try {
      const live = this.requireTask(input.taskId);
      if (isTerminalPhase(live.phase)) {
        const accepted = this.readHandoverRecord(task.id);
        if (accepted?.status === "accepted" && accepted.remoteTaskId !== null) {
          return this.finalizeAcceptedHandover(accepted);
        }
        throw new ToolSurfaceError("CONFLICT", `task ${live.id} is terminal (${live.phase})`);
      }

      const record = this.deps.secondmates.registry.get(input.name);
      if (record === null) {
        this.sink({
          type: "secondmate.routed",
          payload: {
            name: input.name,
            taskId: task.id,
            domain: input.domain,
            accepted: false,
            reason: `no secondmate named ${input.name}`,
            remoteTaskId: null,
          },
        });
        throw new ToolSurfaceError("NOT_FOUND", `no secondmate named ${input.name}`);
      }
      const { charter } = this.deps.secondmates.fleet.readCharter(record);
      if (!charter.acceptsRouting) {
        this.sink({
          type: "secondmate.routed",
          payload: {
            name: record.name,
            taskId: task.id,
            domain: input.domain,
            accepted: false,
            reason: "charter declines routing",
            remoteTaskId: null,
          },
        });
        throw new ToolSurfaceError(
          "POLICY_VIOLATION",
          `secondmate ${record.name} declines routing (charter acceptsRouting=false)`,
        );
      }
      // Named target's own charter — not routeFor first-wins across the fleet.
      if (!this.deps.secondmates.fleet.acceptsDomain(record, input.domain)) {
        this.sink({
          type: "secondmate.routed",
          payload: {
            name: record.name,
            taskId: task.id,
            domain: input.domain,
            accepted: false,
            reason: `secondmate ${record.name} does not accept domain ${input.domain}`,
            remoteTaskId: null,
          },
        });
        throw new ToolSurfaceError(
          "POLICY_VIOLATION",
          `secondmate ${record.name} does not accept domain ${input.domain}`,
        );
      }

      const project = this.deps.projects.get(task.projectId);
      if (project === null) {
        throw new ToolSurfaceError("NOT_FOUND", `project not found: ${task.projectId}`);
      }

      // Durable intent before the remote POST so a crash can re-drive safely.
      // Existing pending (retry after ambiguous failure) uses redrive so capacity
      // admission cannot refuse before the idempotent POST resolves remote ownership.
      const hadPending =
        prior !== null &&
        prior.status === "pending" &&
        prior.secondmateName === record.name;
      this.writeHandoverRecord({
        taskId: task.id,
        secondmateName: record.name,
        domain: input.domain,
        status: "pending",
        remoteTaskId: null,
        updatedAt: new Date().toISOString(),
      });

      let remoteTaskId: string;
      try {
        const handed = await this.deps.secondmates.fleet.handoverTask({
          record,
          task: live,
          project: {
            name: project.name,
            path: project.path,
            mode: project.mode,
            trusted: project.trusted,
            yolo: project.yolo,
          },
          domain: input.domain,
          ...(hadPending ? { redrive: true as const } : {}),
        });
        remoteTaskId = handed.remoteTaskId;
      } catch (error) {
        // Only erase pending on definite refusal. Ambiguous failures leave the
        // durable record so reconcilePendingHandoversAsync can recover dual ownership.
        // On redrive, never clear capacity (remote may already own the task).
        if (
          this.isDefiniteHandoverFailure(error) &&
          !(hadPending && error instanceof SecondmateCapacityError)
        ) {
          this.clearHandoverRecord(task.id);
        }
        const message =
          error instanceof SecondmateHandoverError || error instanceof SecondmateCapacityError
            ? error.message
            : error instanceof Error
              ? error.message
              : "handover failed";
        this.sink({
          type: "secondmate.routed",
          payload: {
            name: record.name,
            taskId: task.id,
            domain: input.domain,
            accepted: false,
            reason: message,
            remoteTaskId: null,
          },
        });
        if (
          error instanceof SecondmateHandoverError ||
          error instanceof SecondmateCapacityError
        ) {
          throw error;
        }
        // Unknown errors after pending was written are treated as ambiguous.
        throw new SecondmateHandoverError(message, undefined, false);
      }

      // Remote accept is durable before primary release (crash window closed).
      const acceptance: HandoverRecord = {
        taskId: task.id,
        secondmateName: record.name,
        domain: input.domain,
        status: "accepted",
        remoteTaskId,
        updatedAt: new Date().toISOString(),
      };
      this.writeHandoverRecord(acceptance);
      return this.finalizeAcceptedHandover(acceptance);
    } finally {
      this.routingInProgress.delete(task.id);
    }
  }

  /**
   * True when the secondmate certainly did not create the task — pending may be cleared.
   * Capacity and clean 4xx are definite; timeouts / network / 5xx / 200-without-id are not.
   */
  private isDefiniteHandoverFailure(error: unknown): boolean {
    if (error instanceof SecondmateCapacityError) return true;
    if (error instanceof SecondmateHandoverError) return error.definiteRefusal;
    return false;
  }

  /**
   * After remote accept is durable: release primary ownership if still live.
   * If the primary is already terminal, still report accepted — never a false
   * failure after work has landed on the secondmate.
   */
  private finalizeAcceptedHandover(record: HandoverRecord): {
    name: string;
    taskId: string;
    remoteTaskId: string;
    accepted: boolean;
    domain: string;
  } {
    if (record.remoteTaskId === null) {
      throw new ToolSurfaceError(
        "CONFLICT",
        `handover for task ${record.taskId} is missing remoteTaskId`,
      );
    }
    const task = this.tasks.get(record.taskId);
    if (task !== undefined && !isTerminalPhase(task.phase)) {
      // Terminal transition choke point owns halt/release.
      this.transition(
        task,
        "CANCELLED",
        `routed to secondmate ${record.secondmateName} as ${record.remoteTaskId}`,
      );
    }
    this.sink({
      type: "secondmate.routed",
      payload: {
        name: record.secondmateName,
        taskId: record.taskId,
        domain: record.domain,
        accepted: true,
        reason: null,
        remoteTaskId: record.remoteTaskId,
      },
    });
    return {
      name: record.secondmateName,
      taskId: record.taskId,
      remoteTaskId: record.remoteTaskId,
      accepted: true,
      domain: record.domain,
    };
  }

  /**
   * Finish handovers whose remote accept was durable but primary release did
   * not complete (kill -9 between acceptance write and CANCELLED). Called from
   * boot rehydrate and every reconcile tick.
   */
  reconcileAcceptedHandovers(): string[] {
    const finished: string[] = [];
    for (const task of this.tasks.values()) {
      if (isTerminalPhase(task.phase)) continue;
      const rec = this.readHandoverRecord(task.id);
      if (rec === null || rec.status !== "accepted" || rec.remoteTaskId === null) continue;
      this.finalizeAcceptedHandover(rec);
      finished.push(task.id);
    }
    return finished;
  }

  /**
   * Re-drive handovers that crashed or failed ambiguously after pending intent
   * was durable (remote POST uses idempotency key routed-from-primary:<taskId>)
   * then finalize primary release. Called from boot start and every reconcile
   * tick so dual ownership cannot wait for the next daemon restart.
   *
   * On definite remote refusal during redrive, clear pending (same rule as
   * routeToSecondmate). On ambiguous failure, leave pending for the next tick.
   */
  async reconcilePendingHandoversAsync(): Promise<string[]> {
    if (this.deps.secondmates === undefined) return [];
    const finished: string[] = [];
    for (const task of [...this.tasks.values()]) {
      if (isTerminalPhase(task.phase)) continue;
      const rec = this.readHandoverRecord(task.id);
      if (rec === null || rec.status !== "pending") continue;
      if (this.routingInProgress.has(task.id)) continue;
      this.routingInProgress.add(task.id);
      try {
        const record = this.deps.secondmates.registry.get(rec.secondmateName);
        if (record === null) continue;
        const project = this.deps.projects.get(task.projectId);
        if (project === null) continue;
        try {
          const handed = await this.deps.secondmates.fleet.handoverTask({
            record,
            task,
            project: {
              name: project.name,
              path: project.path,
              mode: project.mode,
              trusted: project.trusted,
              yolo: project.yolo,
            },
            domain: rec.domain,
            redrive: true,
          });
          const acceptance: HandoverRecord = {
            taskId: task.id,
            secondmateName: rec.secondmateName,
            domain: rec.domain,
            status: "accepted",
            remoteTaskId: handed.remoteTaskId,
            updatedAt: new Date().toISOString(),
          };
          this.writeHandoverRecord(acceptance);
          this.finalizeAcceptedHandover(acceptance);
          finished.push(task.id);
        } catch (error) {
          // Redrive never erases pending on capacity — remote may already own the
          // task from an ambiguous prior POST. Only clear clean non-capacity 4xx.
          if (
            error instanceof SecondmateHandoverError &&
            error.definiteRefusal
          ) {
            this.clearHandoverRecord(task.id);
          }
          // Capacity / ambiguous: leave pending for a later tick.
        }
      } finally {
        this.routingInProgress.delete(task.id);
      }
    }
    return finished;
  }

  private handoverPath(taskId: string): string {
    return join(this.deps.home, "runs", taskId, "handover.json");
  }

  private writeHandoverRecord(record: HandoverRecord): void {
    const dir = join(this.deps.home, "runs", record.taskId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.handoverPath(record.taskId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  }

  private readHandoverRecord(taskId: string): HandoverRecord | null {
    const path = this.handoverPath(taskId);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HandoverRecord>;
      if (
        typeof raw.taskId !== "string" ||
        typeof raw.secondmateName !== "string" ||
        typeof raw.domain !== "string" ||
        (raw.status !== "pending" && raw.status !== "accepted")
      ) {
        return null;
      }
      return {
        taskId: raw.taskId,
        secondmateName: raw.secondmateName,
        domain: raw.domain,
        status: raw.status,
        remoteTaskId: typeof raw.remoteTaskId === "string" ? raw.remoteTaskId : null,
        updatedAt:
          typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private clearHandoverRecord(taskId: string): void {
    const path = this.handoverPath(taskId);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  }

  /** Live status of secondmates; awaits the probe and surfaces unreachable as fact. */
  private async readSecondmateBearings(raw: Record<string, unknown>): Promise<{
    bearings: SecondmateBearings[];
  }> {
    const input = readSecondmateBearingsInputSchema.parse(raw);
    if (this.deps.secondmates === undefined) {
      throw new ToolSurfaceError("NOT_FOUND", "secondmate fleet unavailable");
    }
    const all = await this.deps.secondmates.fleet.bearings();
    const bearings =
      input.name === undefined ? all : all.filter((b) => b.name === input.name);
    if (input.name !== undefined && bearings.length === 0) {
      throw new ToolSurfaceError("NOT_FOUND", `no secondmate named ${input.name}`);
    }
    this.latestBearings = bearings;
    return { bearings };
  }

  /** Most recent bearings probe result, for fleet state and REST. */
  getLatestBearings(): SecondmateBearings[] {
    return this.latestBearings;
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

  /**
   * Auto-balancer advisory (§11 Phase 10). Returns which models the balancer
   * would spread this task across, WITH the inputs behind the choice.
   *
   * Deliberately advisory: the Brain stays the allocator and `resolve_cast`
   * still validates whatever it actually picks. If the balancer cannot make a
   * legal suggestion it REFUSES and says why, rather than proposing a cast the
   * substrate would reject — and it never suggests a familyCheckOverride to
   * make its own suggestion legal.
   */
  private suggestCastAdvisory(raw: Record<string, unknown>): BalancerSuggestion {
    const input = suggestCastInputSchema.parse(raw);
    const cfg = this.deps.config.effective().config;
    const balancer = cfg.balancer;

    const candidates = buildCandidates({
      roster: balancer.roster,
      connections: this.deps.connections?.list() ?? [],
      samples: this.deps.quotaSamples?.() ?? [],
    });

    const suggestion = suggestCast({
      config: balancer,
      candidates,
      roles: input.roles,
      // Cost is a refinement, never the ranking signal. It is only "usable"
      // when the Captain asked for it AND a provider actually reported it.
      costUsable: balancer.useReportedCost && this.deps.costCoverage?.() === "complete",
    });

    if (suggestion.enabled) {
      this.sink({
        type: "balancer.suggested",
        payload: {
          taskId: null,
          suggestions: suggestion.suggestions,
          considered: suggestion.considered.map((c) => ({
            model: c.model,
            usedPct: c.usedPct,
            tier: c.tier,
            limitReached: c.limitReached,
          })),
          costUsable: suggestion.costUsable,
          basis: suggestion.basis,
          refusal: suggestion.refusal,
        },
      });
    }
    return suggestion;
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
    options: { allowDone?: boolean; redBaselineRequired?: boolean } = {},
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
    // Derive red-baseline policy from config + task overrides when the caller
    // omits it, so every path (including advance_phase) honours the same edges.
    const redBaselineRequired =
      options.redBaselineRequired ??
      (this.cfg().policies.redBaselineGateRequired && !this.hasRedBaselineOverride(current));
    assertTransition(task.id, from, to, { redBaselineRequired });
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
    const merged = this.absorbPendingActivity(task);
    this.tasks.set(merged.id, merged);
    if (merged.idempotencyKey !== null) {
      this.idempotency.set(merged.idempotencyKey, merged);
    }
    this.persistTask(merged);
  }

  private persistTask(task: TaskSnapshot): void {
    const dir = join(this.deps.home, "runs", task.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, "task.json");
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  }

  /**
   * Fold coalesced activity stamps into a task snapshot and clear them.
   * Called from every saveTask so status/ledger writes cannot clobber a
   * hotter in-memory lastActivityAt with a stale lastEventAt.
   */
  private absorbPendingActivity(task: TaskSnapshot): TaskSnapshot {
    let any = false;
    const sessions = task.sessions.map((s) => {
      const pending = this.pendingActivityAt.get(s.sessionId);
      if (pending === undefined) return s;
      this.pendingActivityAt.delete(s.sessionId);
      // Never clobber a newer durable stamp (e.g. stop/status write) with an
      // older coalesced frame that was still sitting in the dirty map.
      if (s.lastEventAt !== null && s.lastEventAt >= pending) return s;
      any = true;
      return { ...s, lastEventAt: pending };
    });
    if (!any) return task;
    return {
      ...task,
      sessions,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Persist dirty activity stamps (one task.json write per affected task). */
  private flushPendingActivity(): void {
    if (this.pendingActivityAt.size === 0) return;
    const taskIds = new Set<string>();
    for (const sessionId of this.pendingActivityAt.keys()) {
      const session = this.sessions.get(sessionId);
      if (session?.taskId !== null && session?.taskId !== undefined) {
        taskIds.add(session.taskId);
      } else {
        this.pendingActivityAt.delete(sessionId);
      }
    }
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task !== undefined) this.saveTask(task);
    }
  }

  /** Record a session status reported by its extension (running → settled). */
  markSessionStatus(sessionId: string, status: FleetSession["status"]): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // Terminal is terminal: late agent_settled / running frames after stop,
    // lost, or wedged must not resurrect the session (and must not inflate healthyLeft).
    if (session.status === "stopped" || session.status === "lost" || session.status === "wedged") {
      return;
    }
    const now = new Date().toISOString();
    this.pendingActivityAt.delete(sessionId);
    this.sessions.set(sessionId, {
      ...session,
      status,
      lastActivityAt: now,
    });
    const task = session.taskId !== null ? this.tasks.get(session.taskId) : undefined;
    if (task !== undefined) {
      this.saveTask({
        ...task,
        sessions: task.sessions.map((s) =>
          s.sessionId === sessionId
            ? { ...s, status, lastEventAt: now }
            : s,
        ),
        updatedAt: now,
      });
    }
    if (status === "settled" && session.role === "scout") {
      this.auditScoutSession(sessionId);
    }
    if (status === "settled") {
      this.completeFusionSide(sessionId);
    }
  }

  /**
   * Stamp lastActivityAt from an observable frame (lifecycle progress, usage,
   * crewmate tool call) without changing status. null lastActivityAt means the
   * seat has produced nothing since spawn — only real frames clear that.
   * Durable lastEventAt is coalesced (dirty map + flush on reconcile/saveTask)
   * so busy seats cannot fsync the full task snapshot on every progress frame.
   */
  touchSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (
      session.status === "stopped" ||
      session.status === "lost" ||
      session.status === "wedged"
    ) {
      return;
    }
    const now = new Date().toISOString();
    this.sessions.set(sessionId, { ...session, lastActivityAt: now });
    if (session.taskId === null) return;
    this.pendingActivityAt.set(sessionId, now);
  }

  /** Mark a session lost (pane-died / reconcile). */
  markSessionLost(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.status === "lost" || session.status === "stopped") return;
    this.pendingActivityAt.delete(sessionId);
    // Finalize any in-flight fusion side so a pane-lost side cannot leave the
    // run stranded on fusion.dispatched. Pass reason so a lost last side is
    // not reported as a clean success. Ownership stays until the whole run
    // completes. Suppress releaseSettled's session.stopped — session.lost is
    // the single terminal lifecycle event for this path.
    this.completeFusionSide(sessionId, reason, { suppressStopEvent: true });
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
    this.clearPendingQuestionsForSession(sessionId);
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
   * Also settles any fusion side still waiting on this session. Ownership stays
   * until the whole fusion run completes so late ext.usage still attributes.
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

/**
 * Accumulate distinct fusion failure reasons. A later clean settle must not
 * erase an earlier stop/lost/abort; duplicate segments (exact equality after
 * splitting on "; ") are not repeated. Substring matches are not de-duped —
 * "stop" after "test stop" is a distinct reason.
 */
function mergeFusionErrors(
  existing: string | null | undefined,
  next: string,
): string {
  const trimmed = next.trim();
  if (trimmed.length === 0) return existing ?? "";
  if (existing == null || existing.length === 0) return trimmed;
  if (existing === trimmed) return existing;
  const segments = existing
    .split("; ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.includes(trimmed)) return existing;
  return `${existing}; ${trimmed}`;
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
