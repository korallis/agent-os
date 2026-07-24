import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite projection schema (master plan §9). The projection is a rebuildable
 * cache of the NDJSON event log — never the source of truth.
 */

export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey(),
  id: text("id").notNull().unique(),
  ts: text("ts").notNull(),
  type: text("type").notNull(),
  /** Full JSON-serialized envelope (exact bytes reproducible). */
  envelope: text("envelope").notNull(),
});

/** Every applied config change, projected from config/policy events (§9). */
export const configRevisions = sqliteTable("config_revisions", {
  seq: integer("seq").primaryKey(),
  domain: text("domain").notNull(),
  layer: text("layer").notNull(),
  contentHash: text("content_hash").notNull(),
  at: text("at").notNull(),
});

/** Forward-only, checksummed migrations ledger (§2.1). */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  envelope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_revisions (
  seq INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  layer TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`,
  },
];
