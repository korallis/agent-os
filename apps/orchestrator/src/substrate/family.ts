import { familyOfModelRef, type ModelFamily } from "@agent-os/protocol";

/**
 * Map a Pi `provider/model` string to a model family for cross-family
 * invariants (master plan §6.2, [R6] claude-agent-sdk → anthropic).
 *
 * Delegates to `familyOfModelRef` in `@agent-os/protocol` — the single origin
 * table. Kept as a named orchestrator export so existing call sites and tests
 * keep a stable import path.
 */
export function familyFromModel(model: string): ModelFamily {
  return familyOfModelRef(model);
}
