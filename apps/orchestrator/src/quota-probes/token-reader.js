import { existsSync, readFileSync } from "node:fs";
import { readApiKeyFile } from "../pi/connections.js";
import { readClaudeCodeCredential as readClaudeCodeCredentialFile } from "../security/claude-code-credentials.js";
import { assertTokenUrlAllowed } from "./allowlist.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractBearer(entry) {
    if (typeof entry === "string" && entry.length > 0)
        return entry;
    if (!isRecord(entry))
        return null;
    for (const key of ["accessToken", "access_token", "token", "apiKey", "api_key"]) {
        const v = entry[key];
        if (typeof v === "string" && v.length > 0)
            return v;
    }
    return null;
}
/**
 * Read a token for a probe. Caller MUST pass the destination URL for allowlist check first.
 * When multiple auth.json paths are provided, try managed then shared per provider.
 */
export function readProbeToken(options) {
    assertTokenUrlAllowed(options.url);
    if (options.fixtureToken !== undefined) {
        return { token: options.fixtureToken, source: "fixture", headers: {} };
    }
    // subscription-sdk: Claude Code credential store (§4.9 R6).
    if (options.provider === "claude-agent-sdk" ||
        (options.provider === "anthropic" && options.billingMode === "subscription-sdk")) {
        const claudeCred = readClaudeCodeCredentialFile();
        if (claudeCred !== null) {
            return { token: claudeCred.token, source: "claude-code-credentials", headers: {} };
        }
    }
    // API-key connections: secrets written by writeApiKeyFile (env-keychain custody).
    if (options.connectionKind === "pi-api-key" &&
        options.agentosHome !== undefined &&
        options.agentosHome.length > 0) {
        const secretsProvider = options.secretsProvider ?? options.provider;
        const apiKey = readApiKeyFile(options.agentosHome, secretsProvider);
        if (apiKey !== null && apiKey.length > 0) {
            return { token: apiKey, source: "keychain", headers: {} };
        }
    }
    const paths = options.authJsonPaths !== undefined && options.authJsonPaths.length > 0
        ? options.authJsonPaths
        : [options.authJsonPath];
    for (const authJsonPath of paths) {
        const fromStore = readTokenFromAuthJson(authJsonPath, options.provider);
        if (fromStore !== null)
            return fromStore;
    }
    return null;
}
function readTokenFromAuthJson(authJsonPath, provider) {
    if (!existsSync(authJsonPath))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(authJsonPath, "utf8"));
    }
    catch {
        return null;
    }
    if (!isRecord(parsed))
        return null;
    const root = isRecord(parsed["providers"]) ? parsed["providers"] : parsed;
    const aliases = {
        anthropic: ["anthropic", "claude"],
        openai: ["openai", "chatgpt"],
        xai: ["xai", "grok"],
        openrouter: ["openrouter"],
        "kimi-coding": ["kimi-coding", "kimi", "moonshot"],
    };
    const keys = aliases[provider] ?? [provider];
    if (!isRecord(root))
        return null;
    for (const key of keys) {
        const entry = root[key];
        const token = extractBearer(entry);
        if (token !== null) {
            const headers = {};
            if (isRecord(entry)) {
                const accountId = entry["accountId"] ?? entry["chatgpt-account-id"] ?? entry["account_id"];
                if (typeof accountId === "string") {
                    headers["chatgpt-account-id"] = accountId;
                }
            }
            return { token, source: "pi-auth-json", headers };
        }
    }
    return null;
}
