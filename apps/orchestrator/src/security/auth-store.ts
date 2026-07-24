import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthStorePresence, PiProviderId } from "@agent-os/protocol";

/**
 * Opaque Pi auth-store presence reads (master plan §4.3).
 * Agent OS never opens auth.json for write. Only presence metadata +
 * bounded quota-probe token reads (see quota-probes/token-reader.ts).
 */

export interface AuthStorePaths {
  /** Directory that should contain agent/auth.json. */
  piHome: string;
  authJsonPath: string;
}

export function resolvePiAuthPaths(managedHome: string | null): AuthStorePaths {
  const piHome = managedHome ?? join(homedir(), ".pi");
  return {
    piHome,
    authJsonPath: join(piHome, "agent", "auth.json"),
  };
}

/**
 * Prefer managed auth.json when it has presence; otherwise fall back to shared ~/.pi.
 * Mirrors listDetectedProviders so OAuth probes and detection agree on the store.
 */
export function resolveAuthJsonPathWithFallback(managedHome: string | null): string {
  const managed = resolvePiAuthPaths(managedHome);
  if (readAuthStorePresence(managed.authJsonPath).length > 0) {
    return managed.authJsonPath;
  }
  const shared = resolvePiAuthPaths(null);
  return shared.authJsonPath;
}

/** Shape we accept from Pi's auth.json without claiming full fidelity. */
interface AuthJsonShape {
  [provider: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read presence metadata only. Does not return tokens.
 * Returns empty list when the store is missing.
 */
export function readAuthStorePresence(authJsonPath: string): AuthStorePresence[] {
  if (!existsSync(authJsonPath)) return [];

  let mtime: string | null = null;
  try {
    mtime = statSync(authJsonPath).mtime.toISOString();
  } catch {
    mtime = null;
  }

  let raw: string;
  try {
    raw = readFileSync(authJsonPath, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];

  // Pi layouts vary: top-level providers map, or { providers: { ... } }.
  const root: AuthJsonShape = isRecord(parsed["providers"])
    ? (parsed["providers"] as AuthJsonShape)
    : parsed;

  const results: AuthStorePresence[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key === "version" || key === "providers") continue;
    if (!isRecord(value) && typeof value !== "string") continue;
    const provider = normalizeProviderId(key);
    if (provider === null) continue;

    // Presence hash from structure keys only — never from token substrings.
    const structure = isRecord(value)
      ? JSON.stringify({
          keys: Object.keys(value).sort(),
          hasAccessToken: "accessToken" in value || "access_token" in value || "token" in value,
          type: typeof value["type"] === "string" ? value["type"] : null,
        })
      : "string-entry";
    const presenceHash = createHash("sha256").update(`${key}:${structure}`).digest("hex").slice(0, 16);

    let expiresAt: string | null = null;
    if (isRecord(value)) {
      const exp = value["expiresAt"] ?? value["expires_at"] ?? value["expiry"];
      if (typeof exp === "string") expiresAt = exp;
      else if (typeof exp === "number") expiresAt = new Date(exp * 1000).toISOString();
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

function normalizeProviderId(key: string): PiProviderId | null {
  const map: Record<string, PiProviderId> = {
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
export function assertAuthStoreNotWritten(
  authJsonPath: string,
  writtenPaths: ReadonlySet<string>,
): void {
  if (writtenPaths.has(authJsonPath)) {
    throw new Error(`SECURITY: Agent OS must never write ${authJsonPath}`);
  }
}
