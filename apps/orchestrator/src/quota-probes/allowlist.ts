/**
 * Baked-in probe endpoint allowlist (master plan §4.9 / §10.2 #1).
 * Config must NEVER supply probe URLs — that would be an exfiltration vector.
 */

export interface ProbeEndpoint {
  provider: string;
  method: "GET";
  /** Exact origin + path prefix; no query-string wildcards for host. */
  url: string;
  tier: "live" | "best-effort";
  sourceLabel: string;
}

export const PROBE_ALLOWLIST: readonly ProbeEndpoint[] = [
  {
    provider: "anthropic",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    tier: "live",
    sourceLabel: "OAUTH",
  },
  {
    provider: "openai",
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    tier: "live",
    sourceLabel: "OAUTH",
  },
  {
    provider: "openrouter",
    method: "GET",
    url: "https://openrouter.ai/api/v1/credits",
    tier: "live",
    sourceLabel: "API KEY",
  },
  {
    provider: "openrouter",
    method: "GET",
    url: "https://openrouter.ai/api/v1/key",
    tier: "live",
    sourceLabel: "API KEY",
  },
  {
    provider: "kimi-coding",
    method: "GET",
    url: "https://api.moonshot.ai/v1/users/me/balance",
    tier: "live",
    sourceLabel: "API KEY",
  },
  {
    provider: "xai",
    method: "GET",
    // Undocumented consumer endpoint — best-effort, feature-flagged.
    url: "https://grok.x.ai/api/usage",
    tier: "best-effort",
    sourceLabel: "CONSUMER",
  },
] as const;

const ALLOWED_URLS = new Set(PROBE_ALLOWLIST.map((e) => e.url));

/** Returns true only if the URL is on the code-baked allowlist. */
export function isProbeUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Normalize: strip hash; compare origin+pathname.
    const normalized = `${parsed.origin}${parsed.pathname}`;
    if (ALLOWED_URLS.has(normalized)) return true;
    // Allow exact match including original form.
    return ALLOWED_URLS.has(url);
  } catch {
    return false;
  }
}

/**
 * Assert a bearer token is only sent to an allowlisted URL.
 * Used by the token-read boundary fuzz gate.
 */
export function assertTokenUrlAllowed(url: string): void {
  if (!isProbeUrlAllowed(url)) {
    throw new Error(`PROBE_URL_DENIED: bearer tokens may not be sent to ${url}`);
  }
}
