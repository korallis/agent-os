import type { PiAuthBrokerMode } from "@agent-os/protocol";
import {
  AuthBrokerTimeoutError,
  CrossProcessAuthBroker,
} from "./cross-process-broker.js";
import { join } from "node:path";

const SPAWN_LOCK_TIMEOUT_MS = 30_000;
const SPAWN_LOCK_POLL_MS = 50;

function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Pi auth broker locks (master plan §4.5).
 *
 * Single choke point for every production path that touches the shared Pi auth
 * store: login/logout exclusive windows and spawn grants that resolve provider
 * credentials. In-process ordering (login queue / strict-serial) sits on top of
 * the cross-process lock so primaries and secondmates cannot race the store.
 */

export class PiAuthBroker {
  private mode: PiAuthBrokerMode = "concurrent";
  private loginHeld = false;
  private readonly queue: Array<() => void> = [];
  private serialChain: Promise<void> = Promise.resolve();
  private readonly crossProcess: CrossProcessAuthBroker;

  /**
   * @param authStoreDir directory containing the shared Pi auth store
   *   (typically `<managedPiHome>/agent`). The cross-process lock lives beside it.
   */
  constructor(authStoreDir: string) {
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
   * Run an exclusive login/logout flow. Concurrent login attempts queue, and
   * the cross-process lock is held for the entire critical section.
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
   * Steady-state spawn grant. Always takes the cross-process auth lock so a
   * concurrent login/refresh on another process cannot rewrite the store while
   * we resolve a grant. Intra-process: concurrent unless strict-serial / login held.
   */
  async withSpawnGrant<T>(fn: () => Promise<T>): Promise<T> {
    return this.crossProcess.withAuthLock("spawn-grant", async () => {
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
    });
  }

  /**
   * Synchronous spawn-grant lock for the substrate's sync spawn path.
   * Same cross-process choke point as withSpawnGrant — call sites must not
   * touch the auth store without going through this class.
   */
  withSpawnGrantSync<T>(fn: () => T): T {
    const deadline = Date.now() + SPAWN_LOCK_TIMEOUT_MS;
    for (;;) {
      if (this.crossProcess.tryAcquire("spawn-grant")) break;
      if (Date.now() >= deadline) {
        throw new AuthBrokerTimeoutError(
          `timed out waiting ${SPAWN_LOCK_TIMEOUT_MS}ms for the Pi auth lock`,
          this.crossProcess.holder(),
        );
      }
      sleepMs(SPAWN_LOCK_POLL_MS);
    }
    try {
      return fn();
    } finally {
      this.crossProcess.release();
    }
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
