import { z } from "zod";
import { isoTimestampSchema } from "./ids.js";
import { modelFamilySchema } from "./providers.js";
import { quotaSampleSchema } from "./quota.js";

/**
 * Usage & cost analytics (master plan §7.6).
 *
 * Every field is derived from the append-only event log. A `null` means the
 * value could not be derived — most often because no provider reported cost —
 * and the Console must render that absence honestly rather than substituting a
 * zero or an estimate.
 */

export const dailyUsagePointSchema = z.strictObject({
  /** UTC calendar day, YYYY-MM-DD. */
  day: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  tasksCreated: z.number().int().min(0),
  tasksCompleted: z.number().int().min(0),
});
export type DailyUsagePoint = z.infer<typeof dailyUsagePointSchema>;

export const modelUsageSchema = z.strictObject({
  model: z.string(),
  family: modelFamilySchema,
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  requests: z.number().int().min(0),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const agentUsageSchema = z.strictObject({
  role: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  requests: z.number().int().min(0),
  sharePct: z.number().min(0).max(100),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const analyticsTotalsSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** null when no provider reported cost — not the same as zero spend. */
  costUsd: z.number().min(0).nullable(),
  requests: z.number().int().min(0),
  tasksTotal: z.number().int().min(0),
  tasksDone: z.number().int().min(0),
  tasksFailed: z.number().int().min(0),
  /** null until at least one task reached a terminal phase. */
  successRatePct: z.number().min(0).max(100).nullable(),
});
export type AnalyticsTotals = z.infer<typeof analyticsTotalsSchema>;

export const analyticsSnapshotSchema = z.strictObject({
  generatedAt: isoTimestampSchema,
  windowDays: z.number().int().min(1).max(365),
  totals: analyticsTotalsSchema,
  daily: z.array(dailyUsagePointSchema),
  models: z.array(modelUsageSchema),
  agents: z.array(agentUsageSchema),
  quota: z.array(quotaSampleSchema),
});
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
