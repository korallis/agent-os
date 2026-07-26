/**
 * Pure helpers for Console pipeline log state. Kept free of React so growth
 * and merge rules can be unit-tested without a component harness.
 */

/**
 * Drop applied event ids that are no longer in the live SSE ring.
 *
 * `mergeLogRange` is offset-idempotent, so once an id has left both the ring
 * and any chance of re-delivery, keeping it only grows the Set without benefit.
 * Bound applied ids to the ring size so a long-lived firehose tab cannot leak.
 */
export function pruneAppliedLogIds(
  appliedLogIds: Set<string>,
  liveEventIds: Iterable<string>,
): void {
  const live =
    liveEventIds instanceof Set ? liveEventIds : new Set(liveEventIds);
  for (const id of [...appliedLogIds]) {
    if (!live.has(id)) appliedLogIds.delete(id);
  }
}

/**
 * Seed key for an active step (`runId:step`).
 *
 * Seeding (attach-time log-tails) and live streaming answer different
 * questions: "what was already there" vs "what is arriving now". A live
 * frame must never mark a key seeded — only an explicit log-tails entry does.
 */
export function pipelineLogSeedKey(runId: string, step: string): string {
  return `${runId}:${step}`;
}

/**
 * Mark only keys that log-tails actually answered — including an explicit
 * empty entry for a zero-length file. Keys absent from `tails` stay unseeded
 * so a file that appears a moment later is still caught up.
 */
export function markSeededFromLogTails(
  seededCatchUpKeys: Set<string>,
  tails: ReadonlyArray<{ runId: string; step: string }>,
): void {
  for (const tail of tails) {
    seededCatchUpKeys.add(pipelineLogSeedKey(tail.runId, tail.step));
  }
}

/** True when an active step still needs an attach-time log-tails seed. */
export function needsLogTailSeed(
  seededCatchUpKeys: ReadonlySet<string>,
  runId: string,
  step: string,
): boolean {
  return !seededCatchUpKeys.has(pipelineLogSeedKey(runId, step));
}
