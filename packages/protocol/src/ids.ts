import { z } from "zod";

/** ULID — the canonical id format for events, tasks, runs (master plan §2.1). */
export const ulidSchema = z.ulid();

export type Ulid = z.infer<typeof ulidSchema>;

/** ISO-8601 UTC timestamp with sub-second precision. */
export const isoTimestampSchema = z.iso.datetime();

export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
