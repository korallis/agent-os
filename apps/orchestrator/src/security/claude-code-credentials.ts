import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code credential store reads for subscription-sdk path (§4.9 R6).
 * Requires an extractable bearer — empty/corrupt/non-OAuth files do not count.
 */

export interface ClaudeCodeCredential {
  token: string;
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

export function readClaudeCodeCredential(): ClaudeCodeCredential | null {
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
        return { token };
      }
      if (isRecord(parsed) && isRecord(parsed["claudeAiOauth"])) {
        const t = extractBearer(parsed["claudeAiOauth"]);
        if (t !== null) return { token: t };
      }
    } catch {
      // continue
    }
  }
  return null;
}

/** True when Claude Code credentials yield an extractable bearer (not mere file existence). */
export function hasReadableClaudeCodeCredential(): boolean {
  return readClaudeCodeCredential() !== null;
}
