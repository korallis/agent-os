"use client";

import { useEffect, useRef, useState } from "react";
import { eventEnvelopeSchema, type EventEnvelope } from "@agent-os/protocol";

/** Named SSE event types (Phase 1–3). Named events do not fire onmessage. */
const EVENT_TYPES = [
  "daemon.started",
  "daemon.stopping",
  "config.installed",
  "config.changed",
  "config.rejected",
  "policy.changed",
  "provider.connection_updated",
  "provider.credential_refreshed",
  "provider.billing_mismatch",
  "quota.updated",
  "quota.threshold",
  "ext.hello",
  "ext.usage",
  "onboarding.step",
  "onboarding.completed",
  "project.registered",
  "project.updated",
  "task.created",
  "task.phase_changed",
  "task.updated",
  "task.cast_resolved",
  "session.spawned",
  "session.stopped",
  "session.lost",
  "worktree.leased",
  "worktree.released",
  "wake.classified",
  "brain.status",
  "brain.handoff",
  "brain.down",
  "tool.invoked",
  "gate.result",
  "fusion.dispatched",
  "captain.escalation",
] as const;

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
