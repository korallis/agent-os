import { z } from "zod";
import { eventEnvelopeSchema } from "./events.js";
import { configValidationIssueSchema } from "./config.js";
import { isoTimestampSchema, ulidSchema } from "./ids.js";

/** REST DTOs for the Phase 1 `/v1/*` surface (master plan §8.2). */

/** GET `/v1/health` — unauthenticated liveness (used by `agentos status` + BFF). */
export const healthResponseSchema = z.strictObject({
  ok: z.literal(true),
  name: z.literal("agentosd"),
  version: z.string(),
  pid: z.number().int().positive(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** GET `/v1/status` — authenticated daemon status snapshot. */
export const statusResponseSchema = z.strictObject({
  daemon: z.strictObject({
    version: z.string(),
    pid: z.number().int().positive(),
    home: z.string(),
    port: z.number().int().positive(),
    startedAt: isoTimestampSchema,
    uptimeSeconds: z.number().min(0),
  }),
  events: z.strictObject({
    count: z.number().int().min(0),
    lastSeq: z.number().int().min(0),
    lastId: ulidSchema.nullable(),
  }),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

/** GET `/v1/events/replay?after=<ulid>&limit=<n>` — REST event replay. */
export const eventsReplayResponseSchema = z.strictObject({
  events: z.array(eventEnvelopeSchema),
  /** True when more events exist beyond `limit`. */
  truncated: z.boolean(),
});
export type EventsReplayResponse = z.infer<typeof eventsReplayResponseSchema>;

/** Typed API error codes (§8.1 "typed errors"). */
export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "CONFIG_INVALID",
  "CONFIRMATION_REQUIRED",
  "LAYER_NOT_WRITABLE",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** The one error envelope every non-2xx `/v1/*` response uses. */
export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Path-precise issues for CONFIG_INVALID responses. */
    issues: z.array(configValidationIssueSchema).nullable(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** PUT `/v1/config/:layer/:domain` success response. */
export const configWriteResponseSchema = z.strictObject({
  applied: z.literal(true),
  domain: z.string(),
  layer: z.string(),
  contentHash: z.string(),
});
export type ConfigWriteResponse = z.infer<typeof configWriteResponseSchema>;

/**
 * Header required on safety-policy writes (§11 Phase 1 config gate:
 * "safety-policy write requires confirmation and emits policy.changed").
 */
export const SAFETY_CONFIRM_HEADER = "x-agentos-confirm-safety";
