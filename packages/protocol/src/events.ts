import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import {
  configDomainSchema,
  configLayerSchema,
  configValidationIssueSchema,
} from "./config.js";

/**
 * The Phase 1 orchestrator event union (master plan §8.2, §9).
 *
 * Events are the source of truth: appended (fsync'd) to the NDJSON log
 * first, projected to SQLite second, and fanned out over SSE third. The
 * union grows in later phases (task.state, agent.*, provider.*, quota.*);
 * Phase 1 carries the daemon-lifecycle and config-layer members.
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

/** Shipped defaults installed into `~/.agentos/config/` on init (§2.6 layer 1→2). */
export const configInstalledEventSchema = z.strictObject({
  type: z.literal("config.installed"),
  payload: z.strictObject({
    domains: z.array(configDomainSchema),
  }),
});

/** A config layer file changed and was applied (hot-reload where safe, §2.6). */
export const configChangedEventSchema = z.strictObject({
  type: z.literal("config.changed"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    hotReloaded: z.boolean(),
    /** SHA-256 of the applied layer-file content. */
    contentHash: z.string(),
  }),
});

/** An invalid config write/edit was rejected — nothing partially applied (§2.6). */
export const configRejectedEventSchema = z.strictObject({
  type: z.literal("config.rejected"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    issues: z.array(configValidationIssueSchema),
  }),
});

/** A safety-policy write was confirmed and applied (§8.2 `policy.changed`). */
export const policyChangedEventSchema = z.strictObject({
  type: z.literal("policy.changed"),
  payload: z.strictObject({
    domain: z.literal("policies"),
    layer: configLayerSchema,
    /** True when any safety toggle is now weakened below default-ON. */
    safetyOverride: z.boolean(),
  }),
});

export const orchestratorEventSchema = z.discriminatedUnion("type", [
  daemonStartedEventSchema,
  daemonStoppingEventSchema,
  configInstalledEventSchema,
  configChangedEventSchema,
  configRejectedEventSchema,
  policyChangedEventSchema,
]);
export type OrchestratorEvent = z.infer<typeof orchestratorEventSchema>;

export type OrchestratorEventType = OrchestratorEvent["type"];

/**
 * The typed envelope every event is recorded and transported in.
 * `seq` is a strictly-monotonic per-log sequence; `id` is a ULID
 * (also the SSE `id:` field used for `Last-Event-ID` replay).
 */
export const eventEnvelopeSchema = z.strictObject({
  id: ulidSchema,
  seq: z.number().int().positive(),
  ts: isoTimestampSchema,
  event: orchestratorEventSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * SSE frame contract for `/v1/events` (§8.2): `id:` carries the envelope
 * ULID, `event:` carries the event type, `data:` carries the JSON envelope.
 */
export const sseFrameSchema = z.strictObject({
  id: ulidSchema,
  event: z.string(),
  data: eventEnvelopeSchema,
});
export type SseFrame = z.infer<typeof sseFrameSchema>;
