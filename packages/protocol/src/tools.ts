import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { configDomainSchema } from "./config.js";
import { agentRoleSchema } from "./providers.js";
import {
  projectModeSchema,
  roleCastSchema,
  scoutSpecSchema,
  shipSpecSchema,
  taskSnapshotSchema,
  thinkingLevelSchema,
  piModelRefSchema,
} from "./tasks.js";

/**
 * Brain tool surface schemas (master plan §5.3).
 * Every call is policy-checked, transition-validated, idempotency-keyed,
 * and appended to events.ndjson by the substrate.
 */

export const toolErrorCodeSchema = z.enum([
  "ILLEGAL_TRANSITION",
  "POLICY_VIOLATION",
  "NOT_FOUND",
  "CONFLICT",
  "BUDGET_EXCEEDED",
  "LIMIT_REACHED",
  "BRAIN_DOWN",
  "VALIDATION_ERROR",
  "SPAWN_FAILED",
  "PI_UNAVAILABLE",
  "UNAUTHORIZED_TOOL",
  "GATE_ERROR",
  "FUSION_CONTRACT",
  "INTERNAL",
]);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolError = z.infer<typeof toolErrorSchema>;

export const toolResultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: toolErrorSchema }),
  ]);

// ── Tool inputs ────────────────────────────────────────────────────────────

export const createTaskInputSchema = z.strictObject({
  spec: z.discriminatedUnion("shape", [shipSpecSchema, scoutSpecSchema]),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.strictObject({
  taskId: ulidSchema,
  patch: z
    .strictObject({
      title: z.string().min(1).max(200).optional(),
      intent: z.string().min(1).max(20_000).optional(),
      mode: projectModeSchema.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "patch must set at least one field"),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const cancelTaskInputSchema = z.strictObject({
  taskId: ulidSchema,
  reason: z.string().min(1).max(2000),
});
export type CancelTaskInput = z.infer<typeof cancelTaskInputSchema>;

export const readTaskInputSchema = z.strictObject({
  taskId: ulidSchema,
});
export type ReadTaskInput = z.infer<typeof readTaskInputSchema>;

export const castRoleAssignmentSchema = z.strictObject({
  role: agentRoleSchema,
  model: piModelRefSchema,
  thinking: thinkingLevelSchema.default("medium"),
  cleanRoom: z.boolean().default(true),
});
export type CastRoleAssignment = z.infer<typeof castRoleAssignmentSchema>;

export const resolveCastInputSchema = z.strictObject({
  taskId: ulidSchema,
  roles: z.array(castRoleAssignmentSchema).min(1),
  /** Captain override of cross-family safety — stamped into policyOverrides. */
  familyCheckOverride: z.boolean().default(false),
});
export type ResolveCastInput = z.infer<typeof resolveCastInputSchema>;

export const spawnCrewmateInputSchema = z.strictObject({
  taskId: ulidSchema,
  role: agentRoleSchema,
  model: piModelRefSchema,
  thinking: thinkingLevelSchema.default("medium"),
  promptTemplateRef: z.string().min(1).max(200).optional(),
  vars: z.record(z.string(), z.string()).default({}),
  prompt: z.string().min(1).max(100_000).optional(),
  cleanRoom: z.boolean().default(true),
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * Captain override of red-baseline-before-builder. Evidence-stamped into
   * policyOverrides when true; never implicit.
   */
  redBaselineOverride: z.boolean().default(false),
});
export type SpawnCrewmateInput = z.infer<typeof spawnCrewmateInputSchema>;

export const stopCrewmateInputSchema = z.strictObject({
  sessionId: ulidSchema,
  reason: z.string().min(1).max(2000),
});
export type StopCrewmateInput = z.infer<typeof stopCrewmateInputSchema>;

export const respawnCrewmateInputSchema = z.strictObject({
  sessionId: ulidSchema,
  reason: z.string().min(1).max(2000),
});
export type RespawnCrewmateInput = z.infer<typeof respawnCrewmateInputSchema>;

export const fusionKindSchema = z.enum(["opinion", "fusion", "plan-fusion"]);
export type FusionKind = z.infer<typeof fusionKindSchema>;

export const dispatchFusionInputSchema = z.strictObject({
  taskId: ulidSchema,
  kind: fusionKindSchema,
  casts: z.array(roleCastSchema).min(1),
  instructionTemplateRef: z.string().min(1).max(200).optional(),
  vars: z.record(z.string(), z.string()).default({}),
  instruction: z.string().min(1).max(100_000).optional(),
  /**
   * Whether to spawn clean-room Pi sides.
   * - Omitted: defaults by kind — `opinion` and `plan-fusion` spawn (master
   *   plan §6.3 two clean-room `pi -p` spawns); `fusion` does not (contract
   *   check when a completed artifact is supplied as `instruction`).
   * - `true` / `false`: explicit opt-in or bookkeeping-only opt-out.
   */
  spawnSides: z.boolean().optional(),
});
export type DispatchFusionInput = z.infer<typeof dispatchFusionInputSchema>;

export const authorGateInputSchema = z.strictObject({
  taskId: ulidSchema,
  validatorCast: roleCastSchema,
  gateSource: z.string().min(1).max(200_000).optional(),
});
export type AuthorGateInput = z.infer<typeof authorGateInputSchema>;

export const runGateInputSchema = z.strictObject({
  taskId: ulidSchema,
  target: z.enum(["baseline", "candidate"]),
});
export type RunGateInput = z.infer<typeof runGateInputSchema>;

export const sendToCrewInputSchema = z.strictObject({
  sessionId: ulidSchema,
  /** Free-form message OR a gateFailRef that injects verbatim FAIL lines. */
  message: z.string().min(1).max(100_000).optional(),
  gateFailRef: z.string().min(1).max(200).optional(),
});
export type SendToCrewInput = z.infer<typeof sendToCrewInputSchema>;

export const answerCrewmateInputSchema = z.strictObject({
  questionId: ulidSchema,
  answer: z.string().min(1).max(20_000),
});
export type AnswerCrewmateInput = z.infer<typeof answerCrewmateInputSchema>;

export const deliverTaskInputSchema = z.strictObject({
  taskId: ulidSchema,
});
export type DeliverTaskInput = z.infer<typeof deliverTaskInputSchema>;

/**
 * Captain-only: clear a sticky deliveryBlocked stamp after inspection.
 * Never available to crew (or Brain) sessions — only REST / Captain invoke.
 */
export const resolveDeliveryBlockInputSchema = z.strictObject({
  taskId: ulidSchema,
  reason: z.string().min(1).max(2000),
});
export type ResolveDeliveryBlockInput = z.infer<typeof resolveDeliveryBlockInputSchema>;

export const escalateToCaptainInputSchema = z.strictObject({
  taskId: ulidSchema.optional(),
  summary: z.string().min(1).max(5000),
  severity: z.enum(["info", "warn", "critical"]).default("warn"),
});
export type EscalateToCaptainInput = z.infer<typeof escalateToCaptainInputSchema>;

export const notifyCaptainInputSchema = z.strictObject({
  summary: z.string().min(1).max(5000),
  severity: z.enum(["info", "warn", "critical"]).default("info"),
});
export type NotifyCaptainInput = z.infer<typeof notifyCaptainInputSchema>;

export const routeToSecondmateInputSchema = z.strictObject({
  name: z.string().min(1).max(64),
  taskId: ulidSchema,
  /**
   * Domain being handed over. Must be in the named target secondmate's
   * charter.domains (enforced via SecondmateFleet.acceptsDomain on that
   * charter). routeFor is first-wins auto-pick only and is not used here.
   */
  domain: z.string().min(1).max(64),
});
export type RouteToSecondmateInput = z.infer<typeof routeToSecondmateInputSchema>;

export const readSecondmateBearingsInputSchema = z.strictObject({
  /** When omitted, probe every secondmate. */
  name: z.string().min(1).max(64).optional(),
});
export type ReadSecondmateBearingsInput = z.infer<typeof readSecondmateBearingsInputSchema>;

export const provisionSecondmateInputSchema = z.strictObject({
  name: z.string().min(1).max(64),
  domain: z.string().min(1).max(64),
  port: z.number().int().min(1024).max(65535).optional(),
  brainModel: z.string().min(3).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(32).optional(),
});
export type ProvisionSecondmateInput = z.infer<typeof provisionSecondmateInputSchema>;

export const stowKnowledgeInputSchema = z.strictObject({
  projectId: ulidSchema,
  notes: z.string().min(1).max(50_000),
  relativePath: z
    .string()
    .min(1)
    .max(200)
    .regex(/^docs\/notes\/[A-Za-z0-9._/-]+$/, "must write under docs/notes/")
    .refine(
      (p) =>
        p
          .slice("docs/notes/".length)
          .split("/")
          .every((seg) => seg.length > 0 && seg !== "." && seg !== ".."),
      { message: "path segments must not be . or .." },
    )
    .optional(),
});
export type StowKnowledgeInput = z.infer<typeof stowKnowledgeInputSchema>;

export const readPolicyInputSchema = z.strictObject({
  domain: configDomainSchema,
});
export type ReadPolicyInput = z.infer<typeof readPolicyInputSchema>;

export const readFleetStateInputSchema = z.strictObject({});
export type ReadFleetStateInput = z.infer<typeof readFleetStateInputSchema>;

export const readRunArtifactsInputSchema = z.strictObject({
  taskId: ulidSchema,
});
export type ReadRunArtifactsInput = z.infer<typeof readRunArtifactsInputSchema>;

/** Advance task phase (Brain-driven legal transition helper). */
export const advancePhaseInputSchema = z.strictObject({
  taskId: ulidSchema,
  to: z.string().min(1),
  reason: z.string().min(1).max(2000).optional(),
});
export type AdvancePhaseInput = z.infer<typeof advancePhaseInputSchema>;

// ── Catalog ────────────────────────────────────────────────────────────────

export const brainToolNameSchema = z.enum([
  "create_task",
  "update_task",
  "cancel_task",
  "read_fleet_state",
  "read_task",
  "read_run_artifacts",
  "resolve_cast",
  "spawn_crewmate",
  "stop_crewmate",
  "respawn_crewmate",
  "dispatch_fusion",
  "author_gate",
  "run_gate",
  "send_to_crew",
  "answer_crewmate",
  "deliver_task",
  "resolve_delivery_block",
  "escalate_to_captain",
  "notify_captain",
  "route_to_secondmate",
  "read_secondmate_bearings",
  "provision_secondmate",
  "stow_knowledge",
  "read_policy",
  "advance_phase",
]);
export type BrainToolName = z.infer<typeof brainToolNameSchema>;

export const BRAIN_TOOL_NAMES: readonly BrainToolName[] = brainToolNameSchema.options;

export const toolInvocationSchema = z.strictObject({
  invocationId: ulidSchema,
  tool: brainToolNameSchema,
  taskId: ulidSchema.nullable(),
  ok: z.boolean(),
  errorCode: toolErrorCodeSchema.nullable(),
  durationMs: z.number().int().min(0),
  ts: isoTimestampSchema,
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;

export const createTaskResultSchema = toolResultSchema(taskSnapshotSchema);
export type CreateTaskResult = z.infer<typeof createTaskResultSchema>;
