import type { EventEnvelope } from "@agent-os/protocol";

/**
 * Task-scoped event history for Task Detail evidence surfaces.
 *
 * Hits GET /v1/tasks/:id/events so truncation is meaningful for this task
 * alone — a task that never ran tools is empty (not "history truncated"),
 * and a large global log does not hide recent task frames.
 *
 * Always request only tool.invoked + gate.result server-side so chatty
 * wake/session/fusion frames do not consume the page budget and falsely
 * trigger truncation for the evidence panels.
 */

/** Event types the Brain decision lane and validation evidence need. */
export const EVIDENCE_EVENT_TYPES = "tool.invoked,gate.result" as const;

export type TaskEventsResult = {
  events: EventEnvelope[];
  /** This task has more matching events than the response limit. */
  truncated: boolean;
  /** Fetch failed — history could not be loaded. */
  unavailable: boolean;
};

export async function fetchTaskEvents(taskId: string): Promise<TaskEventsResult> {
  try {
    const params = new URLSearchParams({ types: EVIDENCE_EVENT_TYPES });
    const res = await fetch(
      `/api/agentos/tasks/${encodeURIComponent(taskId)}/events?${params.toString()}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return { events: [], truncated: false, unavailable: true };
    }
    const body = (await res.json()) as {
      events: EventEnvelope[];
      truncated: boolean;
    };
    return {
      events: body.events,
      truncated: body.truncated,
      unavailable: false,
    };
  } catch {
    return { events: [], truncated: false, unavailable: true };
  }
}
