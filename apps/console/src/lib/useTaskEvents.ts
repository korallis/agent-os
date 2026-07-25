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
 * One fetch; refresh only when a frame for this task arrives.
 *
 * Refresh key is sticky: it holds the last relevant event id and only advances
 * when a newly relevant frame arrives. Unrelated SSE frames must not collapse
 * the key back to "init" (that oscillates and re-fetches thrash).
 *
 * Load-state table after the first attempt settles
 * (everSucceeded, lastGoodCount, lastLoadFailed):
 *
 * | everSucceeded | lastGoodCount | lastLoadFailed | panel |
 * |---------------|---------------|----------------|--------|
 * | false         | 0             | true           | unavailable, empty |
 * | true          | 0             | false          | genuine empty (null) |
 * | true          | 0             | true           | unavailable (never “nothing happened”) |
 * | true          | >0            | false          | show data |
 * | true          | >0            | true           | show last-good data + staleness |
 *
 * Rule: lastLoadFailed ⇒ unavailable=true always; success clears it and
 * replaces events. A failed refresh never wipes last-good history.
 */
export function useTaskEvents(taskId: string): TaskEventsState {
  const { lastEvent } = useEventStream();
  const [refreshKey, setRefreshKey] = useState("init");

  useEffect(() => {
    if (lastEvent === null) return;
    if (payloadTaskId(lastEvent) !== taskId) return;
    setRefreshKey(lastEvent.id);
  }, [lastEvent, taskId]);

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
          // lastLoadFailed → unavailable for every settled path above.
          setUnavailable(true);
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
        setUnavailable(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  return { events, truncated, unavailable, loaded };
}
