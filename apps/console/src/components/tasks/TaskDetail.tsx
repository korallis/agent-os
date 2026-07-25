"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import { useEventStream } from "@/lib/useEventStream";
import { useTaskEvents } from "@/lib/useTaskEvents";
import { FusionColumns } from "@/components/tasks/FusionColumns";
import { ValidationEvidence } from "@/components/tasks/ValidationEvidence";
import { BrainDecisionLane } from "@/components/tasks/BrainDecisionLane";

type TaskSnapshot = {
  id: string;
  shape: string;
  title: string;
  intent: string;
  phase: string;
  mode: string;
  cast: Array<{ role: string; model: string; thinking: string; family: string }>;
  sessions: Array<{
    sessionId: string;
    role: string;
    model: string;
    status: string;
    tmuxWindow: string;
    worktreePath: string | null;
  }>;
  validationAttempt: number;
  maxValidations: number;
  branch: string | null;
  needsCaptainSummary: string | null;
  updatedAt: string;
  createdAt: string;
};

/**
 * Task detail with live cast/session columns (Phase 3 foundation; fusion columns Phase 6).
 */
export function TaskDetail({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lastEvent } = useEventStream();
  const taskEvents = useTaskEvents(taskId);
  const refreshKey =
    lastEvent !== null &&
    (lastEvent.event.type.startsWith("task.") ||
      lastEvent.event.type.startsWith("session.") ||
      lastEvent.event.type.startsWith("gate.") ||
      lastEvent.event.type.startsWith("fusion."))
      ? lastEvent.id
      : "init";

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agentos/tasks/${taskId}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 404 ? "not found" : `daemon ${res.status}`);
          return;
        }
        const body = (await res.json()) as { task: TaskSnapshot };
        setTask(body.task);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("daemon unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (error !== null && task === null) {
    return (
      <main className="flex-1 p-8">
        <p className="text-danger text-sm">{error}</p>
        <Link href="/tasks" className="text-sm text-fg-2 underline mt-4 inline-block">
          ← Back to jobs
        </Link>
      </main>
    );
  }

  if (task === null) {
    return <main className="flex-1 p-8 text-fg-3 text-sm">Loading…</main>;
  }

  return (
    <main className="flex-1 flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-2">
        <Link href="/tasks" className="text-[12px] text-fg-3 hover:text-fg-2 w-fit">
          ← Inference Jobs
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-bold text-fg-1">{task.title}</h2>
            <p className="text-[13px] text-fg-3 mt-1 max-w-3xl">{task.intent}</p>
          </div>
          <span className="rounded-lg bg-panel-2 px-3 py-1.5 text-[12px] font-mono text-fg-2">
            {task.phase}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px] text-fg-2">
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5">{task.shape}</span>
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5">{task.mode}</span>
          {task.branch !== null && (
            <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5 font-mono">
              {task.branch}
            </span>
          )}
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5">
            gate {task.validationAttempt}/{task.maxValidations}
          </span>
        </div>
        {task.needsCaptainSummary !== null && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            NEEDS YOU — {task.needsCaptainSummary}
          </div>
        )}
      </div>

      <section>
        <h3 className="text-sm font-semibold text-fg-1 mb-3">Cast</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {task.cast.length === 0 ? (
            <p className="text-[13px] text-fg-3">No cast resolved yet.</p>
          ) : (
            task.cast.map((c) => (
              <div
                key={`${c.role}-${c.model}`}
                className="rounded-2xl border border-line-2 bg-panel p-4 flex flex-col gap-1"
              >
                <span className="text-[11px] uppercase tracking-wide text-fg-3">{c.role}</span>
                <span className="text-[13px] font-mono text-fg-1">{c.model}</span>
                <span className="text-[12px] text-fg-2">
                  {c.family} · {c.thinking}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-fg-1 mb-3">Sessions</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {task.sessions.length === 0 ? (
            <p className="text-[13px] text-fg-3">No crewmates spawned.</p>
          ) : (
            task.sessions.map((s) => (
              <div
                key={s.sessionId}
                className="rounded-2xl border border-line-2 bg-panel p-4 flex flex-col gap-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-fg-3">{s.role}</span>
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      s.status === "running" || s.status === "settled"
                        ? "text-ok"
                        : s.status === "lost"
                          ? "text-danger"
                          : "text-fg-2",
                    )}
                  >
                    {s.status}
                  </span>
                </div>
                <span className="text-[13px] font-mono text-fg-1 truncate">{s.model}</span>
                <span className="text-[11px] text-fg-3 font-mono">{s.tmuxWindow}</span>
                {s.worktreePath !== null && (
                  <span className="text-[11px] text-fg-3 font-mono truncate" title={s.worktreePath}>
                    {s.worktreePath}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <FusionColumns taskId={task.id} />

      <ValidationEvidence
        taskEvents={taskEvents}
        validationAttempt={task.validationAttempt}
        maxValidations={task.maxValidations}
      />

      <BrainDecisionLane taskEvents={taskEvents} />
    </main>
  );
}
