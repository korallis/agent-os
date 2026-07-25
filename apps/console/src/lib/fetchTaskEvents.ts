import type { EventEnvelope } from "@agent-os/protocol";

/**
 * Newest-first event scan for Task Detail evidence surfaces.
 *
 * The daemon's default replay is oldest-first and capped; once the log grows
 * past that page, recent tool.invoked / gate.result frames fall off the
 * oldest page and evidence goes blank. This helper pages newest-first until
 * exhausted (or a hard page budget) and reports truncation honestly.
 *
 * Fetch failure and "nothing happened" are distinct: a failed first page
 * returns `unavailable: true` so panels never render as empty evidence.
 */

const PAGE_LIMIT = 2000;
const MAX_PAGES = 25;

export type TaskEventsResult = {
  events: EventEnvelope[];
  truncated: boolean;
  /** First page failed or threw — history could not be loaded. */
  unavailable: boolean;
};

export async function fetchTaskEvents(
  taskId: string,
  types: ReadonlySet<string>,
): Promise<TaskEventsResult> {
  const mine: EventEnvelope[] = [];
  let before: string | null = null;
  let moreRemain = false;
  let pages = 0;

  try {
    while (pages < MAX_PAGES) {
      pages += 1;
      const params = new URLSearchParams({
        order: "desc",
        limit: String(PAGE_LIMIT),
      });
      if (before !== null) params.set("before", before);

      const res = await fetch(`/api/agentos/events/replay?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (before === null) {
          return { events: [], truncated: false, unavailable: true };
        }
        moreRemain = true;
        break;
      }

      const body = (await res.json()) as {
        events: EventEnvelope[];
        truncated: boolean;
      };
      moreRemain = body.truncated;

      if (body.events.length === 0) {
        moreRemain = false;
        break;
      }

      for (const envelope of body.events) {
        if (!types.has(envelope.event.type)) continue;
        const payload = envelope.event.payload as { taskId?: string | null };
        if (payload.taskId !== taskId) continue;
        mine.push(envelope);
      }

      const oldest = body.events[body.events.length - 1];
      if (oldest === undefined) {
        moreRemain = false;
        break;
      }
      before = oldest.id;

      if (!body.truncated) break;
    }
  } catch {
    if (before === null) {
      return { events: [], truncated: false, unavailable: true };
    }
    moreRemain = true;
  }

  mine.reverse();
  return { events: mine, truncated: moreRemain, unavailable: false };
}
