import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Server-side daemon access for the loopback BFF (master plan §8.1).
 * The bearer token is read from `~/.agentos/daemon.token` on the server and
 * NEVER shipped to the browser — route handlers attach it outbound only.
 */

export function agentosHome(): string {
  const override = process.env.AGENTOS_HOME;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".agentos");
}

export function daemonBaseUrl(): string {
  const port = process.env.AGENTOS_PORT ?? "4700";
  return `http://127.0.0.1:${port}`;
}

export function daemonToken(): string | null {
  try {
    return readFileSync(join(agentosHome(), "daemon.token"), "utf8").trim();
  } catch {
    return null;
  }
}
