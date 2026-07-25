import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
export function resolvePiAuthPaths(managedHome) {
    const piHome = managedHome ?? join(homedir(), ".pi");
    return {
        piHome,
        authJsonPath: join(piHome, "agent", "auth.json"),
    };
}
/**
 * Ordered auth.json paths for probe token reads: managed first, then shared ~/.pi.
 * Never all-or-nothing on "managed has any entry" — partial multi-provider
 * migration keeps credentials reachable in either store.
 */
export function resolveAuthJsonPathsWithFallback(managedHome) {
    const shared = resolvePiAuthPaths(null).authJsonPath;
    if (managedHome === null)
        return [shared];
    const managed = resolvePiAuthPaths(managedHome).authJsonPath;
    if (managed === shared)
        return [managed];
    return [managed, shared];
}
/**
 * Primary auth.json path (managed when set, else shared). Prefer
 * resolveAuthJsonPathsWithFallback for probe token reads.
 */
export function resolveAuthJsonPathWithFallback(managedHome) {
    return resolveAuthJsonPathsWithFallback(managedHome)[0] ?? resolvePiAuthPaths(null).authJsonPath;
}
/**
 * Union presence across managed + shared stores. Managed wins on the same provider.
 */
export function readAuthStorePresenceUnion(managedHome) {
    const paths = resolveAuthJsonPathsWithFallback(managedHome);
    const byProvider = new Map();
    // Apply shared first, then managed so managed overwrites on collision.
    for (let i = paths.length - 1; i >= 0; i--) {
        const path = paths[i];
        if (path === undefined)
            continue;
        for (const entry of readAuthStorePresence(path)) {
            byProvider.set(entry.provider, entry);
        }
    }
    return [...byProvider.values()];
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Read presence metadata only. Does not return tokens.
 * Returns empty list when the store is missing.
 */
export function readAuthStorePresence(authJsonPath) {
    if (!existsSync(authJsonPath))
        return [];
    let mtime = null;
    try {
        mtime = statSync(authJsonPath).mtime.toISOString();
    }
    catch {
        mtime = null;
    }
    let raw;
    try {
        raw = readFileSync(authJsonPath, "utf8");
    }
    catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!isRecord(parsed))
        return [];
    // Pi layouts vary: top-level providers map, or { providers: { ... } }.
    const root = isRecord(parsed["providers"])
        ? parsed["providers"]
        : parsed;
    const results = [];
    for (const [key, value] of Object.entries(root)) {
        if (key === "version" || key === "providers")
            continue;
        if (!isRecord(value) && typeof value !== "string")
            continue;
        const provider = normalizeProviderId(key);
        if (provider === null)
            continue;
        // Presence hash from structure keys only — never from token substrings.
        const structure = isRecord(value)
            ? JSON.stringify({
                keys: Object.keys(value).sort(),
                hasAccessToken: "accessToken" in value || "access_token" in value || "token" in value,
                type: typeof value["type"] === "string" ? value["type"] : null,
            })
            : "string-entry";
        const presenceHash = createHash("sha256").update(`${key}:${structure}`).digest("hex").slice(0, 16);
        let expiresAt = null;
        if (isRecord(value)) {
            const exp = value["expiresAt"] ?? value["expires_at"] ?? value["expiry"];
            if (typeof exp === "string")
                expiresAt = exp;
            else if (typeof exp === "number")
                expiresAt = new Date(exp * 1000).toISOString();
        }
        results.push({
            provider,
            present: true,
            mtime,
            presenceHash,
            expiresAt,
        });
    }
    return results;
}
function normalizeProviderId(key) {
    const map = {
        anthropic: "anthropic",
        claude: "anthropic",
        openai: "openai",
        chatgpt: "openai",
        google: "google",
        xai: "xai",
        grok: "xai",
        openrouter: "openrouter",
        "github-copilot": "github-copilot",
        copilot: "github-copilot",
        "amazon-bedrock": "amazon-bedrock",
        "azure-openai-responses": "azure-openai-responses",
        "google-gemini-cli": "google-gemini-cli",
        "google-vertex": "google-vertex",
        "vercel-ai-gateway": "vercel-ai-gateway",
        zai: "zai",
        opencode: "opencode",
        "kimi-coding": "kimi-coding",
        kimi: "kimi-coding",
        minimax: "minimax",
        "minimax-cn": "minimax-cn",
        "claude-agent-sdk": "claude-agent-sdk",
    };
    return map[key.toLowerCase()] ?? null;
}
/**
 * fs-audit helper: assert Agent OS never wrote auth.json.
 * Callers pass the set of paths this process has opened for write.
 */
export function assertAuthStoreNotWritten(authJsonPath, writtenPaths) {
    if (writtenPaths.has(authJsonPath)) {
        throw new Error(`SECURITY: Agent OS must never write ${authJsonPath}`);
    }
}
