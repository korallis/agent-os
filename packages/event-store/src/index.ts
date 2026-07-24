/**
 * @agent-os/event-store — append-only NDJSON event log (source of truth)
 * + rebuildable SQLite (WAL) projection (master plan §9).
 */
export { NdjsonEventLog, readLog, quarantineCorruptTail, type LogReadResult } from "./log.js";
export { SqliteProjection } from "./projection.js";
export { EventStore, type EventListener, type EventStoreOpenResult } from "./store.js";
export { events, configRevisions, MIGRATIONS } from "./schema.js";
