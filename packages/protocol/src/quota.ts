import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { piProviderIdSchema } from "./providers.js";

/**
 * Quota & balance probe types (master plan §4.9).
 * Every metric carries honesty tier + source + synced-at.
 */

export const honestyTierSchema = z.enum(["live", "best-effort", "estimate"]);
export type HonestyTier = z.infer<typeof honestyTierSchema>;

export const quotaMetricKindSchema = z.enum([
  "session-window-pct",
  "weekly-window-pct",
  "model-scoped-weekly-pct",
  "extra-usage-spend",
  "sdk-credit-pool",
  "plan-window-pct",
  "paid-credits",
  "account-credits",
  "key-limit-remaining",
  "balance",
  "voucher-balance",
  "cash-balance",
  "budget-remaining",
  "weekly-usage",
  "extra-credits",
]);
export type QuotaMetricKind = z.infer<typeof quotaMetricKindSchema>;

export const quotaMetricSchema = z.strictObject({
  kind: quotaMetricKindSchema,
  /** Primary display value — percent 0–100 or currency amount. */
  value: z.number(),
  unit: z.enum(["percent", "usd", "credits", "messages", "tokens", "unknown"]),
  tier: honestyTierSchema,
  /** Verbatim source row, e.g. "OAUTH · SYNCED 10:27". */
  source: z.string(),
  syncedAt: isoTimestampSchema,
  /** Optional human reason when tier is estimate or stale. */
  reason: z.string().nullable(),
  /** Optional window reset ISO timestamp for countdown UI. */
  resetsAt: isoTimestampSchema.nullable(),
  /** True when this metric alone implies LIMIT REACHED (window 100%). */
  limitReached: z.boolean(),
});
export type QuotaMetric = z.infer<typeof quotaMetricSchema>;

export const quotaSampleSchema = z.strictObject({
  id: ulidSchema,
  connectionId: ulidSchema,
  provider: piProviderIdSchema,
  metrics: z.array(quotaMetricSchema),
  sampledAt: isoTimestampSchema,
});
export type QuotaSample = z.infer<typeof quotaSampleSchema>;

/** Per-provider probe enable flags (config #14). */
export const quotaProviderProbeConfigSchema = z.strictObject({
  enabled: z.boolean(),
  /** Grok consumer endpoint and similar — feature-flagged best-effort. */
  bestEffortAllowed: z.boolean(),
});
export type QuotaProviderProbeConfig = z.infer<typeof quotaProviderProbeConfigSchema>;

/**
 * `quota.json5` — Policy Pack surface #14 (§2.6 / §4.9).
 * Probe endpoint URLs are config-locked (baked in code), not present here.
 */
export const quotaConfigSchema = z.strictObject({
  pollIntervalSeconds: z.number().int().min(30).max(3600),
  minIntervalSeconds: z.number().int().min(10).max(3600),
  jitterSeconds: z.number().int().min(0).max(120),
  backoffBaseSeconds: z.number().int().min(1).max(600),
  backoffMaxSeconds: z.number().int().min(30).max(3600),
  /** Window % thresholds that emit quota.threshold. */
  thresholds: z.strictObject({
    windowPctWarn: z.number().min(0).max(100),
    windowPctCritical: z.number().min(0).max(100),
    lowBalanceUsd: z.number().min(0),
  }),
  providers: z.strictObject({
    anthropic: quotaProviderProbeConfigSchema,
    openai: quotaProviderProbeConfigSchema,
    xai: quotaProviderProbeConfigSchema,
    openrouter: quotaProviderProbeConfigSchema,
    "kimi-coding": quotaProviderProbeConfigSchema,
    "vercel-ai-gateway": quotaProviderProbeConfigSchema,
    "claude-agent-sdk": quotaProviderProbeConfigSchema,
  }),
});
export type QuotaConfig = z.infer<typeof quotaConfigSchema>;
