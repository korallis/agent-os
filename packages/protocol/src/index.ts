/**
 * @agent-os/protocol — the one shared schema surface (master plan §2.1).
 * REST DTOs, SSE frames, event envelopes, and config schemas; the daemon,
 * console, and CLI all compile against this package. Zero `any`.
 */
export * from "./ids.js";
export * from "./config.js";
export * from "./events.js";
export * from "./rest.js";

import { z } from "zod";

export const protocolVersionSchema = z.strictObject({
  protocol: z.literal("agent-os"),
  version: z.string(),
});
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

export const PROTOCOL_VERSION = "1.0.0-phase1";
