import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { assertTokenUrlAllowed } from "./allowlist.js";

/**
 * Bounded read of OAuth bearer tokens for quota probes ONLY (§4.9).
 * Tokens are never logged, never persisted elsewhere, never used for inference.
 */

export type TokenSource =
  | "pi-auth-json"
  | "claude-code-credentials"
  | "keychain"
  | "fixture";

export interface ProbeToken {
  token: string;
  source: TokenSource;
  /** Extra headers (e.g. chatgpt-account-id). */
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBearer(entry: unknown): string | null {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (!isRecord(entry)) return null;
  for (const key of ["accessToken", "access_token", "token", "apiKey", "api_key"]) {
    const v = entry[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Read a token for a probe. Caller MUST pass the destination URL for allowlist check first.
 */
export function readProbeToken(options: {
  provider: string;
  authJsonPath: string;
  url: string;
  /** Test-only fixture token (never used in production paths). */
  fixtureToken?: string;
  billingMode?: string | null;
}): ProbeToken | null {
  assertTokenUrlAllowed(options.url);

  if (options.fixtureToken !== undefined) {
    return { token: options.fixtureToken, source: "fixture", headers: {} };
  }

  // subscription-sdk: Claude Code credential store (§4.9 R6).
  if (
    options.provider === "claude-agent-sdk" ||
    (options.provider === "anthropic" && options.billingMode === "subscription-sdk")
  ) {
    const claudeCred = readClaudeCodeCredential();
    if (claudeCred !== null) return claudeCred;
  }

  if (!existsSync(options.authJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(options.authJsonPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const root = isRecord(parsed["providers"]) ? parsed["providers"] : parsed;

  const aliases: Record<string, string[]> = {
    anthropic: ["anthropic", "claude"],
    openai: ["openai", "chatgpt"],
    xai: ["xai", "grok"],
    openrouter: ["openrouter"],
    "kimi-coding": ["kimi-coding", "kimi", "moonshot"],
  };
  const keys = aliases[options.provider] ?? [options.provider];
  if (!isRecord(root)) return null;
  for (const key of keys) {
    const entry = root[key];
    const token = extractBearer(entry);
    if (token !== null) {
      const headers: Record<string, string> = {};
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

function readClaudeCodeCredential(): ProbeToken | null {
  const candidates = [
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude", "credentials.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const token = extractBearer(parsed);
      if (token !== null) {
        return { token, source: "claude-code-credentials", headers: {} };
      }
      if (isRecord(parsed) && isRecord(parsed["claudeAiOauth"])) {
        const t = extractBearer(parsed["claudeAiOauth"]);
        if (t !== null) return { token: t, source: "claude-code-credentials", headers: {} };
      }
    } catch {
      // continue
    }
  }
  return null;
}
