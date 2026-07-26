/**
 * Pure helpers for Console pipeline log state. Kept free of React so growth
 * and merge rules can be unit-tested without a component harness.
 *
 * pipeline.log_appended is live-only: there is no durable event-store replay.
 * Attach-time / re-seed log-tails is the only recovery path for bytes missed
 * during disconnect or before first sight. That makes coverage honesty and
 * re-seed invalidation load-bearing — a client's offset map must describe
 * what it ACTUALLY holds, never bytes it invented across a hole.
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

export function utf8SliceByBytes(text: string, startByte: number, endByte?: number): string {
  const bytes = utf8Encoder.encode(text);
  return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

/** One contiguous file region the client has actually received. */
export type LogSegment = { start: number; end: number; text: string };

/**
 * Marker inserted between discontinuous segments in display text so two
 * non-adjacent regions never render as consecutive lines.
 */
export const LOG_COVERAGE_GAP = "\n…\n";

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

/**
 * Retention budget grew (e.g. working → firehose). The Captain opted into a
 * larger window; the one-shot seed must run again or the setting is decorative.
 */
export function retentionIncreaseInvalidatesSeeds(
  previousChars: number,
  nextChars: number,
): boolean {
  return nextChars > previousChars;
}

/**
 * EventSource came back after a disconnect. Live-only frames missed during
 * the gap are gone unless log-tails re-seeds.
 */
export function streamReconnectInvalidatesSeeds(
  previousState: "connecting" | "live" | "down",
  nextState: "connecting" | "live" | "down",
): boolean {
  return previousState === "down" && nextState === "live";
}

/**
 * Merge a received file range into the client's coverage map.
 *
 * CRITICAL: never widen a range across bytes that were not received. Live-only
 * recovery depends on log-tails filling real gaps; fabricating continuous
 * coverage (concatenating text and advancing `end` over a hole) disables that
 * seed via the fully-covered short-circuit and permanently corrupts the buffer.
 * Merge only genuinely adjacent or overlapping segments. Discontinuous regions
 * stay as separate segments until a later range fills the hole.
 */
export function mergeLogRange(
  segments: readonly LogSegment[] | undefined,
  rangeStart: number,
  rangeText: string,
  rangeEnd?: number,
): LogSegment[] {
  const end = rangeEnd ?? rangeStart + utf8ByteLength(rangeText);
  const incoming: LogSegment = { start: rangeStart, end, text: rangeText };

  if (segments !== undefined) {
    for (const seg of segments) {
      if (rangeStart >= seg.start && end <= seg.end) {
        return segments.map((s) => ({ ...s }));
      }
    }
  }

  const all = [...(segments ?? []), incoming].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  const out: LogSegment[] = [];
  for (const seg of all) {
    const last = out[out.length - 1];
    if (last === undefined || seg.start > last.end) {
      // Gap (or first segment): keep discontinuous — do not fabricate coverage.
      out.push({ start: seg.start, end: seg.end, text: seg.text });
      continue;
    }
    // Adjacent or overlapping: keep existing text for the overlap, take only
    // the uncovered suffix past last.end.
    if (seg.end <= last.end) {
      continue;
    }
    const skip = last.end - seg.start;
    const suffix = skip === 0 ? seg.text : utf8SliceByBytes(seg.text, skip);
    last.text = last.text + suffix;
    last.end = seg.end;
  }
  return out;
}

/** Display text: discontinuous segments are never shown as consecutive lines. */
export function logSegmentsText(segments: readonly LogSegment[]): string {
  if (segments.length === 0) return "";
  let out = segments[0]!.text;
  for (let i = 1; i < segments.length; i++) {
    out += LOG_COVERAGE_GAP;
    out += segments[i]!.text;
  }
  return out;
}

/**
 * Drop leading content until total held text is within the char retention
 * budget. Byte offsets on remaining segments stay honest.
 */
export function trimSegmentsToCharRetention(
  segments: readonly LogSegment[],
  retention: number,
): { segments: LogSegment[]; truncated: boolean } {
  if (retention <= 0) {
    return { segments: [], truncated: segments.length > 0 };
  }
  let totalChars = 0;
  for (const seg of segments) totalChars += seg.text.length;
  if (totalChars <= retention) {
    return { segments: segments.map((s) => ({ ...s })), truncated: false };
  }

  const result = segments.map((s) => ({ ...s }));
  let excess = totalChars - retention;
  while (result.length > 0 && excess > 0) {
    const first = result[0]!;
    if (first.text.length <= excess) {
      excess -= first.text.length;
      result.shift();
    } else {
      const dropped = first.text.slice(0, excess);
      first.text = first.text.slice(excess);
      first.start += utf8ByteLength(dropped);
      excess = 0;
    }
  }
  return { segments: result, truncated: true };
}

/** True when [start, end) is fully covered by a single held segment. */
export function isRangeFullyCovered(
  segments: readonly LogSegment[],
  start: number,
  end: number,
): boolean {
  return segments.some((s) => start >= s.start && end <= s.end);
}
