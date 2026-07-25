"use client";

import { useEffect, useState } from "react";
import type { EventEnvelope } from "@agent-os/protocol";

/**
 * Builds a refresh key from SSE frames that match a relevance predicate,
 * debounced so chatty streams do not thrash expensive reloads (e.g. analytics
 * scans of a large in-window event set).
 *
 * Returns "init" until the first relevant frame settles past the debounce, so
 * the consumer's load effect still runs once on mount.
 */
export function useDebouncedRefreshKey(
  lastEvent: EventEnvelope | null,
  isRelevant: (eventType: string) => boolean,
  debounceMs = 300,
): string {
  const [refreshKey, setRefreshKey] = useState("init");

  useEffect(() => {
    if (lastEvent === null) return;
    if (!isRelevant(lastEvent.event.type)) return;
    const timer = window.setTimeout(() => {
      setRefreshKey(lastEvent.id);
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [lastEvent, isRelevant, debounceMs]);

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
