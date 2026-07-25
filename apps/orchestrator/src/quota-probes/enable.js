/**
 * Map a Pi / connection provider id to quota.json5 provider keys (config #14).
 * Providers without a probe surface return an empty list.
 */
export function quotaKeysForProvider(provider, billingMode) {
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
            return [];
        default:
            return [];
    }
}
/**
 * Flip quota.json5 providers.*.enabled=true for the given providers (R5.1).
 * xAI always gets bestEffortAllowed=true when enabled. Idempotent and
 * individually toggleable afterward via Policies / writeGlobal.
 * @returns true when at least one requested provider is enabled after the call
 *   (either newly flipped or already enabled).
 */
export function enableQuotaProviders(config, providers) {
    const keys = new Set();
    for (const entry of providers) {
        for (const key of quotaKeysForProvider(entry.provider, entry.billingMode ?? null)) {
            keys.add(key);
        }
    }
    if (keys.size === 0)
        return false;
    const existingRaw = config.layerValue("global", "quota");
    const base = typeof existingRaw === "object" && existingRaw !== null && !Array.isArray(existingRaw)
        ? { ...existingRaw }
        : {};
    const existingProviders = typeof base["providers"] === "object" &&
        base["providers"] !== null &&
        !Array.isArray(base["providers"])
        ? { ...base["providers"] }
        : {};
    const effective = config.config.quota.providers;
    // Partial global overlay: only write keys that actually flip so deep-merge
    // keeps shipped defaults for untouched providers.
    const flipped = {};
    let changed = false;
    let anyEnabled = false;
    for (const key of keys) {
        const current = effective[key];
        const bestEffortAllowed = key === "xai" ? true : current.bestEffortAllowed;
        if (current.enabled === true && current.bestEffortAllowed === bestEffortAllowed) {
            anyEnabled = true;
            continue;
        }
        flipped[key] = { enabled: true, bestEffortAllowed };
        changed = true;
        anyEnabled = true;
    }
    if (!changed)
        return anyEnabled;
    config.writeGlobal("quota", JSON.stringify({
        ...base,
        providers: {
            ...existingProviders,
            ...flipped,
        },
    }, null, 2));
    return anyEnabled;
}
