"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { EventEnvelope, TaskListItem } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Run history — Figma "Pipeline Runs" (`41:5136`) and "Workflow Run History"
 * (`41:7213`).
 *
 * A "run" here is a real task's journey: its phase transitions, gate verdicts
 * and fusion dispatches, reconstructed from the durable event log. Nothing is
 * synthesised — a task with no gate runs simply shows none.
 */

type LoadState = "loading" | "ready" | "unavailable";

interface RunRow {
  task: TaskListItem;
  gateRuns: number;
  gateFailures: number;
  gateErrors: number;
  fusionRuns: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

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
  const [rows, setRows] = useState<RunRow[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [tasksRes, eventsRes] = await Promise.all([
          fetch("/api/agentos/tasks", { cache: "no-store" }),
          fetch("/api/agentos/events/replay?limit=10000", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (!tasksRes.ok || !eventsRes.ok) {
          setState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        const tasks = ((await tasksRes.json()) as { tasks: TaskListItem[] }).tasks;
        const body = (await eventsRes.json()) as {
          events: EventEnvelope[];
          truncated: boolean;
        };

        const byTask = new Map<string, RunRow>();
        for (const task of tasks) {
          byTask.set(task.id, {
            task,
            gateRuns: 0,
            gateFailures: 0,
            gateErrors: 0,
            fusionRuns: 0,
            firstSeen: null,
            lastSeen: null,
          });
        }
        for (const envelope of body.events) {
          const payload = envelope.event.payload as { taskId?: string };
          const taskId = payload.taskId;
          if (taskId === undefined) continue;
          const row = byTask.get(taskId);
          if (row === undefined) continue;
          if (row.firstSeen === null) row.firstSeen = envelope.ts;
          row.lastSeen = envelope.ts;
          if (envelope.event.type === "gate.result") {
            row.gateRuns += 1;
            if (envelope.event.payload.outcome === "FAIL") row.gateFailures += 1;
            if (envelope.event.payload.outcome === "GATE_ERROR") row.gateErrors += 1;
          } else if (envelope.event.type === "fusion.dispatched") {
            row.fusionRuns += 1;
          }
        }
        setRows([...byTask.values()].sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt)));
        setTruncated(body.truncated);
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
      {truncated && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-2 text-[11px] text-warn">
          Event history was truncated — counts reflect the most recent frames only.
        </div>
      )}
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
