import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { agentRoleSchema, modelFamilySchema } from "./providers.js";

/**
 * Task shapes, state machine, and snapshots (master plan §5.2–§5.3).
 * Typed state is substrate-owned; the Brain chooses among legal transitions.
 */

export const taskShapeSchema = z.enum(["SHIP", "SCOUT"]);
export type TaskShape = z.infer<typeof taskShapeSchema>;

export const projectModeSchema = z.enum(["pipeline", "direct-pr", "local-only"]);
export type ProjectMode = z.infer<typeof projectModeSchema>;

/** Exhaustive task phase set (§5.3). */
export const taskPhaseSchema = z.enum([
  "QUEUED",
  "DISPATCH_RESOLVED",
  "BLOCKED_DISPATCH",
  "PLANNING",
  "PLAN_FUSED",
  "GATE_AUTHORING",
  "GATE_RED_VERIFIED",
  "BUILDING",
  "VALIDATING",
  "DELIVERING",
  "DONE",
  "NEEDS_CAPTAIN",
  "CANCELLED",
  "FAILED",
  "SESSION_LOST",
  "VALIDATION_EXHAUSTED",
  "WAITING_WORKTREE",
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const taskFailureCauseSchema = z.enum([
  "DISPATCH",
  "SPAWN",
  "GATE_ERROR",
  "GATE_DEFECT",
  "VALIDATION_EXHAUSTED",
  "SECURITY",
  "SESSION_LOST",
  "BUDGET",
  "POLICY",
  "CAPTAIN_CANCEL",
  "UNKNOWN",
]);
export type TaskFailureCause = z.infer<typeof taskFailureCauseSchema>;

export const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

/** Fully-qualified Pi model string: `provider/model`. */
export const piModelRefSchema = z
  .string()
  .min(3)
  .regex(/^[^/\s]+\/[^/\s].*$/, "expected provider/model");
export type PiModelRef = z.infer<typeof piModelRefSchema>;

export const roleCastSchema = z.strictObject({
  role: agentRoleSchema,
  model: piModelRefSchema,
  thinking: thinkingLevelSchema,
  family: modelFamilySchema,
  cleanRoom: z.boolean(),
});
export type RoleCast = z.infer<typeof roleCastSchema>;

export const shipSpecSchema = z.strictObject({
  shape: z.literal("SHIP"),
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(20_000),
  projectId: ulidSchema,
  mode: projectModeSchema,
  /** When true, fusion/plan-fusion may be dropped per safety policy. */
  yolo: z.boolean().default(false),
  acceptanceSource: z.string().min(1).max(20_000).optional(),
  fusionProfile: z.string().min(1).max(100).optional(),
});
export type ShipSpec = z.infer<typeof shipSpecSchema>;

export const scoutSpecSchema = z.strictObject({
  shape: z.literal("SCOUT"),
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(20_000),
  projectId: ulidSchema,
  /** SCOUT is always read-only; mode is informational for deliverable shape. */
  mode: projectModeSchema.default("local-only"),
});
export type ScoutSpec = z.infer<typeof scoutSpecSchema>;

export const taskSpecSchema = z.discriminatedUnion("shape", [shipSpecSchema, scoutSpecSchema]);
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const taskSessionSchema = z.strictObject({
  sessionId: ulidSchema,
  role: agentRoleSchema,
  model: piModelRefSchema,
  thinking: thinkingLevelSchema,
  family: modelFamilySchema,
  tmuxWindow: z.string(),
  worktreePath: z.string().nullable(),
  status: z.enum(["starting", "running", "settled", "stopped", "lost", "wedged"]),
  startedAt: isoTimestampSchema,
  lastEventAt: isoTimestampSchema.nullable(),
});
export type TaskSession = z.infer<typeof taskSessionSchema>;

/**
 * Durable refuse of deliver_task after a dirty/status-failed worktree. Survives
 * quarantine clearing the lease↔task association so a retry cannot mark DONE.
 * Cleared only by the Captain tool `resolve_delivery_block` — never as a side
 * effect of a phase transition.
 */
export const deliveryBlockedSchema = z.strictObject({
  leaseId: z.string().min(1),
  reason: z.string().min(1),
  dirtyPaths: z.array(z.string()),
  blockedAt: isoTimestampSchema,
});
export type DeliveryBlocked = z.infer<typeof deliveryBlockedSchema>;

/**
 * Daemon-owned RED baseline proof. Authorised only when HMAC verifies under the
 * daemon-only gate-proof secret — never from a seat-writable file alone.
 */
export const taskRedProofSchema = z.strictObject({
  gateSourceHash: z.string().min(1),
  outcome: z.enum(["EXPECTED_RED", "FAIL"]),
  provenAt: isoTimestampSchema,
  /** HMAC-SHA256(gateSourceHash) with daemon-only key. */
  hmac: z.string().min(1),
});
export type TaskRedProof = z.infer<typeof taskRedProofSchema>;

/** Daemon-owned verbatim FAIL ledger (text + hash); disk is cache only. */
export const taskFailLedgerSchema = z.strictObject({
  text: z.string(),
  hash: z.string().min(1),
});
export type TaskFailLedger = z.infer<typeof taskFailLedgerSchema>;

export const taskSnapshotSchema = z.strictObject({
  id: ulidSchema,
  shape: taskShapeSchema,
  title: z.string(),
  intent: z.string(),
  projectId: ulidSchema,
  mode: projectModeSchema,
  yolo: z.boolean(),
  phase: taskPhaseSchema,
  failureCause: taskFailureCauseSchema.nullable(),
  cast: z.array(roleCastSchema),
  sessions: z.array(taskSessionSchema),
  validationAttempt: z.number().int().min(0),
  maxValidations: z.number().int().min(1),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  needsCaptainSummary: z.string().nullable(),
  /** Set when a task-linked worktree quarantines dirty; sticky until Captain resolves. */
  deliveryBlocked: deliveryBlockedSchema.nullable(),
  /**
   * Daemon-authoritative RED proof for the current gate revision.
   * Rebuilt into process memory on boot; never authorised from seat disk alone.
   */
  redProof: taskRedProofSchema.nullable().default(null),
  /** Daemon-authoritative last FAIL lines for verbatim inject. */
  lastFailLedger: taskFailLedgerSchema.nullable().default(null),
  /**
   * Per-role structural-WEDGED respawns already spent on this task.
   * Survives daemon restart so the respawn-once spend bound cannot reset on bounce.
   */
  wedgeRespawnsByRole: z.record(z.string(), z.number().int().min(0)).default({}),
  /**
   * Outstanding captain.escalation obligations from the WEDGED ladder.
   * Recorded when the substrate decides the Captain must be told; cleared only
   * after captain.escalation is sunk. Survives seat state, process death, and
   * restart — discharged exactly once on a later reconcile tick if needed.
   */
  wedgePendingCaptainNotifies: z
    .array(
      z.strictObject({
        sessionId: z.string().min(1),
        role: z.string().min(1),
        summary: z.string().min(1),
        severity: z.enum(["info", "warn", "critical"]),
        recordedAt: isoTimestampSchema,
      }),
    )
    .default([]),
  /**
   * Session ids whose WEDGED ladder fully finished (respawn done, or captain
   * escalation sunk). Durable so a daemon restart cannot re-open a completed
   * escalate seat and re-arm a cleared Captain-notify obligation.
   */
  wedgeLadderCompletedSessionIds: z.array(z.string().min(1)).default([]),
  /**
   * Outstanding crewmate questions awaiting Captain/Brain answer.
   * Rehydrated into the live pending-questions view on boot so the structural
   * WEDGED open-question exemption and answer_crewmate survive daemon restart.
   */
  pendingQuestions: z
    .array(
      z.strictObject({
        questionId: z.string().min(1),
        sessionId: z.string().min(1),
        question: z.string().min(1),
        askedAt: isoTimestampSchema,
      }),
    )
    .default([]),
  idempotencyKey: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  configSnapshotHash: z.string().nullable(),
  policyOverrides: z.array(
    z.strictObject({
      policyId: z.string(),
      configuredValue: z.string(),
      layer: z.string(),
      stampedAt: isoTimestampSchema,
    }),
  ),
});
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

/**
 * Legal transitions for the substrate state machine (§5.3).
 * Keys are from-phase; values are allowed to-phases.
 */
export const LEGAL_TASK_TRANSITIONS: Readonly<Record<TaskPhase, readonly TaskPhase[]>> = {
  QUEUED: ["DISPATCH_RESOLVED", "BLOCKED_DISPATCH", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
  DISPATCH_RESOLVED: [
    "PLANNING",
    "GATE_AUTHORING",
    "WAITING_WORKTREE",
    "CANCELLED",
    "FAILED",
    "NEEDS_CAPTAIN",
  ],
  BLOCKED_DISPATCH: ["QUEUED", "DISPATCH_RESOLVED", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
  PLANNING: ["PLAN_FUSED", "BUILDING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN", "SESSION_LOST"],
  PLAN_FUSED: ["GATE_AUTHORING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
  GATE_AUTHORING: [
    "GATE_RED_VERIFIED",
    "FAILED",
    "CANCELLED",
    "NEEDS_CAPTAIN",
    "SESSION_LOST",
  ],
  GATE_RED_VERIFIED: ["BUILDING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
  BUILDING: [
    "VALIDATING",
    "DELIVERING",
    // A candidate gate can FAIL straight from BUILDING (rebuild loop), so the
    // validation cap must be reachable from here too — otherwise the halt
    // throws ILLEGAL_TRANSITION and the attempt counter climbs past its cap.
    "VALIDATION_EXHAUSTED",
    "CANCELLED",
    "FAILED",
    "NEEDS_CAPTAIN",
    "SESSION_LOST",
  ],
  VALIDATING: [
    "BUILDING",
    "DELIVERING",
    "VALIDATION_EXHAUSTED",
    "CANCELLED",
    "FAILED",
    "NEEDS_CAPTAIN",
    "SESSION_LOST",
  ],
  DELIVERING: ["DONE", "FAILED", "CANCELLED", "NEEDS_CAPTAIN"],
  DONE: [],
  NEEDS_CAPTAIN: [
    "QUEUED",
    "DISPATCH_RESOLVED",
    "PLANNING",
    "BUILDING",
    "VALIDATING",
    "DELIVERING",
    "CANCELLED",
    "FAILED",
  ],
  CANCELLED: [],
  FAILED: [],
  SESSION_LOST: ["QUEUED", "BUILDING", "VALIDATING", "FAILED", "CANCELLED", "NEEDS_CAPTAIN"],
  VALIDATION_EXHAUSTED: ["NEEDS_CAPTAIN", "FAILED", "CANCELLED"],
  WAITING_WORKTREE: ["DISPATCH_RESOLVED", "BUILDING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
};

/** Phases that are terminal (no further transitions except reconcile bookkeeping). */
export const TERMINAL_TASK_PHASES: readonly TaskPhase[] = [
  "DONE",
  "CANCELLED",
  "FAILED",
];
