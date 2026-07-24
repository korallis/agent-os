import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { agentRoleSchema } from "./providers.js";

/**
 * Daemon ⇄ Pi extension Unix-socket frames (master plan §2.1, §5).
 * NDJSON lines, zod-validated both ways. Phase 2 carries telemetry + control;
 * Brain tool bridge expands in Phase 3.
 */

export const extensionHelloFrameSchema = z.strictObject({
  type: z.literal("ext.hello"),
  sessionId: ulidSchema,
  role: agentRoleSchema,
  piVersion: z.string(),
  extensionVersion: z.string(),
  ts: isoTimestampSchema,
});
export type ExtensionHelloFrame = z.infer<typeof extensionHelloFrameSchema>;

export const extensionLifecycleFrameSchema = z.strictObject({
  type: z.literal("ext.lifecycle"),
  sessionId: ulidSchema,
  phase: z.enum([
    "session_start",
    "turn_start",
    "turn_end",
    "agent_settled",
    "tool_call",
    "tool_result",
    "session_end",
  ]),
  detail: z.string().nullable(),
  ts: isoTimestampSchema,
});
export type ExtensionLifecycleFrame = z.infer<typeof extensionLifecycleFrameSchema>;

export const extensionUsageFrameSchema = z.strictObject({
  type: z.literal("ext.usage"),
  sessionId: ulidSchema,
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  /** Claude OAuth extra-usage estimate when known. */
  costUsd: z.number().min(0).nullable(),
  contextUsedPct: z.number().min(0).max(100).nullable(),
  ts: isoTimestampSchema,
});
export type ExtensionUsageFrame = z.infer<typeof extensionUsageFrameSchema>;

export const extensionToolBlockedFrameSchema = z.strictObject({
  type: z.literal("ext.tool_blocked"),
  sessionId: ulidSchema,
  toolName: z.string(),
  reason: z.string(),
  ts: isoTimestampSchema,
});
export type ExtensionToolBlockedFrame = z.infer<typeof extensionToolBlockedFrameSchema>;

/** Brain tool-call frame (Phase 3 tool bridge). */
export const extensionToolCallFrameSchema = z.strictObject({
  type: z.literal("ext.tool_call"),
  sessionId: ulidSchema,
  invocationId: ulidSchema,
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  ts: isoTimestampSchema,
});
export type ExtensionToolCallFrame = z.infer<typeof extensionToolCallFrameSchema>;

/** Frames the extension may send to the daemon. */
export const extensionToDaemonFrameSchema = z.discriminatedUnion("type", [
  extensionHelloFrameSchema,
  extensionLifecycleFrameSchema,
  extensionUsageFrameSchema,
  extensionToolBlockedFrameSchema,
  extensionToolCallFrameSchema,
]);
export type ExtensionToDaemonFrame = z.infer<typeof extensionToDaemonFrameSchema>;

/** Control frames the daemon may send to the extension. */
export const daemonControlFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ctl.ack"),
    ref: z.string(),
    ts: isoTimestampSchema,
  }),
  z.strictObject({
    type: z.literal("ctl.injectMessage"),
    sessionId: ulidSchema,
    message: z.string(),
    ts: isoTimestampSchema,
  }),
  z.strictObject({
    type: z.literal("ctl.shutdown"),
    reason: z.string(),
    ts: isoTimestampSchema,
  }),
  z.strictObject({
    type: z.literal("ctl.tool_result"),
    sessionId: ulidSchema,
    invocationId: ulidSchema,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .strictObject({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
    ts: isoTimestampSchema,
  }),
]);
export type DaemonControlFrame = z.infer<typeof daemonControlFrameSchema>;
