import { z } from "zod";
import { eventEnvelopeSchema } from "./events.js";
import { configValidationIssueSchema } from "./config.js";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import {
  claudeBillingModeSchema,
  connectionKindSchema,
  piProviderIdSchema,
  providerConnectionSchema,
} from "./providers.js";
import { quotaSampleSchema } from "./quota.js";
import { onboardingStateSchema } from "./onboarding.js";
import { PI_PINNED_VERSION } from "./pi.js";
import {
  fleetSessionSchema,
  fleetStateSnapshotSchema,
  fleetSummarySchema,
  projectRecordSchema,
  taskListItemSchema,
  wakeDigestSchema,
} from "./fleet.js";
import { projectModeSchema, taskSnapshotSchema, taskSpecSchema } from "./tasks.js";
import { brainToolNameSchema } from "./tools.js";

/** REST DTOs for `/v1/*` (master plan §8.2). Phase 1–6 surfaces. */

export const healthResponseSchema = z.strictObject({
  ok: z.literal(true),
  name: z.literal("agentosd"),
  version: z.string(),
  pid: z.number().int().positive(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

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
  pi: z
    .strictObject({
      pinnedVersion: z.literal(PI_PINNED_VERSION),
      detectedVersion: z.string().nullable(),
      binary: z.string().nullable(),
      managedHome: z.string().nullable(),
      configDirEnv: z.string().nullable(),
    })
    .optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export const eventsReplayResponseSchema = z.strictObject({
  events: z.array(eventEnvelopeSchema),
  truncated: z.boolean(),
});
export type EventsReplayResponse = z.infer<typeof eventsReplayResponseSchema>;

/**
 * GET `/v1/tasks/:id/events` — task-scoped frames for evidence surfaces.
 * `truncated` is true only when this task has more matching events than the limit
 * (not when the global log is large).
 */
export const taskEventsResponseSchema = z.strictObject({
  taskId: ulidSchema,
  events: z.array(eventEnvelopeSchema),
  truncated: z.boolean(),
});
export type TaskEventsResponse = z.infer<typeof taskEventsResponseSchema>;

/**
 * GET `/v1/sessions/:id` — one crewmate seat: its spawn facts, current status
 * and (when known) the task it belongs to. Figma "Agent Detail" (`41:2`).
 */
export const sessionDetailResponseSchema = z.strictObject({
  session: fleetSessionSchema.nullable(),
  /** Null when the session predates the current daemon's in-memory registry. */
  taskTitle: z.string().nullable(),
  /** Human attach command; the daemon never executes it. */
  attachCommand: z.string().nullable(),
});
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

/**
 * GET `/v1/sessions/:id/events` — session-scoped frames for the log view.
 * Figma "Agent Logs" (`41:456`). Same truncation semantics as task events.
 */
export const sessionEventsResponseSchema = z.strictObject({
  sessionId: ulidSchema,
  events: z.array(eventEnvelopeSchema),
  truncated: z.boolean(),
});
export type SessionEventsResponse = z.infer<typeof sessionEventsResponseSchema>;

/**
 * POST `/v1/sessions/:id/attach-ticket` — mint a single-use, short-lived ticket
 * for the read-only PTY WebSocket. The daemon token is never placed in a query
 * string; a one-shot ticket is, because query strings reach logs and history.
 */
export const attachTicketResponseSchema = z.strictObject({
  sessionId: ulidSchema,
  ticket: z.string().min(1),
  expiresAt: isoTimestampSchema,
  /**
   * Absolute loopback WS URL the browser opens DIRECTLY on the daemon. The BFF
   * cannot proxy a WS upgrade, which is exactly why the credential here is a
   * one-shot ticket rather than the daemon bearer token.
   */
  wsUrl: z.string().min(1),
});
export type AttachTicketResponse = z.infer<typeof attachTicketResponseSchema>;

/**
 * GET `/v1/runs/history` — per-task gate/fusion aggregates for Pipeline Runs.
 * Counts are computed daemon-side over the full relevant event set (not a
 * paged global replay), so the Console never reconstructs them from a window.
 */
export const runHistoryRowSchema = z.strictObject({
  task: taskListItemSchema,
  gateRuns: z.number().int().min(0),
  gateFailures: z.number().int().min(0),
  gateErrors: z.number().int().min(0),
  fusionRuns: z.number().int().min(0),
  firstSeen: isoTimestampSchema.nullable(),
  lastSeen: isoTimestampSchema.nullable(),
});
export type RunHistoryRow = z.infer<typeof runHistoryRowSchema>;

export const runHistoryResponseSchema = z.strictObject({
  runs: z.array(runHistoryRowSchema),
});
export type RunHistoryResponse = z.infer<typeof runHistoryResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "CONFIG_INVALID",
  "CONFIRMATION_REQUIRED",
  "LAYER_NOT_WRITABLE",
  "BILLING_MISMATCH",
  "ONBOARDING_BLOCKED",
  "PROBE_FAILED",
  "CONFLICT",
  "ILLEGAL_TRANSITION",
  "POLICY_VIOLATION",
  "BRAIN_DOWN",
  "LIMIT_REACHED",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string(),
    issues: z.array(configValidationIssueSchema).nullable(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const configWriteResponseSchema = z.strictObject({
  applied: z.literal(true),
  domain: z.string(),
  layer: z.string(),
  contentHash: z.string(),
});
export type ConfigWriteResponse = z.infer<typeof configWriteResponseSchema>;

export const SAFETY_CONFIRM_HEADER = "x-agentos-confirm-safety";

/** GET `/v1/connections` */
export const connectionsListResponseSchema = z.strictObject({
  connections: z.array(providerConnectionSchema),
  piPinnedVersion: z.literal(PI_PINNED_VERSION),
});
export type ConnectionsListResponse = z.infer<typeof connectionsListResponseSchema>;

/** POST `/v1/connections/oauth/start` */
export const oauthStartRequestSchema = z.strictObject({
  provider: piProviderIdSchema,
  billingMode: claudeBillingModeSchema.nullable().optional(),
});
export type OauthStartRequest = z.infer<typeof oauthStartRequestSchema>;

export const oauthStartResponseSchema = z.strictObject({
  connectionId: ulidSchema,
  tmuxSession: z.string(),
  tmuxWindow: z.string(),
  /** Attach hint for the Console terminal / human. */
  attachCommand: z.string(),
});
export type OauthStartResponse = z.infer<typeof oauthStartResponseSchema>;

/** POST `/v1/connections/api-key` */
export const apiKeyConnectRequestSchema = z.strictObject({
  provider: piProviderIdSchema,
  /** Never logged; written only to keychain. */
  apiKey: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type ApiKeyConnectRequest = z.infer<typeof apiKeyConnectRequestSchema>;

export const apiKeyConnectResponseSchema = z.strictObject({
  connection: providerConnectionSchema,
});
export type ApiKeyConnectResponse = z.infer<typeof apiKeyConnectResponseSchema>;

/** GET `/v1/connections/:id/quota` */
export const connectionQuotaResponseSchema = z.strictObject({
  connectionId: ulidSchema,
  sample: quotaSampleSchema.nullable(),
});
export type ConnectionQuotaResponse = z.infer<typeof connectionQuotaResponseSchema>;

/** GET `/v1/quota` — all latest samples. */
export const quotaListResponseSchema = z.strictObject({
  samples: z.array(quotaSampleSchema),
});
export type QuotaListResponse = z.infer<typeof quotaListResponseSchema>;

/** GET/PUT `/v1/onboarding` */
export const onboardingResponseSchema = z.strictObject({
  state: onboardingStateSchema,
});
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;

export const onboardingAdvanceRequestSchema = z.strictObject({
  action: z.enum([
    "refresh-doctor",
    "set-providers",
    "verify-auth",
    "set-claude-billing",
    "verify-claude-sdk",
    "enable-probes",
    "complete",
    "restart",
  ]),
  providers: z.array(piProviderIdSchema).optional(),
  provider: piProviderIdSchema.optional(),
  claudeBillingMode: claudeBillingModeSchema.optional(),
  kind: connectionKindSchema.optional(),
});
export type OnboardingAdvanceRequest = z.infer<typeof onboardingAdvanceRequestSchema>;

// ── Phase 3 REST: projects / tasks / fleet / brain tools ───────────────────

export const projectsListResponseSchema = z.strictObject({
  projects: z.array(projectRecordSchema),
});
export type ProjectsListResponse = z.infer<typeof projectsListResponseSchema>;

export const projectRegisterRequestSchema = z.strictObject({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  mode: projectModeSchema.optional(),
  trusted: z.boolean().optional(),
  yolo: z.boolean().optional(),
});
export type ProjectRegisterRequest = z.infer<typeof projectRegisterRequestSchema>;

export const projectResponseSchema = z.strictObject({
  project: projectRecordSchema,
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const tasksListResponseSchema = z.strictObject({
  tasks: z.array(taskListItemSchema),
});
export type TasksListResponse = z.infer<typeof tasksListResponseSchema>;

export const taskCreateRequestSchema = z.strictObject({
  spec: taskSpecSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;

export const taskResponseSchema = z.strictObject({
  task: taskSnapshotSchema,
});
export type TaskResponse = z.infer<typeof taskResponseSchema>;

export const fleetStateResponseSchema = z.strictObject({
  state: fleetStateSnapshotSchema,
});
export type FleetStateResponse = z.infer<typeof fleetStateResponseSchema>;

export const fleetSummaryResponseSchema = z.strictObject({
  summary: fleetSummarySchema,
});
export type FleetSummaryResponse = z.infer<typeof fleetSummaryResponseSchema>;

export const wakesListResponseSchema = z.strictObject({
  wakes: z.array(wakeDigestSchema),
});
export type WakesListResponse = z.infer<typeof wakesListResponseSchema>;

/** Captain / scripted-brain tool call over REST (also available via socket bridge). */
export const toolCallRequestSchema = z.strictObject({
  tool: brainToolNameSchema,
  input: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * Impersonate a session's bridge authorization. The Captain (holding the
   * daemon token) is unrestricted; supplying a sessionId applies that session's
   * narrower rights instead, which is how the bridge boundary is testable.
   */
  sessionId: ulidSchema.optional(),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolCallResponseSchema = z.strictObject({
  invocationId: ulidSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type ToolCallResponse = z.infer<typeof toolCallResponseSchema>;
