import { existsSync, readFileSync } from "node:fs";
import type { ConnectionKind } from "@agent-os/protocol";
import { readApiKeyFile } from "../pi/connections.js";
import { readClaudeCodeCredential as readClaudeCodeCredentialFile } from "../security/claude-code-credentials.js";
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
 * When multiple auth.json paths are provided, try managed then shared per provider.
 */
export function readProbeToken(options: {
  provider: string;
  authJsonPath: string;
  /** Ordered auth.json candidates (managed then shared). Falls back to authJsonPath. */
  authJsonPaths?: string[];
  url: string;
  /** Test-only fixture token (never used in production paths). */
  fixtureToken?: string;
  billingMode?: string | null;
  /** Connection kind — api-key custody uses AGENTOS_HOME/secrets. */
  connectionKind?: ConnectionKind;
  /** AGENTOS_HOME for secrets/<provider>.key reads. */
  agentosHome?: string;
  /** Provider id used for secrets path (connection.provider, not allowlist alias). */
  secretsProvider?: string;
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
    const claudeCred = readClaudeCodeCredentialFile();
    if (claudeCred !== null) {
      return { token: claudeCred.token, source: "claude-code-credentials", headers: {} };
    }
  }

  // API-key connections: secrets written by writeApiKeyFile (env-keychain custody).
  if (
    options.connectionKind === "pi-api-key" &&
    options.agentosHome !== undefined &&
    options.agentosHome.length > 0
  ) {
    const secretsProvider = options.secretsProvider ?? options.provider;
    const apiKey = readApiKeyFile(options.agentosHome, secretsProvider);
    if (apiKey !== null && apiKey.length > 0) {
      return { token: apiKey, source: "keychain", headers: {} };
    }
  }

  const paths =
    options.authJsonPaths !== undefined && options.authJsonPaths.length > 0
      ? options.authJsonPaths
      : [options.authJsonPath];
  for (const authJsonPath of paths) {
    const fromStore = readTokenFromAuthJson(authJsonPath, options.provider);
    if (fromStore !== null) return fromStore;
  }
  return null;
}

function readTokenFromAuthJson(authJsonPath: string, provider: string): ProbeToken | null {
  if (!existsSync(authJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authJsonPath, "utf8"));
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
  const keys = aliases[provider] ?? [provider];
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


