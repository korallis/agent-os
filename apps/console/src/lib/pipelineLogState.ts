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
