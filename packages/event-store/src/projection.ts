import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { desc, eq, gt, gte, lt } from "drizzle-orm";
import type { EventEnvelope } from "@agent-os/protocol";
import { MIGRATIONS, configRevisions, connections, events, quotaSamples } from "./schema.js";

/**
 * SQLite projection (WAL) rebuilt/reconciled from the NDJSON log on boot
 * (master plan §9). Idempotent by `seq`: replaying already-projected events
 * is a no-op, giving exactly-once projection across restarts.
 */
export class SqliteProjection {
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("synchronous = NORMAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.migrate();
    this.db = drizzle(this.sqlite);
  }

  private migrate(): void {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const appliedRows = this.sqlite
      .prepare("SELECT version, checksum FROM migrations ORDER BY version")
      .all() as { version: number; checksum: string }[];
    const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));
    for (const migration of MIGRATIONS) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const existing = applied.get(migration.version);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(
            `migration v${migration.version} checksum mismatch — refusing to continue (forward-only migrations)`,
          );
        }
        continue;
      }
      const run = this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite
          .prepare("INSERT INTO migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, checksum, new Date().toISOString());
      });
      run();
    }
  }

  lastSeq(): number {
    const row = this.db.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1).all();
    return row[0]?.seq ?? 0;
  }

  count(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /** Applies one envelope; a duplicate `seq` is ignored (exactly-once). */
  apply(envelope: EventEnvelope): void {
    const insert = this.db
      .insert(events)
      .values({
        seq: envelope.seq,
        id: envelope.id,
        ts: envelope.ts,
        type: envelope.event.type,
        envelope: JSON.stringify(envelope),
      })
      .onConflictDoNothing();

    const tx = this.sqlite.transaction(() => {
      insert.run();
      if (
        envelope.event.type === "config.changed" ||
        envelope.event.type === "policy.changed"
      ) {
        const payload = envelope.event.payload;
        this.db
          .insert(configRevisions)
          .values({
            seq: envelope.seq,
            domain: payload.domain,
            layer: payload.layer,
            contentHash:
              envelope.event.type === "config.changed" ? envelope.event.payload.contentHash : "",
            at: envelope.ts,
          })
          .onConflictDoNothing()
          .run();
      }
      if (envelope.event.type === "provider.connection_updated") {
        const p = envelope.event.payload;
        this.sqlite
          .prepare(
            `INSERT INTO connections (id, provider, kind, health, billing_surface, billing_mode, family, limit_reached, payload, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               provider=excluded.provider,
               kind=excluded.kind,
               health=excluded.health,
               billing_surface=excluded.billing_surface,
               billing_mode=excluded.billing_mode,
               family=excluded.family,
               limit_reached=excluded.limit_reached,
               payload=excluded.payload,
               updated_at=excluded.updated_at`,
          )
          .run(
            p.connectionId,
            p.provider,
            p.kind,
            p.health,
            p.billingSurface,
            p.billingMode,
            p.family,
            p.limitReached ? 1 : 0,
            JSON.stringify(p),
            envelope.ts,
          );
      }
      if (envelope.event.type === "quota.updated") {
        const p = envelope.event.payload;
        this.sqlite
          .prepare(
            `INSERT INTO quota_samples (id, connection_id, provider, sampled_at, payload)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .run(p.sampleId, p.connectionId, p.provider, envelope.ts, JSON.stringify(p));
      }
    });
    tx();
  }

  eventsAfterSeq(afterSeq: number, limit: number): EventEnvelope[] {
    const rows = this.db
      .select({ envelope: events.envelope })
      .from(events)
      .where(gt(events.seq, afterSeq))
      .orderBy(events.seq)
      .limit(limit)
      .all();
    return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  /**
   * Newest-first page: events with seq strictly less than `beforeSeq`
   * (or the newest `limit` events when `beforeSeq` is null).
   */
  eventsBeforeSeq(beforeSeq: number | null, limit: number): EventEnvelope[] {
    const query = this.db.select({ envelope: events.envelope }).from(events);
    const rows =
      beforeSeq === null
        ? query.orderBy(desc(events.seq)).limit(limit).all()
        : query
            .where(lt(events.seq, beforeSeq))
            .orderBy(desc(events.seq))
            .limit(limit)
            .all();
    return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  /**
   * Events at or after an ISO timestamp, newest-first within the page.
   * Truncation therefore drops the oldest in-window frames, not the newest.
   */
  eventsSinceTs(sinceTs: string, limit: number): EventEnvelope[] {
    const rows = this.db
      .select({ envelope: events.envelope })
      .from(events)
      .where(gte(events.ts, sinceTs))
      .orderBy(desc(events.seq))
      .limit(limit)
      .all();
    return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  /** Count of events at or after an ISO timestamp (truncation detection). */
  countSinceTs(sinceTs: string): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ?")
      .get(sinceTs) as { n: number };
    return row.n;
  }

  /**
   * Events of a given type, newest-first (not day-windowed).
   * Used for session.spawned attribution of long-lived sessions.
   */
  eventsByType(type: string, limit: number): EventEnvelope[] {
    const rows = this.db
      .select({ envelope: events.envelope })
      .from(events)
      .where(eq(events.type, type))
      .orderBy(desc(events.seq))
      .limit(limit)
      .all();
    return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  /**
   * Events whose payload.taskId matches, optionally filtered by type.
   * Newest-first page so truncation drops the oldest frames for this task.
   */
  eventsForTask(taskId: string, types: readonly string[] | null, limit: number): EventEnvelope[] {
    if (types !== null && types.length === 0) return [];
    const typeFilter =
      types === null
        ? ""
        : ` AND type IN (${types.map(() => "?").join(", ")})`;
    const params: unknown[] =
      types === null ? [taskId, limit] : [taskId, ...types, limit];
    const rows = this.sqlite
      .prepare(
        `SELECT envelope FROM events
         WHERE json_extract(envelope, '$.event.payload.taskId') = ?${typeFilter}
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(...params) as { envelope: string }[];
    return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  /** Count of events whose payload.taskId matches (optional type filter). */
  countForTask(taskId: string, types: readonly string[] | null): number {
    if (types !== null && types.length === 0) return 0;
    const typeFilter =
      types === null
        ? ""
        : ` AND type IN (${types.map(() => "?").join(", ")})`;
    const params: unknown[] = types === null ? [taskId] : [taskId, ...types];
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE json_extract(envelope, '$.event.payload.taskId') = ?${typeFilter}`,
      )
      .get(...params) as { n: number };
    return row.n;
  }

  seqOfEventId(id: string): number | null {
    const rows = this.db.select({ seq: events.seq }).from(events).where(eq(events.id, id)).limit(1).all();
    return rows[0]?.seq ?? null;
  }

  configRevisionCount(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS n FROM config_revisions").get() as {
      n: number;
    };
    return row.n;
  }

  /** Latest quota sample payload per connection (projection helper). */
  latestQuotaByConnection(): Map<string, unknown> {
    const rows = this.sqlite
      .prepare(
        `SELECT connection_id, payload FROM quota_samples qs
         WHERE sampled_at = (
           SELECT MAX(sampled_at) FROM quota_samples
           WHERE connection_id = qs.connection_id
         )`,
      )
      .all() as { connection_id: string; payload: string }[];
    const map = new Map<string, unknown>();
    for (const row of rows) {
      map.set(row.connection_id, JSON.parse(row.payload));
    }
    return map;
  }

  listConnectionPayloads(): unknown[] {
    const rows = this.sqlite
      .prepare("SELECT payload FROM connections ORDER BY updated_at DESC")
      .all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload));
  }

  /** Drops all projected rows so a full rebuild from the log can run. */
  reset(): void {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.exec(
        "DELETE FROM events; DELETE FROM config_revisions; DELETE FROM connections; DELETE FROM quota_samples;",
      );
    });
    tx();
  }

  close(): void {
    this.sqlite.close();
  }
}

// Silence unused-export noise if drizzle tables are only used for types elsewhere.
void connections;
void quotaSamples;
