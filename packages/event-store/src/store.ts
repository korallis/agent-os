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

/** Per-task gate/fusion totals for Pipeline Run History (daemon-side). */
export type RunHistoryAggregate = {
  taskId: string;
  gateRuns: number;
  gateFailures: number;
  gateErrors: number;
  fusionRuns: number;
  firstSeen: string | null;
  lastSeen: string | null;
};

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
  /**
   * Monotonic seq for live-only frames (emitLive). Kept far above durable seqs
   * so envelope seq stays unique without consuming durable nextSeq.
   */
  private nextLiveOnlySeq = 1_000_000_000_000;

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
    this.fanOut(envelope);
    return envelope;
  }

  /**
   * Live-only fan-out: assemble an envelope and notify subscribers without
   * writing the durable NDJSON log or the projection.
   *
   * Use for bulk output that already has a durable artifact elsewhere (e.g.
   * pipeline step log files). Live frames reach connected SSE clients; a fresh
   * EventSource never replays them from history.
   */
  emitLive(event: OrchestratorEvent): EventEnvelope {
    const envelope = eventEnvelopeSchema.parse({
      id: this.nextUlid(),
      // Dedicated live-only sequence space — independent of durable nextSeq so
      // live frames leave no holes in the append-only log's seq accounting.
      seq: this.nextLiveOnlySeq,
      ts: new Date().toISOString(),
      event,
    });
    this.nextLiveOnlySeq += 1;
    this.fanOut(envelope);
    return envelope;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fanOut(envelope: EventEnvelope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch {
        this.listeners.delete(listener);
      }
    }
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

  /**
   * Newest-first page for evidence surfaces and reverse scans.
   * `beforeId` is exclusive (events strictly older than that ULID).
   * Unknown `beforeId` is treated as "from the newest end".
   */
  eventsBeforeId(
    beforeId: string | null,
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    let beforeSeq: number | null = null;
    if (beforeId !== null) {
      beforeSeq = this.projection.seqOfEventId(beforeId);
    }
    const events = this.projection.eventsBeforeSeq(beforeSeq, limit + 1);
    const truncated = events.length > limit;
    return { events: truncated ? events.slice(0, limit) : events, truncated };
  }

  /**
   * Time-bounded scan: events at or after `sinceTs`, newest-first.
   * When the page is truncated, the oldest in-window frames are dropped so
   * recent usage/throughput stay visible. `truncated` is true when more events
   * exist in the window than `limit`.
   */
  eventsSince(
    sinceTs: string,
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    const events = this.projection.eventsSinceTs(sinceTs, limit + 1);
    const truncated = events.length > limit;
    return { events: truncated ? events.slice(0, limit) : events, truncated };
  }

  /**
   * Newest-first page of a single event type (not day-windowed).
   * Used for session.spawned attribution across the full durable log.
   */
  eventsByType(
    type: string,
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    const events = this.projection.eventsByType(type, limit + 1);
    const truncated = events.length > limit;
    return { events: truncated ? events.slice(0, limit) : events, truncated };
  }

  /**
   * Newest-first page of one or more event types. Truncation is about matching
   * frames only (not mixed global log windows), so empty means no matches.
   */
  eventsOfTypes(
    types: readonly string[],
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    const events = this.projection.eventsOfTypes(types, limit + 1);
    const truncated = events.length > limit;
    return { events: truncated ? events.slice(0, limit) : events, truncated };
  }

  /**
   * Task-scoped history for evidence surfaces.
   * `truncated` means this task has more matching events than `limit` —
   * independent of global log size. Returns chronological order (oldest first).
   */
  eventsForTask(
    taskId: string,
    types: readonly string[] | null,
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    const total = this.projection.countForTask(taskId, types);
    const newestFirst = this.projection.eventsForTask(taskId, types, limit);
    const truncated = total > newestFirst.length;
    return { events: newestFirst.reverse(), truncated };
  }

  /**
   * Session-scoped history for the agent log view. Same truncation semantics as
   * `eventsForTask`: `truncated` is about THIS session, not the global log.
   */
  eventsForSession(
    sessionId: string,
    types: readonly string[] | null,
    limit: number,
  ): { events: EventEnvelope[]; truncated: boolean } {
    const total = this.projection.countForSession(sessionId, types);
    const newestFirst = this.projection.eventsForSession(sessionId, types, limit);
    const truncated = total > newestFirst.length;
    return { events: newestFirst.reverse(), truncated };
  }

  /**
   * Per-task gate/fusion aggregates for Pipeline Run History.
   * Scans only sparse lifecycle types (never the full chatty log) so counts
   * are complete — no page window, no "most recent frames" lie.
   * firstSeen/lastSeen use min/max timestamps, not iteration order.
   */
  aggregateRunHistory(): RunHistoryAggregate[] {
    const types = [
      "task.created",
      "task.phase_changed",
      "gate.result",
      "fusion.dispatched",
      "fusion.completed",
    ] as const;
    const byTask = new Map<string, RunHistoryAggregate>();
    const touch = (taskId: string): RunHistoryAggregate => {
      let row = byTask.get(taskId);
      if (row === undefined) {
        row = {
          taskId,
          gateRuns: 0,
          gateFailures: 0,
          gateErrors: 0,
          fusionRuns: 0,
          firstSeen: null,
          lastSeen: null,
        };
        byTask.set(taskId, row);
      }
      return row;
    };

    for (const envelope of this.projection.eventsOfTypesForTasks(types)) {
      const payload = envelope.event.payload as { taskId?: string };
      const taskId = payload.taskId;
      if (taskId === undefined) continue;
      const row = touch(taskId);
      if (row.firstSeen === null || envelope.ts < row.firstSeen) {
        row.firstSeen = envelope.ts;
      }
      if (row.lastSeen === null || envelope.ts > row.lastSeen) {
        row.lastSeen = envelope.ts;
      }
      if (envelope.event.type === "gate.result") {
        row.gateRuns += 1;
        if (envelope.event.payload.outcome === "FAIL") row.gateFailures += 1;
        if (envelope.event.payload.outcome === "GATE_ERROR") row.gateErrors += 1;
      } else if (envelope.event.type === "fusion.dispatched") {
        row.fusionRuns += 1;
      }
    }
    return [...byTask.values()];
  }

  count(): number {
    return this.projection.count();
  }

  countSince(sinceTs: string): number {
    return this.projection.countSinceTs(sinceTs);
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

  latestQuotaByConnection(): Map<string, unknown> {
    return this.projection.latestQuotaByConnection();
  }

  listConnectionPayloads(): unknown[] {
    return this.projection.listConnectionPayloads();
  }

  close(): void {
    this.listeners.clear();
    this.log.close();
    this.projection.close();
  }
}
