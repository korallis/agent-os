"use client";

import { useEffect, useRef, useState } from "react";
import {
  ORCHESTRATOR_EVENT_TYPES,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@agent-os/protocol";

/** Named SSE event types derived from the protocol schema so they cannot drift. */
const EVENT_TYPES = ORCHESTRATOR_EVENT_TYPES;

export type StreamState = "connecting" | "live" | "down";

export interface EventStream {
  state: StreamState;
  /** Newest first, capped. */
  events: EventEnvelope[];
  /** Newest single envelope (or null before first). */
  lastEvent: EventEnvelope | null;
  /** Total envelopes received this session (incl. replay). */
  received: number;
}

/**
 * Subscribes to the daemon SSE stream through the BFF (`/api/agentos/events`).
 * EventSource reconnects automatically; replay-on-reconnect comes from the
 * daemon's Last-Event-ID handling.
 */
export function useEventStream(cap = 100): EventStream {
  const [state, setState] = useState<StreamState>("connecting");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const receivedRef = useRef(0);
  const [received, setReceived] = useState(0);

  useEffect(() => {
    const source = new EventSource("/api/agentos/events");
    source.onopen = () => setState("live");
    source.onerror = () => setState("down");

    const onFrame = (frame: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        return;
      }
      const envelope = eventEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) return;
      receivedRef.current += 1;
      setReceived(receivedRef.current);
      setEvents((current) => {
        if (current.some((e) => e.id === envelope.data.id)) return current;
        return [envelope.data, ...current].slice(0, cap);
      });
    };

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, onFrame);
    }
    return () => {
      source.close();
    };
  }, [cap]);

  return { state, events, lastEvent: events[0] ?? null, received };
}
