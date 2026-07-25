import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { agentRoleSchema, modelFamilySchema, piProviderIdSchema } from "./providers.js";
import {
  piModelRefSchema,
  projectModeSchema,
  taskPhaseSchema,
  taskShapeSchema,
  taskSnapshotSchema,
  thinkingLevelSchema,
} from "./tasks.js";

/**
 * Fleet, projects, worktrees, wakes, brain status (master plan §5).
 */

export const projectRecordSchema = z.strictObject({
  id: ulidSchema,
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  mode: projectModeSchema,
  trusted: z.boolean(),
  trustHash: z.string().nullable(),
  yolo: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const worktreeStateSchema = z.enum(["idle", "leased", "quarantined", "reclaiming"]);
export type WorktreeState = z.infer<typeof worktreeStateSchema>;

export const worktreeLeaseSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  path: z.string(),
  state: worktreeStateSchema,
  taskId: ulidSchema.nullable(),
  sessionId: ulidSchema.nullable(),
  branch: z.string().nullable(),
  leasedAt: isoTimestampSchema.nullable(),
  lastSha: z.string().nullable(),
  /** Present when state is quarantined — why the tree was not returned to idle. */
  quarantineReason: z.string().optional(),
});
export type WorktreeLease = z.infer<typeof worktreeLeaseSchema>;

export const wakeClassSchema = z.enum([
  "PROGRESS",
  "TURN_SETTLED",
  "STATUS",
  "NEEDS_INPUT",
  "BLOCKED",
  "AUTH_OR_QUOTA",
  "BILLING_MISMATCH",
  "CONTEXT_PRESSURE",
  "QUOTA_THRESHOLD",
  "STALE",
  "WEDGED",
  "SECURITY",
  "DONE",
  "FAILED",
  "SESSION_LOST",
  "PLANNERS_SETTLED",
  "GATE_FAILED",
  "GATE_DEFECT",
  "AGENT_SETTLED",
]);
export type WakeClass = z.infer<typeof wakeClassSchema>;

export const wakeDigestSchema = z.strictObject({
  id: ulidSchema,
  class: wakeClassSchema,
  taskId: ulidSchema.nullable(),
  sessionId: ulidSchema.nullable(),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  absorbed: z.boolean(),
  deliveredToBrain: z.boolean(),
  createdAt: isoTimestampSchema,
});
export type WakeDigest = z.infer<typeof wakeDigestSchema>;

export const brainStatusSchema = z.enum(["running", "starting", "down", "handoff"]);
export type BrainStatus = z.infer<typeof brainStatusSchema>;

export const brainSnapshotSchema = z.strictObject({
  status: brainStatusSchema,
  sessionId: ulidSchema.nullable(),
  model: piModelRefSchema.nullable(),
  thinking: thinkingLevelSchema.nullable(),
  family: modelFamilySchema.nullable(),
  provider: piProviderIdSchema.nullable(),
  tmuxWindow: z.string().nullable(),
  wakeQueueDepth: z.number().int().min(0),
  lastReconcileAt: isoTimestampSchema.nullable(),
  handoffFrom: piModelRefSchema.nullable(),
  handoffReason: z.string().nullable(),
});
export type BrainSnapshot = z.infer<typeof brainSnapshotSchema>;

export const fleetSessionSchema = z.strictObject({
  sessionId: ulidSchema,
  taskId: ulidSchema.nullable(),
  role: agentRoleSchema,
  model: piModelRefSchema,
  thinking: thinkingLevelSchema,
  family: modelFamilySchema,
  tmuxWindow: z.string(),
  status: z.enum(["starting", "running", "settled", "stopped", "lost", "wedged"]),
  worktreePath: z.string().nullable(),
  startedAt: isoTimestampSchema,
});
export type FleetSession = z.infer<typeof fleetSessionSchema>;

export const fleetStateSnapshotSchema = z.strictObject({
  brain: brainSnapshotSchema,
  tasks: z.array(taskSnapshotSchema),
  sessions: z.array(fleetSessionSchema),
  worktrees: z.array(worktreeLeaseSchema),
  wakeQueue: z.array(wakeDigestSchema),
  projects: z.array(projectRecordSchema),
  brainDown: z.boolean(),
  generatedAt: isoTimestampSchema,
});
export type FleetStateSnapshot = z.infer<typeof fleetStateSnapshotSchema>;

export const fleetSummarySchema = z.strictObject({
  active: z.number().int().min(0),
  queued: z.number().int().min(0),
  needsCaptain: z.number().int().min(0),
  doneToday: z.number().int().min(0),
  failed: z.number().int().min(0),
  brain: brainSnapshotSchema,
  brainDown: z.boolean(),
});
export type FleetSummary = z.infer<typeof fleetSummarySchema>;

/** Compact row for console task boards. */
export const taskListItemSchema = z.strictObject({
  id: ulidSchema,
  shape: taskShapeSchema,
  title: z.string(),
  phase: taskPhaseSchema,
  projectId: ulidSchema,
  projectName: z.string().nullable(),
  mode: projectModeSchema,
  model: piModelRefSchema.nullable(),
  agent: agentRoleSchema.nullable(),
  updatedAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
});
export type TaskListItem = z.infer<typeof taskListItemSchema>;
