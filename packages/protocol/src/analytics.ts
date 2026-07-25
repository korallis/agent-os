import { z } from "zod";
import { isoTimestampSchema } from "./ids.js";
import { billingSurfaceSchema, modelFamilySchema } from "./providers.js";
import { quotaSampleSchema } from "./quota.js";

/**
 * Usage & cost analytics (master plan §7 Token Usage / §8.2 `GET /v1/analytics`).
 *
 * Every field is derived from the append-only event log. A `null` means the
 * value could not be derived — most often because no provider reported cost —
 * and the Console must render that absence honestly rather than substituting a
 * zero or an estimate.
 *
 * Cost coverage is explicit: subscription-billed connections (Claude Max, etc.)
 * contribute null cost and must never be silently counted as $0.00 inside a
 * total the captain reads as their bill.
 */

export const costCoverageSchema = z.enum(["complete", "partial", "absent"]);
export type CostCoverage = z.infer<typeof costCoverageSchema>;

export const dailyUsagePointSchema = z.strictObject({
  /** UTC calendar day, YYYY-MM-DD. */
  day: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Sum of reported costs only; unreported legs contribute nothing (not $0). */
  costUsd: z.number().min(0).nullable(),
  tasksCreated: z.number().int().min(0),
  tasksCompleted: z.number().int().min(0),
});
export type DailyUsagePoint = z.infer<typeof dailyUsagePointSchema>;

export const modelUsageSchema = z.strictObject({
  model: z.string(),
  family: modelFamilySchema,
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /**
   * null when no request for this model reported cost; 0 when every reported
   * cost was zero. Unreported legs never inflate this as free spend.
   */
  costUsd: z.number().min(0).nullable(),
  requests: z.number().int().min(0),
  costReportedRequests: z.number().int().min(0),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const agentUsageSchema = z.strictObject({
  role: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /**
   * null when no request for this role reported cost; 0 when every reported
   * cost was zero. Unreported legs never inflate this as free spend.
   */
  costUsd: z.number().min(0).nullable(),
  requests: z.number().int().min(0),
  costReportedRequests: z.number().int().min(0),
  sharePct: z.number().min(0).max(100),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const analyticsTotalsSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /**
   * Sum of reported costs only. null when coverage is `absent`.
   * When coverage is `partial`, this is the reported subset — never a bill.
   */
  costUsd: z.number().min(0).nullable(),
  costCoverage: costCoverageSchema,
  /** Requests whose provider returned a non-null costUsd. */
  costReportedRequests: z.number().int().min(0),
  /** Requests whose provider returned null costUsd. */
  costMissingRequests: z.number().int().min(0),
  requests: z.number().int().min(0),
  tasksTotal: z.number().int().min(0),
  tasksDone: z.number().int().min(0),
  tasksFailed: z.number().int().min(0),
  /** null until at least one task reached a terminal phase in-window. */
  successRatePct: z.number().min(0).max(100).nullable(),
});
export type AnalyticsTotals = z.infer<typeof analyticsTotalsSchema>;

/**
 * Spend broken out by how the provider actually bills it (§11 Phase 8).
 * `unattributed` is a real bucket, not a rounding hole: usage whose connection
 * could not be identified must be visible, not folded into a surface it may
 * not belong to.
 */
export const billingSurfaceUsageSchema = z.strictObject({
  surface: z.union([billingSurfaceSchema, z.literal("unattributed")]),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).nullable(),
  requests: z.number().int().min(0),
  costReportedRequests: z.number().int().min(0),
});
export type BillingSurfaceUsage = z.infer<typeof billingSurfaceUsageSchema>;

/**
 * Brain overhead vs crew work (§11 Phase 8). The Brain never edits code, so its
 * tokens are pure orchestration cost — the Captain needs to see that separately
 * from the tokens that actually built something.
 */
export const brainUsageSchema = z.strictObject({
  brainInputTokens: z.number().int().min(0),
  brainOutputTokens: z.number().int().min(0),
  brainCostUsd: z.number().min(0).nullable(),
  brainRequests: z.number().int().min(0),
  crewInputTokens: z.number().int().min(0),
  crewOutputTokens: z.number().int().min(0),
  crewCostUsd: z.number().min(0).nullable(),
  crewRequests: z.number().int().min(0),
  /** Share of all in-window tokens spent orchestrating rather than building. */
  brainSharePct: z.number().min(0).max(100),
});
export type BrainUsage = z.infer<typeof brainUsageSchema>;

/**
 * Reconciliation (§11 Phase 8 "analytics reconcile ±0"). Every breakdown is
 * derived from the same event pass as the totals, so each must sum back to them
 * exactly. Computed daemon-side and asserted by the Phase 8 gate: a false here
 * is a defect in the derivation, not a rounding artifact.
 */
export const analyticsReconcileSchema = z.strictObject({
  modelsMatchTotals: z.boolean(),
  agentsMatchTotals: z.boolean(),
  dailyMatchTotals: z.boolean(),
  billingSurfacesMatchTotals: z.boolean(),
  brainPlusCrewMatchTotals: z.boolean(),
  /** True only when every breakdown above reconciles exactly. */
  exact: z.boolean(),
});
export type AnalyticsReconcile = z.infer<typeof analyticsReconcileSchema>;

export const analyticsSnapshotSchema = z.strictObject({
  generatedAt: isoTimestampSchema,
  windowDays: z.number().int().min(1).max(365),
  /**
   * True when a read bound was hit: the day-window event page and/or the
   * session.spawned attribution lookup. Pages are newest-first, so truncation
   * omits older frames — never the newest tail. Spawn-lookup truncation can
   * leave older sessions unattributed.
   */
  truncated: z.boolean(),
  totals: analyticsTotalsSchema,
  daily: z.array(dailyUsagePointSchema),
  models: z.array(modelUsageSchema),
  agents: z.array(agentUsageSchema),
  billingSurfaces: z.array(billingSurfaceUsageSchema),
  brain: brainUsageSchema,
  reconcile: analyticsReconcileSchema,
  quota: z.array(quotaSampleSchema),
});
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
