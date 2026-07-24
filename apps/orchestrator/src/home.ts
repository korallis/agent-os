import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `~/.agentos/` — the durable state home (master plan §9).
 * `AGENTOS_HOME` overrides for tests/fixtures; permissions 0700/0600.
 */

export function resolveHome(): string {
  const override = process.env.AGENTOS_HOME;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".agentos");
}

export interface HomePaths {
  home: string;
  configDir: string;
  eventsDir: string;
  logsDir: string;
  tokenPath: string;
  logFile: string;
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    configDir: join(home, "config"),
    eventsDir: join(home, "events"),
    logsDir: join(home, "logs"),
    tokenPath: join(home, "daemon.token"),
    logFile: join(home, "logs", "agentosd.ndjson"),
  };
}

/** Creates the home tree (0700) and the daemon bearer token (0600) if missing. */
export function ensureHome(home: string): HomePaths {
  const paths = homePaths(home);
  for (const dir of [paths.home, paths.configDir, paths.eventsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(paths.tokenPath)) {
    writeFileSync(paths.tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return paths;
}

export function readToken(home: string): string {
  return readFileSync(homePaths(home).tokenPath, "utf8").trim();
}
