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
 * One fetch, refresh only when a frame for this task arrives, and prior data
 * stays on screen while reloading.
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

  useEffect(() => {
    let cancelled = false;
    if (boundTaskId.current !== taskId) {
      boundTaskId.current = taskId;
      setEvents([]);
      setTruncated(false);
      setUnavailable(false);
      setLoaded(false);
    }
    void fetchTaskEvents(taskId)
      .then((result) => {
        if (cancelled) return;
        setEvents(result.events);
        setTruncated(result.truncated);
        setUnavailable(result.unavailable);
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
