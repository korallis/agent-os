import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { desc, eq, gt } from "drizzle-orm";
import type { EventEnvelope } from "@agent-os/protocol";
import { MIGRATIONS, configRevisions, events } from "./schema.js";

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

  /** Drops all projected rows so a full rebuild from the log can run. */
  reset(): void {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.exec("DELETE FROM events; DELETE FROM config_revisions;");
    });
    tx();
  }

  close(): void {
    this.sqlite.close();
  }
}
