"use client";

import { cn, MicroLabel } from "@agent-os/ui";
import type { EventEnvelope } from "@agent-os/protocol";
import { useEventStream } from "@/lib/useEventStream";

function summarize(envelope: EventEnvelope): string {
  const { event } = envelope;
  switch (event.type) {
    case "daemon.started":
      return `v${event.payload.version} · pid ${event.payload.pid} · :${event.payload.port}`;
    case "daemon.stopping":
      return event.payload.signal !== null
        ? `${event.payload.reason} (${event.payload.signal})`
        : event.payload.reason;
    case "config.installed":
      return event.payload.domains.join(" · ");
    case "config.changed":
      return `${event.payload.domain} · ${event.payload.layer} · ${event.payload.contentHash.slice(0, 8)}`;
    case "config.rejected":
      return `${event.payload.domain} · ${event.payload.issues[0]?.path ?? ""} ${
        event.payload.issues[0]?.message ?? ""
      }`;
    case "policy.changed":
      return event.payload.safetyOverride ? "safety override ACTIVE" : "all safety policies ON";
    default: {
      const exhaustive: never = event;
      return String(exhaustive);
    }
  }
}

function Stat({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="border-r border-rule px-6 py-5 last:border-r-0 flex-1 min-w-0">
      <MicroLabel className="text-black/40">{label}</MicroLabel>
      <div className={cn("text-display-sm font-bold mt-1 tabular-nums", live && "text-ink")}>
        {value}
      </div>
    </div>
  );
}

/**
 * Fleet dashboard (§7.1) — Phase 1 scope: live daemon connection state and
 * the live event feed over SSE (the pipe proof). Task/quota strips arrive
 * with Phases 2–3 and keep this layout skeleton.
 */
export function FleetDashboard() {
  const { state, events, received } = useEventStream();

  return (
    <div>
      <div className="border-b border-rule px-6 py-4 flex items-center justify-between">
        <MicroLabel className="text-black/60">Fleet</MicroLabel>
        <MicroLabel
          className={cn(
            state === "live" ? "text-ink" : state === "down" ? "text-red-600" : "text-black/40",
          )}
        >
          <span aria-hidden>{state === "live" ? "●" : "◌"} </span>
          event stream {state}
        </MicroLabel>
      </div>

      <div className="flex border-b border-rule">
        <Stat label="Active" value="0" />
        <Stat label="Queued" value="0" />
        <Stat label="Needs you" value="0" />
        <Stat label="Events" value={String(received)} live />
      </div>

      <div className="border-b border-rule px-6 py-4">
        <MicroLabel className="text-black/40">
          Usage strip — live quota probes land in Phase 2 (§7.3)
        </MicroLabel>
      </div>

      <div className="p-6">
        <div className="flex items-center justify-between mb-3">
          <MicroLabel className="text-black/60">Live event feed</MicroLabel>
          <MicroLabel className="text-black/40">NDJSON → SQLite → SSE</MicroLabel>
        </div>
        <div className="bg-ink text-white/90 font-mono text-xs leading-6 p-5 min-h-64 max-h-[28rem] overflow-y-auto">
          {events.length === 0 ? (
            <span className="text-white/40">
              {state === "down"
                ? "agentosd unreachable — start the daemon: agentos start"
                : "waiting for events…"}
            </span>
          ) : (
            <ul>
              {events.map((envelope) => (
                <li key={envelope.id} className="flex gap-4 whitespace-nowrap">
                  <span className="text-white/35 shrink-0 tabular-nums">
                    {new Date(envelope.ts).toLocaleTimeString("en-GB")}
                  </span>
                  <span className="text-white/35 shrink-0 tabular-nums w-10 text-right">
                    #{envelope.seq}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 w-40 uppercase tracking-[0.15em]",
                      envelope.event.type === "config.rejected" ? "text-red-400" : "text-white",
                    )}
                  >
                    {envelope.event.type}
                  </span>
                  <span className="text-white/60 truncate">{summarize(envelope)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
