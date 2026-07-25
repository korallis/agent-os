import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
  // Secondmates (and tests) may place the token outside AGENTOS_HOME so the
  // audited secondmate tree stays free of auth material while bearings still auth.
  const tokenOverride = process.env.AGENTOS_TOKEN_PATH;
  const tokenPath =
    tokenOverride !== undefined && tokenOverride.length > 0
      ? tokenOverride
      : join(home, "daemon.token");
  return {
    home,
    configDir: join(home, "config"),
    eventsDir: join(home, "events"),
    logsDir: join(home, "logs"),
    tokenPath,
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
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

/** Brief busy-wait (no async) so a concurrent creator can finish writing its PID. */
function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Create `lockPath` with full PID content atomically (write temp → hard link).
 * Falls back to O_EXCL open when link is unavailable. Returns an open fd held
 * for the process lifetime.
 */
function tryCreateLock(lockPath: string): number {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    try {
      fsyncSync(fd);
    } catch {
      // some platforms/tmpfs ignore fsync
    }
    try {
      linkSync(tmp, lockPath);
    } catch (linkError) {
      const linkCode = (linkError as NodeJS.ErrnoException).code;
      if (linkCode === "EEXIST") {
        throw linkError;
      }
      // Filesystems without hard links: exclusive create then write (content
      // may briefly be empty; waiters poll before treating null PID as stale).
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      const excl = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(excl, `${process.pid}\n`);
        try {
          fsyncSync(excl);
        } catch {
          // ignore
        }
        return excl;
      } catch (writeError) {
        try {
          closeSync(excl);
        } catch {
          // ignore
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        throw writeError;
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort: lockPath hard-link remains
    }
    return fd;
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

const LOCK_PID_GRACE_MS = 250;
const LOCK_PID_POLL_MS = 25;

/**
 * Exclusive single-writer lock for `AGENTOS_HOME` (master plan `daemon.lock`).
 * Creates the lock with full PID content (hard-link or O_EXCL), holds the fd
 * open for the process lifetime, and reclaims only when the holder PID is gone
 * (or still unreadable after a short grace for in-flight writers). Reclaim is
 * always guarded by a second exclusive create after unlink.
 */
export function acquireHomeLock(home: string): HomeLock {
  const { lockPath } = homePaths(home);

  const acquireOrNull = (): number | null => {
    try {
      return tryCreateLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  };

  let fd = acquireOrNull();
  if (fd === null) {
    const deadline = Date.now() + LOCK_PID_GRACE_MS;
    let holderPid: number | null = readLockPid(lockPath);
    while (holderPid === null && Date.now() < deadline) {
      sleepMs(LOCK_PID_POLL_MS);
      holderPid = readLockPid(lockPath);
    }

    if (holderPid !== null && isProcessAlive(holderPid)) {
      throw new HomeLockError(
        `AGENTOS_HOME already in use by agentosd pid ${holderPid} (lock: ${lockPath})`,
        home,
        lockPath,
        holderPid,
      );
    }

    // Holder dead, or PID still unreadable after grace — reclaim carefully.
    try {
      unlinkSync(lockPath);
    } catch {
      // concurrent reclaim or already gone
    }
    fd = acquireOrNull();
    if (fd === null) {
      const retryPid = readLockPid(lockPath);
      throw new HomeLockError(
        `AGENTOS_HOME already in use${retryPid !== null ? ` by agentosd pid ${retryPid}` : ""} (lock: ${lockPath})`,
        home,
        lockPath,
        retryPid,
      );
    }
  }

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

/** Creates the home directory tree (0700). Token creation is separate (`ensureDaemonToken`). */
export function ensureHome(home: string): HomePaths {
  const paths = homePaths(home);
  for (const dir of [paths.home, paths.configDir, paths.eventsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return paths;
}

/**
 * Create or read `daemon.token` (0600). Must run while holding `acquireHomeLock`
 * for this home. Missing files use exclusive create (`wx`); empty files are rewritten.
 */
export function ensureDaemonToken(home: string): string {
  const { tokenPath } = homePaths(home);
  mkdirSync(join(tokenPath, ".."), { recursive: true, mode: 0o700 });

  if (!existsSync(tokenPath)) {
    const token = randomBytes(32).toString("hex");
    try {
      const fd = openSync(tokenPath, "wx", 0o600);
      try {
        writeSync(fd, token);
        try {
          fsyncSync(fd);
        } catch {
          // some platforms/tmpfs ignore fsync
        }
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        // best-effort on platforms that ignore mode
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const existing = readFileSync(tokenPath, "utf8").trim();
  if (existing.length === 0) {
    const token = randomBytes(32).toString("hex");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // best-effort
    }
    return token;
  }
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort
  }
  return existing;
}

export function readToken(home: string): string {
  return readFileSync(homePaths(home).tokenPath, "utf8").trim();
}
