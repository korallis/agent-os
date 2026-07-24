/**
 * @agent-os/protocol — the one shared schema surface (master plan §2.1).
 * REST DTOs, SSE frames, event envelopes, config, providers, quota, sockets.
 * Zero `any`.
 */
export * from "./ids.js";
export * from "./config.js";
export * from "./events.js";
export * from "./rest.js";
export * from "./providers.js";
export * from "./quota.js";
export * from "./sockets.js";
export * from "./onboarding.js";
export * from "./pi.js";

import { z } from "zod";

export const protocolVersionSchema = z.strictObject({
  protocol: z.literal("agent-os"),
  version: z.string(),
});
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

export const PROTOCOL_VERSION = "1.1.0-phase2";
