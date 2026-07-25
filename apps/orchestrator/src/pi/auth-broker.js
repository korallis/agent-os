/**
 * Pi auth broker locks (master plan §4.5).
 * Login/logout exclusive; steady-state concurrent; piStrictSerial fallback.
 */
export class PiAuthBroker {
    mode = "concurrent";
    loginHeld = false;
    queue = [];
    serialChain = Promise.resolve();
    getMode() {
        return this.mode;
    }
    /** Enable strict serialization if races are observed. */
    setStrictSerial(enabled) {
        this.mode = enabled ? "strict-serial" : "concurrent";
    }
    /**
     * Run an exclusive login/logout flow. Concurrent login attempts queue.
     */
    async withLoginLock(fn) {
        await this.acquireLogin();
        try {
            if (this.mode === "strict-serial") {
                return await this.withSerial(fn);
            }
            return await fn();
        }
        finally {
            this.releaseLogin();
        }
    }
    /**
     * Steady-state spawn grant. Concurrent unless strict-serial.
     */
    async withSpawnGrant(fn) {
        if (this.mode === "strict-serial" || this.loginHeld) {
            // Post-refresh window / strict: serialize behind login queue.
            if (this.loginHeld) {
                await this.acquireLogin();
                try {
                    return await fn();
                }
                finally {
                    this.releaseLogin();
                }
            }
            return this.withSerial(fn);
        }
        return fn();
    }
    acquireLogin() {
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
    releaseLogin() {
        this.loginHeld = false;
        if (this.mode !== "strict-serial") {
            this.mode = "concurrent";
        }
        const next = this.queue.shift();
        if (next !== undefined)
            next();
    }
    withSerial(fn) {
        const run = this.serialChain.then(fn, fn);
        this.serialChain = run.then(() => undefined, () => undefined);
        return run;
    }
}
