import { join } from "node:path";
import { monotonicFactory } from "ulid";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
  type OrchestratorEvent,
} from "@agent-os/protocol";
import { NdjsonEventLog, quarantineCorruptTail, readLog } from "./log.js";
import { SqliteProjection } from "./projection.js";

export type EventListener = (envelope: EventEnvelope) => void;

export interface EventStoreOpenResult {
  store: EventStore;
  /** Number of events replayed into the projection during boot. */
  replayed: number;
  /** Path of the quarantine file when a corrupt tail was found, else null. */
  quarantinedTail: string | null;
}

/**
 * The event store: append-only NDJSON log (truth) + SQLite projection
 * (rebuildable cache) + in-process fan-out for the SSE hub.
 *
 * Boot sequence (master plan §5.8/§9): read log → quarantine corrupt tail →
 * reconcile projection (full rebuild if it is ahead of the log, incremental
 * replay otherwise). `kill -9` at any point is recoverable by construction:
 * the log is fsync'd before projection or fan-out.
 */
export class EventStore {
  private readonly listeners = new Set<EventListener>();
  private readonly nextUlid = monotonicFactory();
  private nextSeq: number;

  private constructor(
    private readonly log: NdjsonEventLog,
    private readonly projection: SqliteProjection,
    lastSeq: number,
  ) {
    this.nextSeq = lastSeq + 1;
  }

  static open(homeDir: string): EventStoreOpenResult {
    const logPath = join(homeDir, "events", "events.ndjson");
    const dbPath = join(homeDir, "agentos.db");

    const read = readLog(logPath);
    const quarantinedTail = quarantineCorruptTail(logPath, read);

    const projection = new SqliteProjection(dbPath);
    let replayed = 0;
    const logLastSeq = read.envelopes.at(-1)?.seq ?? 0;
    if (projection.lastSeq() > logLastSeq) {
      // Projection is ahead of the (possibly truncated) log — the log is the
      // truth, so rebuild the projection from scratch.
      projection.reset();
    }
    const projectedSeq = projection.lastSeq();
    for (const envelope of read.envelopes) {
      if (envelope.seq > projectedSeq) {
        projection.apply(envelope);
        replayed += 1;
      }
    }

    const log = new NdjsonEventLog(logPath);
    const store = new EventStore(log, projection, logLastSeq);
    return { store, replayed, quarantinedTail };
  }

  /**
   * Records an event: envelope assembly → fsync'd log append → projection →
   * listener fan-out (SSE). Returns the durable envelope.
   */
  append(event: OrchestratorEvent): EventEnvelope {
    const envelope = eventEnvelopeSchema.parse({
      id: this.nextUlid(),
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      event,
    });
    this.log.append(envelope);
    this.nextSeq += 1;
    this.projection.apply(envelope);
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return envelope;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Replays events after a ULID cursor (SSE `Last-Event-ID` semantics). */
  eventsAfterId(afterId: string | null, limit: number): { events: EventEnvelope[]; truncated: boolean } {
    let afterSeq = 0;
    if (afterId !== null) {
      const seq = this.projection.seqOfEventId(afterId);
      // Unknown cursor → replay from the beginning (safe, idempotent client-side).
      afterSeq = seq ?? 0;
    }
    const events = this.projection.eventsAfterSeq(afterSeq, limit + 1);
    const truncated = events.length > limit;
    return { events: truncated ? events.slice(0, limit) : events, truncated };
  }

  count(): number {
    return this.projection.count();
  }

  lastSeq(): number {
    return this.nextSeq - 1;
  }

  lastEventId(): string | null {
    const last = this.projection.eventsAfterSeq(this.nextSeq - 2, 1);
    return last[0]?.id ?? null;
  }

  configRevisionCount(): number {
    return this.projection.configRevisionCount();
  }

  close(): void {
    this.listeners.clear();
    this.log.close();
    this.projection.close();
  }
}
