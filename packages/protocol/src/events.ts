import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import {
  configDomainSchema,
  configLayerSchema,
  configValidationIssueSchema,
} from "./config.js";
import {
  authStorePresenceSchema,
  billingSurfaceSchema,
  claudeBillingModeSchema,
  connectionHealthSchema,
  connectionKindSchema,
  modelFamilySchema,
  piProviderIdSchema,
} from "./providers.js";
import { honestyTierSchema, quotaMetricSchema } from "./quota.js";
import { onboardingStepSchema } from "./onboarding.js";

/**
 * Orchestrator event union (master plan §8.2, §9).
 * Phase 1: daemon + config. Phase 2: provider, quota, extension, onboarding.
 */

export const daemonStartedEventSchema = z.strictObject({
  type: z.literal("daemon.started"),
  payload: z.strictObject({
    version: z.string(),
    pid: z.number().int().positive(),
    home: z.string(),
    port: z.number().int().positive(),
  }),
});

export const daemonStoppingEventSchema = z.strictObject({
  type: z.literal("daemon.stopping"),
  payload: z.strictObject({
    reason: z.enum(["signal", "shutdown"]),
    signal: z.string().nullable(),
  }),
});

export const configInstalledEventSchema = z.strictObject({
  type: z.literal("config.installed"),
  payload: z.strictObject({
    domains: z.array(configDomainSchema),
  }),
});

export const configChangedEventSchema = z.strictObject({
  type: z.literal("config.changed"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    hotReloaded: z.boolean(),
    contentHash: z.string(),
  }),
});

export const configRejectedEventSchema = z.strictObject({
  type: z.literal("config.rejected"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    issues: z.array(configValidationIssueSchema),
  }),
});

export const policyChangedEventSchema = z.strictObject({
  type: z.literal("policy.changed"),
  payload: z.strictObject({
    domain: z.literal("policies"),
    layer: configLayerSchema,
    safetyOverride: z.boolean(),
  }),
});

/** A provider connection was created or its health/presence flipped. */
export const providerConnectionUpdatedEventSchema = z.strictObject({
  type: z.literal("provider.connection_updated"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    kind: connectionKindSchema,
    health: connectionHealthSchema,
    billingSurface: billingSurfaceSchema,
    billingMode: claudeBillingModeSchema.nullable(),
    family: modelFamilySchema,
    limitReached: z.boolean(),
  }),
});

/** Auth-store presence changed (mtime/hash) — never carries token material. */
export const providerCredentialRefreshedEventSchema = z.strictObject({
  type: z.literal("provider.credential_refreshed"),
  payload: z.strictObject({
    provider: piProviderIdSchema,
    presence: authStorePresenceSchema,
  }),
});

/** BILLING_MISMATCH: cast credential path ≠ observed telemetry path (§4.2). */
export const providerBillingMismatchEventSchema = z.strictObject({
  type: z.literal("provider.billing_mismatch"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    expectedPath: z.string(),
    observedPath: z.string(),
    detail: z.string(),
  }),
});

export const quotaUpdatedEventSchema = z.strictObject({
  type: z.literal("quota.updated"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    metrics: z.array(quotaMetricSchema),
    sampleId: ulidSchema,
  }),
});

export const quotaThresholdEventSchema = z.strictObject({
  type: z.literal("quota.threshold"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    kind: z.string(),
    tier: honestyTierSchema,
    value: z.number(),
    level: z.enum(["warn", "critical", "limit-reached"]),
    reason: z.string(),
  }),
});

export const extensionHelloEventSchema = z.strictObject({
  type: z.literal("ext.hello"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    role: z.string(),
    piVersion: z.string(),
  }),
});

export const extensionUsageEventSchema = z.strictObject({
  type: z.literal("ext.usage"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  }),
});

export const onboardingStepEventSchema = z.strictObject({
  type: z.literal("onboarding.step"),
  payload: z.strictObject({
    step: onboardingStepSchema,
    previous: onboardingStepSchema.nullable(),
  }),
});

export const onboardingCompletedEventSchema = z.strictObject({
  type: z.literal("onboarding.completed"),
  payload: z.strictObject({
    at: isoTimestampSchema,
  }),
});

export const orchestratorEventSchema = z.discriminatedUnion("type", [
  daemonStartedEventSchema,
  daemonStoppingEventSchema,
  configInstalledEventSchema,
  configChangedEventSchema,
  configRejectedEventSchema,
  policyChangedEventSchema,
  providerConnectionUpdatedEventSchema,
  providerCredentialRefreshedEventSchema,
  providerBillingMismatchEventSchema,
  quotaUpdatedEventSchema,
  quotaThresholdEventSchema,
  extensionHelloEventSchema,
  extensionUsageEventSchema,
  onboardingStepEventSchema,
  onboardingCompletedEventSchema,
]);
export type OrchestratorEvent = z.infer<typeof orchestratorEventSchema>;

export type OrchestratorEventType = OrchestratorEvent["type"];

export const eventEnvelopeSchema = z.strictObject({
  id: ulidSchema,
  seq: z.number().int().positive(),
  ts: isoTimestampSchema,
  event: orchestratorEventSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const sseFrameSchema = z.strictObject({
  id: ulidSchema,
  event: z.string(),
  data: eventEnvelopeSchema,
});
export type SseFrame = z.infer<typeof sseFrameSchema>;
