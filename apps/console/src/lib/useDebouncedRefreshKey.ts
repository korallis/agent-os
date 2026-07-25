"use client";

import { useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@agent-os/protocol";

/**
 * Builds a refresh key from SSE frames that match a relevance predicate,
 * debounced so chatty streams do not thrash expensive reloads (e.g. analytics
 * scans of a large in-window event set).
 *
 * Trailing debounce alone starves updates under continuous load: each new
 * relevant frame resets the timer, so the key never advances. `maxWaitMs`
 * forces a flush at least that often from the first pending frame, so live
 * dashboards still update while the fleet is busy.
 *
 * Returns "init" until the first relevant frame is flushed, so the consumer's
 * load effect still runs once on mount.
 */
export function useDebouncedRefreshKey(
  lastEvent: EventEnvelope | null,
  isRelevant: (eventType: string) => boolean,
  debounceMs = 300,
  maxWaitMs = 1000,
): string {
  const [refreshKey, setRefreshKey] = useState("init");
  const pendingIdRef = useRef<string | null>(null);
  const firstPendingAtRef = useRef<number | null>(null);
  const trailingTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastEvent === null) return;
    if (!isRelevant(lastEvent.event.type)) return;

    pendingIdRef.current = lastEvent.id;
    const now = Date.now();
    if (firstPendingAtRef.current === null) {
      firstPendingAtRef.current = now;
    }

    const flush = (): void => {
      const id = pendingIdRef.current;
      if (id !== null) {
        setRefreshKey(id);
      }
      pendingIdRef.current = null;
      firstPendingAtRef.current = null;
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current);
        trailingTimerRef.current = null;
      }
      if (maxWaitTimerRef.current !== null) {
        window.clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
    };

    if (trailingTimerRef.current !== null) {
      window.clearTimeout(trailingTimerRef.current);
    }
    trailingTimerRef.current = window.setTimeout(flush, debounceMs);

    if (maxWaitTimerRef.current === null && firstPendingAtRef.current !== null) {
      const elapsed = now - firstPendingAtRef.current;
      const remaining = Math.max(0, maxWaitMs - elapsed);
      maxWaitTimerRef.current = window.setTimeout(flush, remaining);
    }

    return () => {
      // Keep pending timers across lastEvent identity changes so maxWait spans
      // a burst of frames; only clear when the effect is torn down for real
      // (deps other than lastEvent) via the unmount path below.
    };
  }, [lastEvent, isRelevant, debounceMs, maxWaitMs]);

  useEffect(() => {
    return () => {
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current);
      }
      if (maxWaitTimerRef.current !== null) {
        window.clearTimeout(maxWaitTimerRef.current);
      }
    };
  }, []);

  return refreshKey;
}

/** Event types that change fleet summary / analytics aggregates. */
export function isFleetAnalyticsEvent(eventType: string): boolean {
  return (
    eventType === "ext.usage" ||
    eventType.startsWith("task.") ||
    eventType.startsWith("brain.") ||
    eventType.startsWith("wake.") ||
    eventType.startsWith("quota.")
  );
}

/** Event types that change the notifications wake feed / needs-you chips. */
export function isNotificationsEvent(eventType: string): boolean {
  return (
    eventType.startsWith("wake.") ||
    eventType.startsWith("task.") ||
    eventType.startsWith("brain.") ||
    eventType === "daemon.started"
  );
}
