"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { FleetStateSnapshot, TaskListItem, WakeDigest } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Notifications — the Figma "Notifications" frame (node 17:940), rendered as
 * the fleet's real wake queue (master plan §7.1 "THE BRAIN HEARD" + needs-you).
 *
 * The zero-token watcher classifies every wake in code; this screen shows what
 * it decided, including the ones it deliberately ABSORBED. Showing absorbed
 * wakes matters — it is the evidence that supervision is not silently spending
 * Brain tokens on routine progress.
 */

type Filter = "All" | "Needs you" | "Delivered" | "Absorbed";
type LoadStatus = "loading" | "ready" | "unavailable";

const SEVERITY: Record<string, { className: string; label: string }> = {
  SECURITY: { className: "bg-danger/10 text-danger border-danger/30", label: "Security" },
  FAILED: { className: "bg-danger/10 text-danger border-danger/30", label: "Failed" },
  GATE_FAILED: { className: "bg-danger/10 text-danger border-danger/30", label: "Gate failed" },
  GATE_DEFECT: { className: "bg-danger/10 text-danger border-danger/30", label: "Gate defect" },
  SESSION_LOST: { className: "bg-danger/10 text-danger border-danger/30", label: "Session lost" },
  NEEDS_INPUT: { className: "bg-warn/10 text-warn border-warn/30", label: "Needs input" },
  BLOCKED: { className: "bg-warn/10 text-warn border-warn/30", label: "Blocked" },
  AUTH_OR_QUOTA: { className: "bg-warn/10 text-warn border-warn/30", label: "Auth / quota" },
  QUOTA_THRESHOLD: { className: "bg-warn/10 text-warn border-warn/30", label: "Quota" },
  BILLING_MISMATCH: { className: "bg-warn/10 text-warn border-warn/30", label: "Billing" },
  WEDGED: { className: "bg-warn/10 text-warn border-warn/30", label: "Wedged" },
};

function chipFor(wake: WakeDigest): { className: string; label: string } {
  return (
    SEVERITY[wake.class] ?? {
      className: "bg-line-1 text-fg-2 border-line-2",
      label: wake.class.replace(/_/g, " ").toLowerCase(),
    }
  );
}

function chipValue(status: LoadStatus, value: number): string {
  if (status === "loading") return "—";
  if (status === "unavailable") return "—";
  return String(value);
}

export function NotificationsView() {
  const { lastEvent } = useEventStream();
  const refreshKey = lastEvent?.id ?? "init";
  const [wakes, setWakes] = useState<WakeDigest[]>([]);
  const [queue, setQueue] = useState<WakeDigest[]>([]);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [wakesStatus, setWakesStatus] = useState<LoadStatus>("loading");
  const [queueStatus, setQueueStatus] = useState<LoadStatus>("loading");
  const [tasksStatus, setTasksStatus] = useState<LoadStatus>("loading");
  const [filter, setFilter] = useState<Filter>("All");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [wakesRes, stateRes, tasksRes] = await Promise.allSettled([
        fetch("/api/agentos/fleet/wakes", { cache: "no-store" }),
        fetch("/api/agentos/fleet/state", { cache: "no-store" }),
        fetch("/api/agentos/tasks", { cache: "no-store" }),
      ]);
      if (cancelled) return;
      if (wakesRes.status === "fulfilled" && wakesRes.value.ok) {
        const body = (await wakesRes.value.json()) as { wakes: WakeDigest[] };
        setWakes([...body.wakes].reverse());
        setWakesStatus("ready");
      } else {
        setWakesStatus((prev) => (prev === "ready" ? prev : "unavailable"));
      }
      if (stateRes.status === "fulfilled" && stateRes.value.ok) {
        const body = (await stateRes.value.json()) as { state: FleetStateSnapshot };
        setQueue(body.state.wakeQueue);
        setQueueStatus("ready");
      } else {
        setQueueStatus((prev) => (prev === "ready" ? prev : "unavailable"));
      }
      if (tasksRes.status === "fulfilled" && tasksRes.value.ok) {
        const body = (await tasksRes.value.json()) as { tasks: TaskListItem[] };
        setTasks(body.tasks);
        setTasksStatus("ready");
      } else {
        setTasksStatus((prev) => (prev === "ready" ? prev : "unavailable"));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const needsCaptain = useMemo(
    () => tasks.filter((t) => t.phase === "NEEDS_CAPTAIN"),
    [tasks],
  );

  const visible = useMemo(() => {
    switch (filter) {
      case "Delivered":
        return wakes.filter((w) => w.deliveredToBrain);
      case "Absorbed":
        return wakes.filter((w) => w.absorbed);
      case "Needs you":
        return wakes.filter((w) => SEVERITY[w.class] !== undefined);
      default:
        return wakes;
    }
  }, [wakes, filter]);

  const counts = useMemo(
    () => ({
      delivered: wakes.filter((w) => w.deliveredToBrain).length,
      absorbed: wakes.filter((w) => w.absorbed).length,
    }),
    [wakes],
  );

  return (
    <main className="flex-1 flex flex-col gap-5 p-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <Icon src="bell.svg" className="size-5" />
            <h2 className="text-[22px] font-bold text-fg-1">Notifications</h2>
          </div>
          <p className="text-[13px] text-fg-2">
            The wake queue — what the watcher classified, and what reached the Brain
          </p>
        </div>
        <div className="flex gap-0.5 bg-panel-2 border border-line-2 rounded-[10px] p-1">
          {(["All", "Needs you", "Delivered", "Absorbed"] as const).map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => setFilter(label)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-xs transition-colors",
                filter === label
                  ? "bg-line-2 font-semibold text-fg-1"
                  : "font-medium text-fg-3 hover:text-fg-2",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Needs you",
            value: chipValue(tasksStatus, needsCaptain.length),
            danger: tasksStatus === "ready" && needsCaptain.length > 0,
          },
          {
            label: "Queued for Brain",
            value: chipValue(queueStatus, queue.length),
            danger: false,
          },
          {
            label: "Delivered",
            value: chipValue(wakesStatus, counts.delivered),
            danger: false,
          },
          {
            label: "Absorbed (zero-token)",
            value: chipValue(wakesStatus, counts.absorbed),
            danger: false,
          },
        ].map((chip) => (
          <div
            key={chip.label}
            className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1"
          >
            <span className="text-[11px] uppercase tracking-wide text-fg-3">{chip.label}</span>
            <span
              className={cn(
                "text-2xl font-semibold",
                chip.danger ? "text-warn" : "text-fg-1",
              )}
            >
              {chip.value}
            </span>
          </div>
        ))}
      </div>

      {tasksStatus === "ready" && needsCaptain.length > 0 && (
        <div className="rounded-2xl border border-warn/30 bg-warn/[0.06] p-5 flex flex-col gap-3">
          <h3 className="text-[15px] font-semibold text-warn">Waiting on you</h3>
          {needsCaptain.map((task) => (
            <Link
              key={task.id}
              href={`/tasks/${task.id}`}
              className="flex items-center justify-between rounded-xl bg-panel border border-line-1 px-4 py-3 hover:border-line-2 transition-colors"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fg-1">{task.title}</span>
                <span className="text-[11px] text-fg-3">
                  {task.shape} · {task.projectName ?? "—"} · {task.phase}
                </span>
              </span>
              <span className="text-xs text-fg-2">Open →</span>
            </Link>
          ))}
        </div>
      )}

      <div className="bg-panel border border-line-2 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line-1">
          <h3 className="text-base font-semibold text-fg-1">Wake feed</h3>
          <span className="text-[11px] text-fg-3">
            {wakesStatus === "ready" ? `${visible.length} shown` : "—"}
          </span>
        </div>
        {wakesStatus === "loading" && wakes.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-fg-3">Loading wakes…</p>
        ) : wakesStatus === "unavailable" && wakes.length === 0 ? (
          <EmptyState
            kind="server-error"
            title="Wakes unavailable"
            body="The wake queue could not be loaded from the daemon."
            className="border-0 bg-transparent m-4"
          />
        ) : visible.length === 0 ? (
          wakes.length === 0 ? (
            <EmptyState
              kind="no-data"
              title="No wakes recorded yet"
              body="The zero-token watcher will list every classified wake here as the fleet runs."
              className="border-0 bg-transparent m-4"
            />
          ) : (
            <EmptyState
              kind="no-results"
              title="No matching wakes"
              body="No wakes match the current filter. Try All or another chip."
              className="border-0 bg-transparent m-4"
            />
          )
        ) : (
          <ul className="divide-y divide-line-1/60">
            {visible.map((wake) => {
              const chip = chipFor(wake);
              return (
                <li key={wake.id} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      chip.className,
                    )}
                  >
                    {chip.label}
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-[13px] text-fg-1 break-words">{wake.summary}</span>
                    <span className="text-[11px] text-fg-3">
                      {new Date(wake.createdAt).toLocaleTimeString("en-GB")}
                      {wake.taskId !== null && (
                        <>
                          {" · "}
                          <Link
                            href={`/tasks/${wake.taskId}`}
                            className="text-fg-2 hover:text-fg-1 underline underline-offset-2"
                          >
                            task {wake.taskId.slice(0, 8)}
                          </Link>
                        </>
                      )}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[10px] font-semibold uppercase tracking-wide",
                      wake.absorbed
                        ? "text-fg-3"
                        : wake.deliveredToBrain
                          ? "text-teal-brand"
                          : "text-warn",
                    )}
                    title={
                      wake.absorbed
                        ? "Absorbed by the zero-token watcher — no Brain tokens spent"
                        : wake.deliveredToBrain
                          ? "Delivered to the Brain for a decision"
                          : "Queued — the Brain is down"
                    }
                  >
                    {wake.absorbed ? "absorbed" : wake.deliveredToBrain ? "delivered" : "queued"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
