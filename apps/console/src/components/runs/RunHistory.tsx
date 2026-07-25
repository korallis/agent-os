"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { RunHistoryResponse, RunHistoryRow } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Run history — Figma "Pipeline Runs" (`41:5136`) and "Workflow Run History"
 * (`41:7213`).
 *
 * A "run" here is a real task's journey: its phase transitions, gate verdicts
 * and fusion dispatches. Counts come from GET /v1/runs/history — daemon-side
 * aggregates over the full relevant event set — never a paged global replay.
 */

type LoadState = "loading" | "ready" | "unavailable";

const RELEVANT = new Set([
  "task.created",
  "task.phase_changed",
  "gate.result",
  "fusion.dispatched",
  "fusion.completed",
]);

function durationLabel(from: string | null, to: string | null): string {
  if (from === null || to === null) return "—";
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function RunHistory() {
  const { events: streamEvents } = useEventStream();
  const refreshKey = useStickyRefreshKey(
    streamEvents,
    (event) => RELEVANT.has(event.event.type),
    "runs",
  );
  const [rows, setRows] = useState<RunHistoryRow[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/agentos/runs/history", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        const body = (await res.json()) as RunHistoryResponse;
        setRows(body.runs);
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

  if (state === "unavailable" && rows.length === 0) {
    return (
      <EmptyState kind="server-error" body="Could not reach agentosd to load run history." />
    );
  }
  if (state === "loading" && rows.length === 0) {
    return <p className="text-[13px] text-fg-3 py-10 text-center">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        kind="no-data"
        title="No runs yet"
        body="Dispatch a task and its gate and fusion history will appear here."
        action={{ href: "/tasks", label: "Go to tasks" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-panel border border-line-2 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line-1 text-[11px] text-fg-3">
              {["Run", "Shape", "Phase", "Gates", "Fusion", "Duration", "Updated", ""].map((c) => (
                <th key={c} className="px-4 py-2.5 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.task.id} className="border-b border-line-1/60 last:border-b-0">
                <td className="px-4 py-3 text-[13px] font-medium text-fg-1">{row.task.title}</td>
                <td className="px-4 py-3 text-xs text-fg-2">{row.task.shape}</td>
                <td className="px-4 py-3">
                  <span className="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] font-mono text-fg-2">
                    {row.task.phase}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">
                  {row.gateRuns === 0 ? (
                    <span className="text-fg-3">—</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="text-fg-1">{row.gateRuns}</span>
                      {row.gateFailures > 0 && (
                        <span className="text-danger" title="candidate FAIL verdicts">
                          {row.gateFailures}F
                        </span>
                      )}
                      {row.gateErrors > 0 && (
                        <span
                          className="text-warn"
                          title="infrastructure errors — not RED verdicts"
                        >
                          {row.gateErrors}E
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-fg-2">
                  {row.fusionRuns === 0 ? <span className="text-fg-3">—</span> : row.fusionRuns}
                </td>
                <td className="px-4 py-3 text-xs text-fg-2 font-mono">
                  {durationLabel(row.firstSeen, row.lastSeen)}
                </td>
                <td className="px-4 py-3 text-xs text-fg-2">
                  {new Date(row.task.updatedAt).toLocaleTimeString("en-GB")}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/tasks/${row.task.id}`}
                    className={cn(
                      "rounded-lg bg-panel-2 border border-line-1 px-4 py-1.5",
                      "text-xs font-medium text-fg-1",
                    )}
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
