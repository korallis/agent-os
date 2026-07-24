import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type PathLike,
} from "node:fs";
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
  lockPath: string;
  logFile: string;
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    configDir: join(home, "config"),
    eventsDir: join(home, "events"),
    logsDir: join(home, "logs"),
    tokenPath: join(home, "daemon.token"),
    lockPath: join(home, "daemon.lock"),
    logFile: join(home, "logs", "agentosd.ndjson"),
  };
}

/** Fail-fast when another agentosd already holds `AGENTOS_HOME`. */
export class HomeLockError extends Error {
  readonly code = "HOME_LOCKED" as const;

  constructor(
    message: string,
    readonly home: string,
    readonly lockPath: string,
    readonly holderPid: number | null,
  ) {
    super(message);
    this.name = "HomeLockError";
  }
}

export interface HomeLock {
  path: string;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath: PathLike): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const first = raw.split(/\s+/)[0];
    if (first === undefined || first.length === 0) return null;
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Exclusive single-writer lock for `AGENTOS_HOME` (master plan `daemon.lock`).
 * Uses O_EXCL create + PID so a second process fails fast; stale locks from
 * dead holders are reclaimed. The fd is held open for the process lifetime.
 */
export function acquireHomeLock(home: string): HomeLock {
  const { lockPath } = homePaths(home);
  const tryOpenExclusive = (): number => openSync(lockPath, "wx", 0o600);

  let fd: number;
  try {
    fd = tryOpenExclusive();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const holderPid = readLockPid(lockPath);
    if (holderPid !== null && isProcessAlive(holderPid)) {
      throw new HomeLockError(
        `AGENTOS_HOME already in use by agentosd pid ${holderPid} (lock: ${lockPath})`,
        home,
        lockPath,
        holderPid,
      );
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // concurrent reclaim — fall through to exclusive open
    }
    try {
      fd = tryOpenExclusive();
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
        const retryPid = readLockPid(lockPath);
        throw new HomeLockError(
          `AGENTOS_HOME already in use${retryPid !== null ? ` by agentosd pid ${retryPid}` : ""} (lock: ${lockPath})`,
          home,
          lockPath,
          retryPid,
        );
      }
      throw retryError;
    }
  }

  writeSync(fd, `${process.pid}\n`);
  try {
    chmodSync(lockPath, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        const current = readLockPid(lockPath);
        if (current === process.pid || current === null) {
          unlinkSync(lockPath);
        }
      } catch {
        // lock file already gone
      }
    },
  };
}

function writeToken(tokenPath: string): void {
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

/** Creates the home tree (0700) and the daemon bearer token (0600) if missing. */
export function ensureHome(home: string): HomePaths {
  const paths = homePaths(home);
  for (const dir of [paths.home, paths.configDir, paths.eventsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  if (!existsSync(paths.tokenPath)) {
    writeToken(paths.tokenPath);
  } else {
    const existing = readFileSync(paths.tokenPath, "utf8").trim();
    if (existing.length === 0) {
      writeToken(paths.tokenPath);
    } else {
      chmodSync(paths.tokenPath, 0o600);
    }
  }
  return paths;
}

export function readToken(home: string): string {
  return readFileSync(homePaths(home).tokenPath, "utf8").trim();
}
