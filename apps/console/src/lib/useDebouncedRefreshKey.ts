"use client";

import { useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@agent-os/protocol";

/**
 * Newest-first scan for the first envelope that matches `isRelevant`.
 * Looking only at `events[0]` drops relevant frames when React batches a
 * relevant SSE message with a later irrelevant one into a single render
 * (e.g. `task.created` immediately followed by `tool.invoked`).
 */
function newestRelevant(
  events: EventEnvelope[],
  isRelevant: (event: EventEnvelope) => boolean,
): EventEnvelope | null {
  for (const envelope of events) {
    if (isRelevant(envelope)) return envelope;
  }
  return null;
}

/**
 * Sticky refresh key from the newest relevant SSE frame. Unrelated frames leave
 * the prior key in place so load effects do not thrash back to `"init"`.
 *
 * When `scopeKey` changes (e.g. taskId), the key resets to `"init"` so the
 * consumer reloads for the new scope. Uses React's render-time state
 * adjustment (store previous props) rather than an effect.
 *
 * Scans the full newest-first `events` list so a relevant frame buried under
 * a later non-matching tip still advances the key.
 */
export function useStickyRefreshKey(
  events: EventEnvelope[],
  isRelevant: (event: EventEnvelope) => boolean,
  scopeKey?: string,
): string {
  const [stored, setStored] = useState<{ scope: string | undefined; key: string }>({
    scope: scopeKey,
    key: "init",
  });

  let nextScope = stored.scope;
  let nextKey = stored.key;
  if (stored.scope !== scopeKey) {
    nextScope = scopeKey;
    nextKey = "init";
  }
  const relevant = newestRelevant(events, isRelevant);
  if (relevant !== null) {
    nextScope = scopeKey;
    nextKey = relevant.id;
  }
  if (nextScope !== stored.scope || nextKey !== stored.key) {
    setStored({ scope: nextScope, key: nextKey });
  }
  return nextKey;
}

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
 * Scans newest-first `events` for the newest relevant envelope — not only the
 * stream tip — so React-batched non-relevant frames cannot hide a `task.created`
 * (or similar) that must refresh the dashboard within the 1 s gate budget.
 *
 * Returns "init" until the first relevant frame is flushed, so the consumer's
 * load effect still runs once on mount.
 */
export function useDebouncedRefreshKey(
  events: EventEnvelope[],
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
    const relevant = newestRelevant(events, (envelope) => isRelevant(envelope.event.type));
    if (relevant === null) return;
    // Already applied or already scheduled for this exact frame — nothing new.
    if (relevant.id === refreshKey || relevant.id === pendingIdRef.current) return;

    pendingIdRef.current = relevant.id;
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
      // Keep pending timers across events identity changes so maxWait spans
      // a burst of frames; only clear when the effect is torn down for real
      // (deps other than events) via the unmount path below.
    };
  }, [events, isRelevant, debounceMs, maxWaitMs, refreshKey]);

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

/**
 * Billing surface: analytics/spend drivers plus connection list and budget
 * config. Reuses the fleet analytics predicate so usage frames refresh spend
 * on a long visit, and adds provider/config for connection and ceiling rows.
 */
export function isBillingEvent(eventType: string): boolean {
  return (
    isFleetAnalyticsEvent(eventType) ||
    eventType.startsWith("provider.") ||
    eventType === "config.changed"
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
