import { z } from "zod";

/**
 * Phase 0 placeholder — the zod schema surface (REST, SSE, socket frames,
 * tool surface, config schemas per master plan §2.1/§3) lands in Phase 1+.
 */
export const protocolVersionSchema = z.object({
  protocol: z.literal("agent-os"),
  version: z.string(),
});

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
