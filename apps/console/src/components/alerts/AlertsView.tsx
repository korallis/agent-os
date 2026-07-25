"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { EventEnvelope } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Recent Alerts — Figma frame `41:5674`.
 *
 * Only genuinely actionable frames: quota thresholds, Captain escalations,
 * billing mismatches, SCOUT write violations, brain-down, session loss and
 * rejected config. Routine progress deliberately does not appear here — an
 * alert list that includes everything is one nobody reads.
 */

type LoadState = "loading" | "ready" | "unavailable";

const ALERT_TYPES = new Set([
  "quota.threshold",
  "captain.escalation",
  "provider.billing_mismatch",
  "scout.write_violation",
  "brain.down",
  "session.lost",
  "config.rejected",
]);

interface Alert {
  id: string;
  ts: string;
  type: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
  taskId: string | null;
}

function toAlert(envelope: EventEnvelope): Alert | null {
  const { event } = envelope;
  const base = { id: envelope.id, ts: envelope.ts, type: event.type, taskId: null as string | null };
  switch (event.type) {
    case "quota.threshold":
      return {
        ...base,
        severity: event.payload.level === "limit-reached" ? "critical" : "warn",
        title: `Quota ${event.payload.level} — ${event.payload.provider}`,
        detail: event.payload.reason,
      };
    case "captain.escalation":
      return {
        ...base,
        severity: event.payload.severity === "critical" ? "critical" : "warn",
        title: "Escalated to Captain",
        detail: event.payload.summary,
        taskId: event.payload.taskId,
      };
    case "provider.billing_mismatch":
      return {
        ...base,
        severity: "critical",
        title: "Billing mismatch",
        detail: `expected ${event.payload.expectedPath}, observed ${event.payload.observedPath}`,
      };
    case "scout.write_violation":
      return {
        ...base,
        severity: "critical",
        title: "SCOUT write violation",
        detail: `${event.payload.changedPaths.length} path(s) written in a read-only worktree${event.payload.quarantined ? " — worktree quarantined" : ""}`,
        taskId: event.payload.taskId,
      };
    case "brain.down":
      return {
        ...base,
        severity: "critical",
        title: "Brain down",
        detail: `${event.payload.wakeQueueDepth} wakes queued — ${event.payload.reason}`,
      };
    case "session.lost":
      return {
        ...base,
        severity: "warn",
        title: "Session lost",
        detail: event.payload.reason,
        taskId: event.payload.taskId,
      };
    case "config.rejected":
      return {
        ...base,
        severity: "warn",
        title: `Config rejected — ${event.payload.domain}`,
        detail: `${event.payload.issues[0]?.path ?? ""} ${event.payload.issues[0]?.message ?? ""}`.trim(),
      };
    default:
      return null;
  }
}

const SEVERITY_STYLE: Record<Alert["severity"], string> = {
  critical: "border-danger/30 bg-danger/10 text-danger",
  warn: "border-warn/30 bg-warn/10 text-warn",
  info: "border-line-2 bg-line-1 text-fg-2",
};

export function AlertsView() {
  const { events: streamEvents } = useEventStream();
  const refreshKey = useStickyRefreshKey(
    streamEvents,
    (event) => ALERT_TYPES.has(event.event.type),
    "alerts",
  );
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/agentos/events/replay?limit=5000", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        const body = (await res.json()) as { events: EventEnvelope[] };
        const mapped = body.events
          .map(toAlert)
          .filter((a): a is Alert => a !== null)
          .reverse();
        setAlerts(mapped);
        setState("ready");
      } catch {
        if (!cancelled) setState((prev) => (prev === "ready" ? "ready" : "unavailable"));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (state === "unavailable" && alerts.length === 0) {
    return <EmptyState kind="server-error" body="Could not reach agentosd to load alerts." />;
  }
  if (state === "loading" && alerts.length === 0) {
    return <p className="py-10 text-center text-[13px] text-fg-3">Loading…</p>;
  }
  if (alerts.length === 0) {
    return (
      <EmptyState
        kind="no-data"
        title="No alerts"
        body="Nothing has needed your attention. Quota thresholds, escalations, billing mismatches and write violations appear here."
      />
    );
  }

  const critical = alerts.filter((a) => a.severity === "critical").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          { label: "Critical", value: critical, danger: critical > 0 },
          { label: "Warnings", value: alerts.filter((a) => a.severity === "warn").length, danger: false },
          { label: "Total", value: alerts.length, danger: false },
        ].map((chip) => (
          <div
            key={chip.label}
            className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1"
          >
            <span className="text-[11px] uppercase tracking-wide text-fg-3">{chip.label}</span>
            <span
              className={cn("text-2xl font-semibold", chip.danger ? "text-danger" : "text-fg-1")}
            >
              {chip.value}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
        <ul className="divide-y divide-line-1/60">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex items-start gap-3 px-4 py-3">
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  SEVERITY_STYLE[alert.severity],
                )}
              >
                {alert.severity}
              </span>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fg-1">{alert.title}</span>
                <span className="text-[12px] text-fg-2 break-words">{alert.detail}</span>
                <span className="text-[11px] text-fg-3">
                  {new Date(alert.ts).toLocaleString("en-GB")}
                  {alert.taskId !== null && (
                    <>
                      {" · "}
                      <Link
                        href={`/tasks/${alert.taskId}`}
                        className="text-fg-2 hover:text-fg-1 underline underline-offset-2"
                      >
                        task {alert.taskId.slice(0, 8)}
                      </Link>
                    </>
                  )}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-fg-3">{alert.type}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
