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
  /** Projected payload.taskId when present; indexed for task-scoped evidence scans. */
  taskId: text("task_id"),
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

/** Latest provider connection snapshot (Phase 2). */
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  health: text("health").notNull(),
  billingSurface: text("billing_surface").notNull(),
  billingMode: text("billing_mode"),
  family: text("family").notNull(),
  limitReached: integer("limit_reached", { mode: "boolean" }).notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Quota samples (Phase 2, §4.9) — latest per connection kept + history via events. */
export const quotaSamples = sqliteTable("quota_samples", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provider: text("provider").notNull(),
  sampledAt: text("sampled_at").notNull(),
  payload: text("payload").notNull(),
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
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  health TEXT NOT NULL,
  billing_surface TEXT NOT NULL,
  billing_mode TEXT,
  family TEXT NOT NULL,
  limit_reached INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_samples (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_samples_connection ON quota_samples(connection_id);
CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections(provider);
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE events ADD COLUMN task_id TEXT;
UPDATE events SET task_id = json_extract(envelope, '$.event.payload.taskId');
CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_task_id_type ON events(task_id, type);
`,
  },
];
