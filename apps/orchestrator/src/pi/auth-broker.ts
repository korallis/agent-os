import type { PiAuthBrokerMode } from "@agent-os/protocol";

/**
 * Pi auth broker locks (master plan §4.5).
 * Login/logout exclusive; steady-state concurrent; piStrictSerial fallback.
 */

export class PiAuthBroker {
  private mode: PiAuthBrokerMode = "concurrent";
  private loginHeld = false;
  private readonly queue: Array<() => void> = [];
  private serialChain: Promise<void> = Promise.resolve();

  getMode(): PiAuthBrokerMode {
    return this.mode;
  }

  /** Enable strict serialization if races are observed. */
  setStrictSerial(enabled: boolean): void {
    this.mode = enabled ? "strict-serial" : "concurrent";
  }

  /**
   * Run an exclusive login/logout flow. Concurrent login attempts queue.
   */
  async withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLogin();
    try {
      if (this.mode === "strict-serial") {
        return await this.withSerial(fn);
      }
      return await fn();
    } finally {
      this.releaseLogin();
    }
  }

  /**
   * Steady-state spawn grant. Concurrent unless strict-serial.
   */
  async withSpawnGrant<T>(fn: () => Promise<T>): Promise<T> {
    if (this.mode === "strict-serial" || this.loginHeld) {
      // Post-refresh window / strict: serialize behind login queue.
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
