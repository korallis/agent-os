import type { ClaudeBillingMode, PiProviderId, QuotaConfig } from "@agent-os/protocol";
import type { ConfigService } from "../config/service.js";

export type QuotaProviderKey = keyof QuotaConfig["providers"];

/**
 * Map a Pi / connection provider id to quota.json5 provider keys (config #14).
 * Providers without a probe surface return an empty list.
 */
export function quotaKeysForProvider(
  provider: PiProviderId | string,
  billingMode?: ClaudeBillingMode | null,
): QuotaProviderKey[] {
  switch (provider) {
    case "anthropic":
      return billingMode === "subscription-sdk"
        ? ["anthropic", "claude-agent-sdk"]
        : ["anthropic"];
    case "claude-agent-sdk":
      return ["claude-agent-sdk", "anthropic"];
    case "openai":
      return ["openai"];
    case "xai":
      return ["xai"];
    case "openrouter":
      return ["openrouter"];
    case "kimi-coding":
      return ["kimi-coding"];
    case "vercel-ai-gateway":
      return ["vercel-ai-gateway"];
    default:
      return [];
  }
}

/**
 * Flip quota.json5 providers.*.enabled=true for the given providers (R5.1).
 * xAI always gets bestEffortAllowed=true when enabled. Idempotent and
 * individually toggleable afterward via Policies / writeGlobal.
 */
export function enableQuotaProviders(
  config: ConfigService,
  providers: Iterable<{ provider: PiProviderId | string; billingMode?: ClaudeBillingMode | null }>,
): void {
  const keys = new Set<QuotaProviderKey>();
  for (const entry of providers) {
    for (const key of quotaKeysForProvider(entry.provider, entry.billingMode ?? null)) {
      keys.add(key);
    }
  }
  if (keys.size === 0) return;

  const existingRaw = config.layerValue("global", "quota");
  const base =
    typeof existingRaw === "object" && existingRaw !== null && !Array.isArray(existingRaw)
      ? { ...(existingRaw as Record<string, unknown>) }
      : {};
  const existingProviders =
    typeof base["providers"] === "object" &&
    base["providers"] !== null &&
    !Array.isArray(base["providers"])
      ? { ...(base["providers"] as Record<string, unknown>) }
      : {};

  const effective = config.config.quota.providers;
  const nextProviders: Record<string, { enabled: boolean; bestEffortAllowed: boolean }> = {
    ...Object.fromEntries(
      Object.entries(effective).map(([key, value]) => [
        key,
        { enabled: value.enabled, bestEffortAllowed: value.bestEffortAllowed },
      ]),
    ),
  };

  let changed = false;
  for (const key of keys) {
    const current = nextProviders[key] ?? effective[key];
    const bestEffortAllowed = key === "xai" ? true : current.bestEffortAllowed;
    if (current.enabled === true && current.bestEffortAllowed === bestEffortAllowed) {
      continue;
    }
    nextProviders[key] = { enabled: true, bestEffortAllowed };
    changed = true;
  }
  if (!changed) return;

  config.writeGlobal(
    "quota",
    JSON.stringify(
      {
        ...base,
        providers: {
          ...existingProviders,
          ...nextProviders,
        },
      },
      null,
      2,
    ),
  );
}
