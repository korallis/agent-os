"use client";

import { useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@agent-os/protocol";
import { useEventStream } from "@/lib/useEventStream";
import { fetchTaskEvents } from "@/lib/fetchTaskEvents";

export type TaskEventsState = {
  events: EventEnvelope[];
  truncated: boolean;
  unavailable: boolean;
  /** True after the first fetch attempt settles (success or failure). */
  loaded: boolean;
};

function payloadTaskId(event: EventEnvelope): string | null {
  const payload = event.event.payload as { taskId?: string | null };
  return typeof payload.taskId === "string" ? payload.taskId : null;
}

/**
 * Shared task-scoped event history for Brain decisions + validation evidence.
 * One fetch, refresh only when a frame for this task arrives.
 *
 * On a failed refresh after a successful load, the last good events and
 * truncated flag are kept and `unavailable` is set only when there is prior
 * data to protect — panels can show real data plus a staleness note instead of
 * wiping to an empty "nothing happened" state. A failed first load still
 * surfaces as unavailable with no events.
 */
export function useTaskEvents(taskId: string): TaskEventsState {
  const { lastEvent } = useEventStream();
  const refreshKey =
    lastEvent !== null && payloadTaskId(lastEvent) === taskId
      ? lastEvent.id
      : "init";

  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const boundTaskId = useRef(taskId);
  const everSucceeded = useRef(false);
  const lastGoodCount = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (boundTaskId.current !== taskId) {
      boundTaskId.current = taskId;
      everSucceeded.current = false;
      lastGoodCount.current = 0;
      setEvents([]);
      setTruncated(false);
      setUnavailable(false);
      setLoaded(false);
    }
    void fetchTaskEvents(taskId)
      .then((result) => {
        if (cancelled) return;
        if (result.unavailable) {
          if (!everSucceeded.current) {
            setUnavailable(true);
          } else if (lastGoodCount.current > 0) {
            // Keep last good events + truncated; only mark unavailable when
            // there is prior data on screen to protect.
            setUnavailable(true);
          }
          setLoaded(true);
          return;
        }
        everSucceeded.current = true;
        lastGoodCount.current = result.events.length;
        setEvents(result.events);
        setTruncated(result.truncated);
        setUnavailable(false);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        if (!everSucceeded.current) {
          setUnavailable(true);
        } else if (lastGoodCount.current > 0) {
          setUnavailable(true);
        }
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  return { events, truncated, unavailable, loaded };
}
