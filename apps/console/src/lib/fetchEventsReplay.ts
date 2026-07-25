import type { EventEnvelope, EventsReplayResponse } from "@agent-os/protocol";

/**
 * Newest-first durable event replay for Console evidence surfaces.
 *
 * Default API order is oldest-first (`asc`) for SSE Last-Event-ID semantics.
 * Evidence UIs that want "recent" frames must use `order=desc` so a large log
 * does not hide the newest page behind the oldest `limit` frames.
 *
 * Prefer this helper over ad-hoc `/api/agentos/events/replay` fetches so the
 * correct order cannot drift call-site by call-site.
 */

export type EventsReplayResult = {
  events: EventEnvelope[];
  /** More matching frames exist than the response limit (older ones dropped). */
  truncated: boolean;
  /** Fetch failed — history could not be loaded. */
  unavailable: boolean;
};

export type FetchEventsReplayOptions = {
  /** Max frames (server caps at 10_000). Default 5000 for evidence pages. */
  limit?: number;
  /**
   * Exclusive upper bound (ULID) for paging older frames in newest-first order.
   * Omit for the newest page.
   */
  before?: string;
  /**
   * Only use `asc` when you genuinely need oldest-first (SSE catch-up).
   * Default is `desc` (newest-first evidence path).
   */
  order?: "asc" | "desc";
  /**
   * When set, server returns only these event types (newest-first matching
   * frames). Prefer this for sparse evidence UIs so an empty page means no
   * matches rather than "no matches in a mixed newest window".
   */
  types?: readonly string[];
};

export async function fetchEventsReplay(
  options: FetchEventsReplayOptions = {},
): Promise<EventsReplayResult> {
  const order = options.order ?? "desc";
  const limit = options.limit ?? 5000;
  const params = new URLSearchParams({
    order,
    limit: String(limit),
  });
  if (options.before !== undefined && options.before.length > 0) {
    params.set("before", options.before);
  }
  if (options.types !== undefined && options.types.length > 0) {
    params.set("types", options.types.join(","));
  }
  try {
    const res = await fetch(`/api/agentos/events/replay?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return { events: [], truncated: false, unavailable: true };
    }
    const body = (await res.json()) as EventsReplayResponse;
    return {
      events: body.events,
      truncated: body.truncated,
      unavailable: false,
    };
  } catch {
    return { events: [], truncated: false, unavailable: true };
  }
}
