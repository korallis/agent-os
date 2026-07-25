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
 * Cleared only when the Captain reworks or terminates the task (not on retry).
 */
export const deliveryBlockedSchema = z.strictObject({
  leaseId: z.string().min(1),
  reason: z.string().min(1),
  dirtyPaths: z.array(z.string()),
  blockedAt: isoTimestampSchema,
});
export type DeliveryBlocked = z.infer<typeof deliveryBlockedSchema>;

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
  /** Set when deliver_task refuses a dirty/un-auditable tree; sticky until rework/cancel. */
  deliveryBlocked: deliveryBlockedSchema.nullable(),
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
    "BUILDING",
    "WAITING_WORKTREE",
    "CANCELLED",
    "FAILED",
    "NEEDS_CAPTAIN",
  ],
  BLOCKED_DISPATCH: ["QUEUED", "DISPATCH_RESOLVED", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
  PLANNING: ["PLAN_FUSED", "BUILDING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN", "SESSION_LOST"],
  PLAN_FUSED: ["GATE_AUTHORING", "BUILDING", "CANCELLED", "FAILED", "NEEDS_CAPTAIN"],
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
