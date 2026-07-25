import { quotaSampleSchema } from "@agent-os/protocol";
import { resolveAuthJsonPathsWithFallback } from "../security/auth-store.js";
import { hasProbeEndpoints } from "./allowlist.js";
import { isLimitReached, isProbeEnabled, probeConnection } from "./probes.js";
/**
 * Daemon-side quota probe loop driven by quota.json5 poll/jitter/backoff.
 */
export class QuotaProbeScheduler {
    deps;
    timer = null;
    stopped = false;
    inFlight = false;
    failures = new Map();
    nextAllowedAt = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    start() {
        this.stopped = false;
        // First tick shortly after boot so Console has samples without a long wait.
        this.arm(1_000);
    }
    stop() {
        this.stopped = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    arm(delayMs) {
        if (this.stopped)
            return;
        if (this.timer !== null)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick();
        }, Math.max(0, delayMs));
    }
    nextDelayMs() {
        const quota = this.deps.config.config.quota;
        const jitter = quota.jitterSeconds > 0 ? Math.floor(Math.random() * (quota.jitterSeconds + 1)) : 0;
        const seconds = Math.max(quota.minIntervalSeconds, quota.pollIntervalSeconds + jitter);
        return seconds * 1_000;
    }
    async tick() {
        if (this.stopped)
            return;
        if (this.inFlight) {
            this.arm(this.nextDelayMs());
            return;
        }
        this.inFlight = true;
        try {
            await this.probeAll();
        }
        catch (error) {
            this.deps.logger.warn({ err: error }, "quota probe scheduler tick failed");
        }
        finally {
            this.inFlight = false;
            if (!this.stopped)
                this.arm(this.nextDelayMs());
        }
    }
    async probeAll() {
        this.deps.connections.syncFromAuthStore();
        const quota = this.deps.config.config.quota;
        const authJsonPaths = resolveAuthJsonPathsWithFallback(this.deps.pi.isolationMode === "managed" ? this.deps.pi.managedHome : null);
        const authJsonPath = authJsonPaths[0] ?? "";
        const now = Date.now();
        for (const connection of this.deps.connections.list()) {
            if (!isProbeEnabled(connection.provider, quota))
                continue;
            const allowlistKey = connection.provider === "claude-agent-sdk" ? "anthropic" : connection.provider;
            if (!hasProbeEndpoints(allowlistKey))
                continue;
            const allowedAt = this.nextAllowedAt.get(connection.id) ?? 0;
            if (now < allowedAt)
                continue;
            try {
                const { sample, events } = await probeConnection({
                    connection,
                    config: quota,
                    authJsonPath,
                    authJsonPaths,
                    agentosHome: this.deps.home,
                });
                this.deps.quotaSamples.set(connection.id, sample);
                for (const event of events) {
                    this.deps.store.append(event);
                }
                const limit = isLimitReached(sample);
                this.deps.connections.setLimitReached(connection.id, limit.reached, limit.reason);
                const failed = sample.metrics.every((m) => m.tier === "estimate" && (m.reason?.includes("HTTP") || m.reason?.includes("probe")));
                if (failed) {
                    this.applyBackoff(connection.id, quota.backoffBaseSeconds, quota.backoffMaxSeconds);
                }
                else {
                    this.failures.delete(connection.id);
                    this.nextAllowedAt.set(connection.id, now + quota.minIntervalSeconds * 1_000);
                }
            }
            catch (error) {
                this.deps.logger.warn({ err: error, connectionId: connection.id }, "quota probe failed for connection");
                this.applyBackoff(connection.id, quota.backoffBaseSeconds, quota.backoffMaxSeconds);
            }
        }
    }
    applyBackoff(connectionId, baseSeconds, maxSeconds) {
        const n = (this.failures.get(connectionId) ?? 0) + 1;
        this.failures.set(connectionId, n);
        const delaySec = Math.min(maxSeconds, baseSeconds * 2 ** Math.min(n - 1, 8));
        this.nextAllowedAt.set(connectionId, Date.now() + delaySec * 1_000);
    }
}
/**
 * Rebuild in-memory samples from the SQLite projection after restart.
 * Projection rows store the `quota.updated` event payload, not QuotaSample.
 */
export function hydrateQuotaSamples(store) {
    const map = new Map();
    for (const [connectionId, raw] of store.latestQuotaByConnection()) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            continue;
        const payload = raw;
        const sampleId = payload["sampleId"];
        const provider = payload["provider"];
        const metrics = payload["metrics"];
        if (typeof sampleId !== "string" || typeof provider !== "string" || !Array.isArray(metrics)) {
            continue;
        }
        let sampledAt = null;
        for (const m of metrics) {
            if (typeof m === "object" && m !== null && !Array.isArray(m)) {
                const syncedAt = m["syncedAt"];
                if (typeof syncedAt === "string") {
                    sampledAt = syncedAt;
                    break;
                }
            }
        }
        const parsed = quotaSampleSchema.safeParse({
            id: sampleId,
            connectionId,
            provider,
            metrics,
            sampledAt: sampledAt ?? new Date().toISOString(),
        });
        if (parsed.success)
            map.set(connectionId, parsed.data);
    }
    return map;
}
