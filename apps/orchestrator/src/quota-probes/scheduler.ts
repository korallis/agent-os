import type { Logger } from "pino";
import type { EventStore } from "@agent-os/event-store";
import { quotaSampleSchema, type QuotaSample } from "@agent-os/protocol";
import type { ConfigService } from "../config/service.js";
import type { ConnectionRegistry } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { resolveAuthJsonPathWithFallback } from "../security/auth-store.js";
import { isLimitReached, isProbeEnabled, probeConnection } from "./probes.js";

export interface QuotaProbeSchedulerDeps {
  home: string;
  store: EventStore;
  config: ConfigService;
  connections: ConnectionRegistry;
  pi: PiDetection;
  quotaSamples: Map<string, QuotaSample>;
  logger: Logger;
}

/**
 * Daemon-side quota probe loop driven by quota.json5 poll/jitter/backoff.
 */
export class QuotaProbeScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inFlight = false;
  private readonly failures = new Map<string, number>();
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(private readonly deps: QuotaProbeSchedulerDeps) {}

  start(): void {
    this.stopped = false;
    // First tick shortly after boot so Console has samples without a long wait.
    this.arm(1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  private nextDelayMs(): number {
    const quota = this.deps.config.config.quota;
    const jitter =
      quota.jitterSeconds > 0 ? Math.floor(Math.random() * (quota.jitterSeconds + 1)) : 0;
    const seconds = Math.max(quota.minIntervalSeconds, quota.pollIntervalSeconds + jitter);
    return seconds * 1_000;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.arm(this.nextDelayMs());
      return;
    }
    this.inFlight = true;
    try {
      await this.probeAll();
    } catch (error) {
      this.deps.logger.warn({ err: error }, "quota probe scheduler tick failed");
    } finally {
      this.inFlight = false;
      if (!this.stopped) this.arm(this.nextDelayMs());
    }
  }

  private async probeAll(): Promise<void> {
    const quota = this.deps.config.config.quota;
    const authJsonPath = resolveAuthJsonPathWithFallback(
      this.deps.pi.isolationMode === "managed" ? this.deps.pi.managedHome : null,
    );
    const now = Date.now();

    for (const connection of this.deps.connections.list()) {
      if (!isProbeEnabled(connection.provider, quota)) continue;

      const allowedAt = this.nextAllowedAt.get(connection.id) ?? 0;
      if (now < allowedAt) continue;

      try {
        const { sample, events } = await probeConnection({
          connection,
          config: quota,
          authJsonPath,
          agentosHome: this.deps.home,
        });
        this.deps.quotaSamples.set(connection.id, sample);
        for (const event of events) {
          this.deps.store.append(event);
        }
        const limit = isLimitReached(sample);
        this.deps.connections.setLimitReached(connection.id, limit.reached, limit.reason);

        const failed = sample.metrics.every(
          (m) => m.tier === "estimate" && (m.reason?.includes("HTTP") || m.reason?.includes("probe")),
        );
        if (failed) {
          this.applyBackoff(connection.id, quota.backoffBaseSeconds, quota.backoffMaxSeconds);
        } else {
          this.failures.delete(connection.id);
          this.nextAllowedAt.set(connection.id, now + quota.minIntervalSeconds * 1_000);
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, connectionId: connection.id },
          "quota probe failed for connection",
        );
        this.applyBackoff(connection.id, quota.backoffBaseSeconds, quota.backoffMaxSeconds);
      }
    }
  }

  private applyBackoff(connectionId: string, baseSeconds: number, maxSeconds: number): void {
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
export function hydrateQuotaSamples(store: EventStore): Map<string, QuotaSample> {
  const map = new Map<string, QuotaSample>();
  for (const [connectionId, raw] of store.latestQuotaByConnection()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const payload = raw as Record<string, unknown>;
    const sampleId = payload["sampleId"];
    const provider = payload["provider"];
    const metrics = payload["metrics"];
    if (typeof sampleId !== "string" || typeof provider !== "string" || !Array.isArray(metrics)) {
      continue;
    }
    let sampledAt: string | null = null;
    for (const m of metrics) {
      if (typeof m === "object" && m !== null && !Array.isArray(m)) {
        const syncedAt = (m as Record<string, unknown>)["syncedAt"];
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
    if (parsed.success) map.set(connectionId, parsed.data);
  }
  return map;
}
