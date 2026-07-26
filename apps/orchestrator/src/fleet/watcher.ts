import { monotonicFactory } from "ulid";
import type {
  AbsorbableWakeClass,
  OrchestratorEvent,
  SupervisionConfig,
  WakeClass,
  WakeDigest,
} from "@agent-os/protocol";

export type WakeEventSink = (event: OrchestratorEvent) => void;
export type WakeDeliverer = (digest: WakeDigest) => void;

const nextUlid = monotonicFactory();

/**
 * Zero-token wake classification (master plan §5.6).
 * Absorbs benign wakes per supervision.absorb; queues actionable digests for the Brain.
 * Classification never calls an LLM.
 */
/** Retained wake history. Bounded: the daemon is long-lived. */
const MAX_HISTORY = 5_000;

export class WakeWatcher {
  private sink: WakeEventSink = () => undefined;
  private deliver: WakeDeliverer = () => undefined;
  private config: SupervisionConfig;
  private readonly queue: WakeDigest[] = [];
  private readonly history: WakeDigest[] = [];
  private brainDown = false;

  constructor(config: SupervisionConfig) {
    this.config = config;
  }

  onEvent(sink: WakeEventSink): void {
    this.sink = sink;
  }

  onDeliver(deliver: WakeDeliverer): void {
    this.deliver = deliver;
  }

  updateConfig(config: SupervisionConfig): void {
    this.config = config;
  }

  setBrainDown(down: boolean): void {
    this.brainDown = down;
  }

  getQueue(): WakeDigest[] {
    return [...this.queue];
  }

  getHistory(limit = 100): WakeDigest[] {
    return this.history.slice(-limit);
  }

  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Classify and either absorb or queue/deliver a wake.
   * Returns the digest (whether absorbed or not).
   */
  classify(input: {
    class: WakeClass;
    taskId?: string | null;
    sessionId?: string | null;
    summary: string;
    detail?: Record<string, unknown>;
    contextUsedPct?: number;
  }): WakeDigest {
    const absorbed = this.shouldAbsorb(input.class, input.contextUsedPct);
    const digest: WakeDigest = {
      id: nextUlid(),
      class: input.class,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      summary: input.summary,
      detail: input.detail,
      absorbed,
      deliveredToBrain: false,
      createdAt: new Date().toISOString(),
    };

    if (absorbed) {
      this.history.push(digest);
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      this.sink({
        type: "wake.classified",
        payload: {
          wakeId: digest.id,
          class: digest.class,
          taskId: digest.taskId,
          sessionId: digest.sessionId,
          absorbed: true,
          deliveredToBrain: false,
          summary: digest.summary,
        },
      });
      return digest;
    }

    if (this.brainDown) {
      this.queue.push(digest);
      this.history.push(digest);
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      this.sink({
        type: "wake.classified",
        payload: {
          wakeId: digest.id,
          class: digest.class,
          taskId: digest.taskId,
          sessionId: digest.sessionId,
          absorbed: false,
          deliveredToBrain: false,
          summary: digest.summary,
        },
      });
      return digest;
    }

    digest.deliveredToBrain = true;
    this.history.push(digest);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.sink({
      type: "wake.classified",
      payload: {
        wakeId: digest.id,
        class: digest.class,
        taskId: digest.taskId,
        sessionId: digest.sessionId,
        absorbed: false,
        deliveredToBrain: true,
        summary: digest.summary,
      },
    });
    this.deliver(digest);
    return digest;
  }

  /** Drain queued wakes after Brain recovery. */
  drainQueue(): WakeDigest[] {
    const pending = this.queue.splice(0, this.queue.length);
    for (const digest of pending) {
      const delivered: WakeDigest = { ...digest, deliveredToBrain: true };
      this.deliver(delivered);
    }
    return pending;
  }

  private shouldAbsorb(wakeClass: WakeClass, contextUsedPct?: number): boolean {
    const absorb = this.config.absorb as AbsorbableWakeClass[];
    if (wakeClass === "PROGRESS" && absorb.includes("PROGRESS")) return true;
    if (wakeClass === "TURN_SETTLED" && absorb.includes("TURN_SETTLED_MID_STAGE")) return true;
    if (wakeClass === "STALE" && absorb.includes("STALE")) return true;
    if (
      wakeClass === "CONTEXT_PRESSURE" &&
      absorb.includes("CONTEXT_PRESSURE_LT_70") &&
      (contextUsedPct === undefined || contextUsedPct < 70)
    ) {
      return true;
    }
    return false;
  }
}
