"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import { Icon } from "@/components/shell/Icon";
import { useEventStream } from "@/lib/useEventStream";

type TaskRow = {
  id: string;
  shape: string;
  title: string;
  phase: string;
  projectId: string;
  projectName: string | null;
  mode: string;
  model: string | null;
  agent: string | null;
  updatedAt: string;
  createdAt: string;
};

function phaseStatus(phase: string): { label: string; dot: string; text: string } {
  if (phase === "DONE") return { label: "Done", dot: "bg-ok", text: "text-ok" };
  if (phase === "FAILED" || phase === "CANCELLED" || phase === "VALIDATION_EXHAUSTED") {
    return {
      label: phase === "CANCELLED" ? "Cancelled" : "Failed",
      dot: "bg-danger",
      text: "text-danger",
    };
  }
  if (phase === "QUEUED" || phase === "WAITING_WORKTREE" || phase === "BLOCKED_DISPATCH") {
    return { label: "Queued", dot: "bg-warn", text: "text-warn" };
  }
  if (phase === "NEEDS_CAPTAIN") return { label: "Needs you", dot: "bg-warn", text: "text-warn" };
  return { label: "Running", dot: "bg-electric", text: "text-electric" };
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Live Inference Jobs board — fed by `/v1/tasks` + SSE (Phase 3).
 */
export function TasksBoard() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { lastEvent } = useEventStream();
  // Re-fetch when fleet-relevant SSE frames arrive (and once on mount).
  const refreshKey =
    lastEvent !== null &&
    (lastEvent.event.type.startsWith("task.") ||
      lastEvent.event.type.startsWith("session.") ||
      lastEvent.event.type === "tool.invoked" ||
      lastEvent.event.type === "daemon.started")
      ? lastEvent.id
      : "init";

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/tasks", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(`daemon ${res.status}`);
          return;
        }
        const body = (await res.json()) as { tasks: TaskRow[] };
        setTasks(body.tasks);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("daemon unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <main className="flex-1 flex flex-col gap-5 p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Icon src="ij-cpu.svg" className="size-[22px]" />
          <h2 className="text-[22px] font-bold text-fg-1">Inference Jobs</h2>
          <span className="rounded-md bg-panel-2 px-2.5 py-1 text-xs font-medium text-fg-2">
            {tasks.length} total
          </span>
          {error !== null && (
            <span className="rounded-md bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
              {error}
            </span>
          )}
        </div>
        <Link
          href="/tasks"
          className="flex items-center gap-1.5 h-9 rounded-lg bg-fg-1 px-4 text-[13px] font-semibold text-black"
        >
          <Icon src="ij-plus.svg" className="size-4" />
          New Job
        </Link>
      </div>

      <div className="bg-panel border border-line-2 rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1.2fr_1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.9fr] gap-2 px-5 py-3 border-b border-line-2 text-[11px] font-semibold uppercase tracking-wide text-fg-3">
          <span>Job</span>
          <span>Model</span>
          <span>Agent</span>
          <span>Shape</span>
          <span>Mode</span>
          <span>Status</span>
          <span>Updated</span>
        </div>
        {tasks.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-fg-3">
            No tasks yet. Register a project and dispatch a SHIP/SCOUT from the CLI or Brain.
          </div>
        ) : (
          tasks.map((task) => {
            const st = phaseStatus(task.phase);
            return (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="grid grid-cols-[1.2fr_1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.9fr] gap-2 px-5 py-3.5 border-b border-line-2/60 hover:bg-panel-2/40 transition-colors"
              >
                <span className="text-[13px] font-medium text-fg-1 truncate">{task.title}</span>
                <span className="text-[13px] text-fg-2 font-mono truncate">
                  {task.model ?? "—"}
                </span>
                <span className="text-[13px] text-fg-2 capitalize">{task.agent ?? "—"}</span>
                <span className="text-[13px] text-fg-2">{task.shape}</span>
                <span className="text-[13px] text-fg-2">{task.mode}</span>
                <span className={cn("flex items-center gap-1.5 text-[13px] font-medium", st.text)}>
                  <span className={cn("size-1.5 rounded-full", st.dot)} />
                  {st.label}
                </span>
                <span className="text-[13px] text-fg-3">{relTime(task.updatedAt)}</span>
              </Link>
            );
          })
        )}
      </div>
    </main>
  );
}
