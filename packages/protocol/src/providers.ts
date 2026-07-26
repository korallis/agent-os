import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";

/**
 * Provider connections (master plan §4.1–§4.6).
 * Pi is the only process that talks to model providers.
 */

/** Model families for cross-family invariants (§6.2). */
export const modelFamilySchema = z.enum([
  "anthropic",
  "openai",
  "xai",
  "google",
  "moonshot",
  "mistral",
  "deepseek",
  "groq",
  "other",
]);
export type ModelFamily = z.infer<typeof modelFamilySchema>;

export const connectionKindSchema = z.enum(["pi-oauth", "pi-api-key"]);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

/** Pi provider ids we track (auth-store presence + catalog). */
export const piProviderIdSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "xai",
  "openrouter",
  "github-copilot",
  "amazon-bedrock",
  "azure-openai-responses",
  "google-gemini-cli",
  "google-vertex",
  "vercel-ai-gateway",
  "zai",
  "opencode",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "claude-agent-sdk",
]);
export type PiProviderId = z.infer<typeof piProviderIdSchema>;

/**
 * Claude billing mode chosen in the onboarding wizard (§4.4, §4.6, §4.10).
 * Non-Claude connections use null.
 */
export const claudeBillingModeSchema = z.enum([
  "subscription-sdk",
  "extra-usage-oauth",
  "api-key",
]);
export type ClaudeBillingMode = z.infer<typeof claudeBillingModeSchema>;

export const billingSurfaceSchema = z.enum([
  "plan-quota",
  "extra-usage-per-token",
  "api-metered",
  "sdk-credit-pool",
]);
export type BillingSurface = z.infer<typeof billingSurfaceSchema>;

export const connectionHealthSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
  "setup",
]);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const agentRoleSchema = z.enum([
  "brain",
  "planner",
  "builder",
  "validator",
  "fusion",
  "scout",
  "healthcheck",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

/** Opaque presence metadata — never token material (§4.3). */
export const authStorePresenceSchema = z.strictObject({
  provider: piProviderIdSchema,
  present: z.boolean(),
  /** mtime of auth entry / store when known. */
  mtime: isoTimestampSchema.nullable(),
  /** Content hash of the presence record only (not the secret). */
  presenceHash: z.string().nullable(),
  /** Expiry hint when Pi exposes one without reading the secret. */
  expiresAt: isoTimestampSchema.nullable(),
});
export type AuthStorePresence = z.infer<typeof authStorePresenceSchema>;

export const effectiveCredentialPathSchema = z.enum([
  "auth-json",
  "env-keychain",
  "claude-code-oauth",
  "unknown",
]);
export type EffectiveCredentialPath = z.infer<typeof effectiveCredentialPathSchema>;

export const providerConnectionSchema = z.strictObject({
  id: ulidSchema,
  kind: connectionKindSchema,
  provider: piProviderIdSchema,
  /** Display label (e.g. "Claude Pro/Max"). */
  label: z.string().min(1),
  family: modelFamilySchema,
  billingSurface: billingSurfaceSchema,
  /** Claude-only; null for every other provider. */
  billingMode: claudeBillingModeSchema.nullable(),
  health: connectionHealthSchema,
  healthReason: z.string().nullable(),
  authStorePresence: authStorePresenceSchema.nullable(),
  effectiveCredentialPath: effectiveCredentialPathSchema,
  personalUseOnly: z.boolean(),
  supportedRoles: z.array(agentRoleSchema),
  /** True when LIMIT REACHED excludes this connection from casts (§4.9). */
  limitReached: z.boolean(),
  limitReachedReason: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

/**
 * Origin-keyed family registry (§6.2 rule 5 + [R6]):
 * `claude-agent-sdk/<model>` classifies as anthropic.
 */
export function familyOfModelRef(modelRef: string): ModelFamily {
  const slash = modelRef.indexOf("/");
  const origin = slash === -1 ? modelRef : modelRef.slice(0, slash);
  switch (origin) {
    case "anthropic":
    case "claude-agent-sdk":
      return "anthropic";
    case "openai":
    case "github-copilot":
      return "openai";
    case "xai":
      return "xai";
    case "google":
    case "google-gemini-cli":
    case "google-vertex":
      return "google";
    case "moonshot":
    case "kimi-coding":
      return "moonshot";
    case "mistral":
      return "mistral";
    case "deepseek":
      return "deepseek";
    case "groq":
      return "groq";
    case "openrouter": {
      // Aggregator is not a family — peel one more segment when present.
      const rest = slash === -1 ? "" : modelRef.slice(slash + 1);
      if (rest.startsWith("anthropic/")) return "anthropic";
      if (rest.startsWith("openai/")) return "openai";
      if (rest.startsWith("x-ai/") || rest.startsWith("xai/")) return "xai";
      if (rest.startsWith("google/")) return "google";
      if (rest.startsWith("moonshotai/") || rest.startsWith("moonshot/")) return "moonshot";
      if (rest.startsWith("mistralai/") || rest.startsWith("mistral/")) return "mistral";
      if (rest.startsWith("deepseek/")) return "deepseek";
      return "other";
    }
    case "vercel-ai-gateway": {
      const rest = slash === -1 ? "" : modelRef.slice(slash + 1);
      if (rest.includes("anthropic") || rest.includes("claude")) return "anthropic";
      if (rest.includes("openai") || rest.includes("gpt")) return "openai";
      if (rest.includes("moonshot") || rest.includes("kimi")) return "moonshot";
      return "other";
    }
    default:
      return "other";
  }
}

/**
 * Cross-family cast check used by resolve_cast policy (§6.2 rule 1 + R6).
 *
 * The invariant is that a validator must come from a **provably different**
 * family than its builder, so the check is never the same family marking its
 * own homework.
 *
 * `"other"` is not a family — it is *unknown origin*. Treating it as one made
 * this fail OPEN: an Anthropic model reached through an origin this table does
 * not recognise resolves to `"other"`, pairs with a real `anthropic/*`
 * validator, compares unequal, and the cast is accepted. Both seats are then
 * Anthropic and the independence the whole fusion design rests on is gone,
 * silently and with no event to show for it.
 *
 * Two unknown origins are equally unprovable — they may be one vendor under two
 * aliases — so an unknown origin on **either** side is a conflict. This matches
 * how the rest of the substrate behaves: a missing Pi raises a typed
 * `PI_UNAVAILABLE` rather than proceeding quietly, and an unknown cost renders
 * as `—` rather than `$0.00`. Refusing to certify what it cannot prove is the
 * only answer that is not a fabricated guarantee.
 *
 * The cost of failing closed is a Captain occasionally naming an explicit
 * override for a genuinely novel provider. The cost of failing open is a
 * validation that looks independent and is not.
 */
export function familiesConflict(a: string, b: string): boolean {
  const fa = familyOfModelRef(a);
  const fb = familyOfModelRef(b);
  if (fa === "other" || fb === "other") return true;
  return fa === fb;
}
