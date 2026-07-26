import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Cross-process Pi auth-store broker (master plan §5.9, §11 Phase 7).
 *
 * Secondmates get isolated homes, but they share ONE Pi auth store — that is
 * the whole point of the design: the Captain logs in once. Agent OS processes
 * serialise grant resolution and login exclusive windows with a lock that lives
 * beside the store rather than inside any one process.
 *
 * This orders Agent-OS-local critical sections (spawn grants, login holds)
 * across primaries and secondmates. It does not claim to wrap Pi's internal
 * multi-minute OAuth UI write atomicity; holdLoginUntilAuthSettled keeps the
 * lock until the auth store mtime advances so concurrent grants wait out that
 * window.
 *
 * The in-process `PiAuthBroker` remains correct for intra-process ordering;
 * this sits underneath it and is the only thing that can order a primary
 * against a secondmate.
 *
 * Liveness: the lock records the holding pid. A lock whose holder is gone is
 * reclaimed, because a crashed daemon must not wedge the Captain's fleet
 * forever — but a lock held by a LIVE pid is never stolen, however old.
 */

const LOCK_FILE = "auth-broker.lock";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
/** A lock older than this whose holder is gone is treated as abandoned. */
const STALE_AFTER_MS = 120_000;

export interface BrokerLockInfo {
  pid: number;
  acquiredAt: number;
  purpose: string;
}

export class AuthBrokerTimeoutError extends Error {
  readonly code = "AUTH_BROKER_TIMEOUT" as const;

  constructor(
    message: string,
    readonly holder: BrokerLockInfo | null,
  ) {
    super(message);
    this.name = "AuthBrokerTimeoutError";
  }
}

export class CrossProcessAuthBroker {
  private readonly lockPath: string;

  /**
   * @param authStoreDir directory containing the shared Pi auth store. The lock
   * lives beside it so every process that can reach the store can see the lock.
   */
  constructor(authStoreDir: string) {
    mkdirSync(authStoreDir, { recursive: true, mode: 0o700 });
    this.lockPath = join(authStoreDir, LOCK_FILE);
  }

  /** Current holder, or null when free. Diagnostic only — never a gate. */
  holder(): BrokerLockInfo | null {
    if (!existsSync(this.lockPath)) return null;
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8")) as BrokerLockInfo;
    } catch {
      return null;
    }
  }

  /**
   * Run `fn` while holding the exclusive auth lock across every Agent OS
   * process on this machine. Blocks until acquired or the timeout elapses.
   */
  async withAuthLock<T>(
    purpose: string,
    fn: () => Promise<T>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    await this.acquire(purpose, timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Non-blocking attempt; returns false when another process holds it. */
  tryAcquire(purpose: string): boolean {
    if (this.writeLock(purpose)) return true;
    if (this.reclaimIfAbandoned()) {
      return this.writeLock(purpose);
    }
    return false;
  }

  release(): void {
    const info = this.holder();
    // Only the holder may release — a stray release from another process would
    // hand the store to a third while the real holder is mid-write. An
    // unreadable/corrupt lock is treated as "not mine" and must not be removed.
    if (info === null || info.pid !== process.pid) return;
    try {
      rmSync(this.lockPath, { force: true });
    } catch {
      // best-effort
    }
  }

  private async acquire(purpose: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.tryAcquire(purpose)) return;
      if (Date.now() >= deadline) {
        throw new AuthBrokerTimeoutError(
          `timed out waiting ${timeoutMs}ms for the Pi auth lock`,
          this.holder(),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /** Exclusive create — write metadata through the exclusive fd (no empty window). */
  private writeLock(purpose: string): boolean {
    let fd: number | null = null;
    let created = false;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
      created = true;
      const info: BrokerLockInfo = {
        pid: process.pid,
        acquiredAt: Date.now(),
        purpose,
      };
      writeSync(fd, `${JSON.stringify(info)}\n`);
      try {
        fsyncSync(fd);
      } catch {
        // some platforms/tmpfs ignore fsync
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      // Post-create write failure: remove the orphan lock so auth is not wedged
      // for STALE_AFTER_MS (holder() is null; release would refuse).
      if (created) {
        try {
          rmSync(this.lockPath, { force: true });
        } catch {
          // best-effort
        }
      }
      throw error;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Reclaim a lock whose holder is gone. A live holder is never displaced,
   * regardless of age — waiting is always safer than two writers.
   */
  private reclaimIfAbandoned(): boolean {
    const info = this.holder();
    if (info === null) {
      // Unreadable or empty lock file: only reclaim once it is clearly stale.
      return this.removeIfOlderThan(STALE_AFTER_MS);
    }
    if (isProcessAlive(info.pid)) return false;
    try {
      rmSync(this.lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private removeIfOlderThan(ms: number): boolean {
    try {
      const stat = existsSync(this.lockPath) ? statSync(this.lockPath) : null;
      if (stat === null) return true;
      if (Date.now() - stat.mtimeMs < ms) return false;
      rmSync(this.lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
