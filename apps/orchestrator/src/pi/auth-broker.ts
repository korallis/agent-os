import type { PiAuthBrokerMode } from "@agent-os/protocol";
import {
  AuthBrokerTimeoutError,
  CrossProcessAuthBroker,
} from "./cross-process-broker.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Pi auth broker locks (master plan §4.5).
 *
 * Single choke point for every production path that touches Agent-OS-local grant
 * resolution and login exclusive windows. In-process ordering (login queue /
 * strict-serial) sits on top of the cross-process lock so primaries and
 * secondmates cannot race grant resolution against each other.
 *
 * What is serialised:
 *   - withSpawnGrant: reading/resolving provider grants for a spawn (Agent-OS-local)
 *   - withLoginLock / holdLoginUntilAuthSettled: exclusive login windows so two
 *     Agent OS processes do not interleave grant resolution with a live login
 *
 * What is not claimed: Pi's multi-minute interactive OAuth UI runs in a separate
 * process after the attach command is minted. holdLoginUntilAuthSettled keeps
 * the cross-process lock held until the shared auth store's mtime advances (or
 * a bounded timeout), so concurrent spawn grants wait out that window. The lock
 * cannot observe Pi's internal write atomicity — only Agent-OS-side mutual
 * exclusion around the store directory.
 */

/** Default hold for an interactive OAuth login window. */
const LOGIN_HOLD_TIMEOUT_MS = 5 * 60_000;
const LOGIN_HOLD_POLL_MS = 250;
/**
 * Spawn grants must wait out a full interactive login hold plus skew so a
 * concurrent OAuth cannot fail them with AUTH_BROKER_TIMEOUT at 30s.
 * Derived from LOGIN_HOLD_TIMEOUT_MS — do not hard-code a shorter bound.
 */
const SPAWN_GRANT_TIMEOUT_MS = LOGIN_HOLD_TIMEOUT_MS + 5_000;

export class PiAuthBroker {
  private mode: PiAuthBrokerMode = "concurrent";
  private loginHeld = false;
  private readonly queue: Array<() => void> = [];
  private serialChain: Promise<void> = Promise.resolve();
  private readonly crossProcess: CrossProcessAuthBroker;
  private readonly authStoreDir: string;
  private loginHoldInFlight: Promise<void> | null = null;

  /**
   * @param authStoreDir directory containing the shared Pi auth store
   *   (typically `<managedPiHome>/agent`). The cross-process lock lives beside it.
   */
  constructor(authStoreDir: string) {
    this.authStoreDir = authStoreDir;
    this.crossProcess = new CrossProcessAuthBroker(authStoreDir);
  }

  /** Build the broker for a managed Pi home (`…/pi` → lock under `…/pi/agent`). */
  static forManagedHome(managedPiHome: string): PiAuthBroker {
    return new PiAuthBroker(join(managedPiHome, "agent"));
  }

  getMode(): PiAuthBrokerMode {
    return this.mode;
  }

  /** Cross-process lock handle (tests / diagnostics). */
  get crossProcessBroker(): CrossProcessAuthBroker {
    return this.crossProcess;
  }

  /** Enable strict serialization if races are observed. */
  setStrictSerial(enabled: boolean): void {
    this.mode = enabled ? "strict-serial" : "concurrent";
  }

  /**
   * Run an exclusive login/logout critical section under the cross-process lock.
   * Covers Agent-OS-local work in `fn` only — for interactive OAuth, prefer
   * holdLoginUntilAuthSettled so the lock spans the credential write window.
   */
  async withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.crossProcess.withAuthLock("login", async () => {
      await this.acquireLogin();
      try {
        if (this.mode === "strict-serial") {
          return await this.withSerial(fn);
        }
        return await fn();
      } finally {
        this.releaseLogin();
      }
    });
  }

  /**
   * Hold the cross-process login lock until the shared auth store mtime advances
   * past `baselineMtimeMs` (credential write observed) or `timeoutMs` elapses.
   * Spawn grants wait while this hold is active. Fire-and-forget after minting
   * an OAuth attach command so the HTTP handler can return immediately.
   */
  holdLoginUntilAuthSettled(options: {
    baselineMtimeMs: number;
    timeoutMs?: number;
  }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? LOGIN_HOLD_TIMEOUT_MS;
    const authJson = join(this.authStoreDir, "auth.json");
    const run = this.crossProcess.withAuthLock(
      "login",
      async () => {
        await this.acquireLogin();
        try {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (authStoreAdvanced(authJson, options.baselineMtimeMs)) return;
            await new Promise((r) => setTimeout(r, LOGIN_HOLD_POLL_MS));
          }
        } finally {
          this.releaseLogin();
        }
      },
      timeoutMs + 5_000,
    );
    this.loginHoldInFlight = run.finally(() => {
      if (this.loginHoldInFlight === run) this.loginHoldInFlight = null;
    });
    return this.loginHoldInFlight;
  }

  /** Current auth.json mtime, or 0 when missing — used as OAuth baseline. */
  authStoreMtimeMs(): number {
    const authJson = join(this.authStoreDir, "auth.json");
    try {
      if (!existsSync(authJson)) return 0;
      return statSync(authJson).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Steady-state spawn grant. Always takes the cross-process auth lock so a
   * concurrent login/refresh on another process cannot rewrite the store while
   * we resolve a grant. Intra-process: concurrent unless strict-serial / login held.
   *
   * Timeout is SPAWN_GRANT_TIMEOUT_MS (= LOGIN_HOLD_TIMEOUT_MS + skew) so a
   * spawn during interactive OAuth waits out the exclusive login window rather
   * than failing early. Async only — never busy-wait on the daemon event loop.
   */
  async withSpawnGrant<T>(fn: () => Promise<T>): Promise<T> {
    return this.crossProcess.withAuthLock(
      "spawn-grant",
      async () => {
        if (this.mode === "strict-serial" || this.loginHeld) {
          if (this.loginHeld) {
            await this.acquireLogin();
            try {
              return await fn();
            } finally {
              this.releaseLogin();
            }
          }
          return this.withSerial(fn);
        }
        return fn();
      },
      SPAWN_GRANT_TIMEOUT_MS,
    );
  }

  /**
   * True when this process currently holds the cross-process auth lock.
   * Production grant resolution asserts this so a call site cannot resolve a
   * provider key outside withSpawnGrant / withLoginLock.
   */
  holdsAuthLock(): boolean {
    const info = this.crossProcess.holder();
    return info !== null && info.pid === process.pid;
  }

  private acquireLogin(): Promise<void> {
    if (!this.loginHeld && this.queue.length === 0) {
      this.loginHeld = true;
      this.mode = this.mode === "strict-serial" ? "strict-serial" : "login-serialized";
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.loginHeld = true;
        this.mode = this.mode === "strict-serial" ? "strict-serial" : "login-serialized";
        resolve();
      });
    });
  }

  private releaseLogin(): void {
    this.loginHeld = false;
    if (this.mode !== "strict-serial") {
      this.mode = "concurrent";
    }
    const next = this.queue.shift();
    if (next !== undefined) next();
  }

  private withSerial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serialChain.then(fn, fn);
    this.serialChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function authStoreAdvanced(authJson: string, baselineMtimeMs: number): boolean {
  try {
    if (!existsSync(authJson)) return false;
    return statSync(authJson).mtimeMs > baselineMtimeMs;
  } catch {
    return false;
  }
}

export { AuthBrokerTimeoutError };
