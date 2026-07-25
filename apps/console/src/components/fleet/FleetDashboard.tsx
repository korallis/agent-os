"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { AnalyticsSnapshot, TaskListItem } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Fleet (§7.1) — the Figma "Home Dashboard" frame (node 10:11978).
 *
 * Every panel is bound to daemon state: the stat chips to the fleet summary,
 * Swarm Activity to task throughput from the event log, Token Consumption to
 * `ext.usage` telemetry, Top Agents to per-role usage, and Recent Tasks to the
 * real task list. Where a value cannot be derived — most often cost, which not
 * every provider reports — the panel says so rather than showing a number that
 * looks authoritative and is invented.
 */

const DONE_PHASES = new Set(["DONE"]);
const FAILED_PHASES = new Set(["FAILED", "VALIDATION_EXHAUSTED", "CANCELLED"]);

function statusOf(phase: string): { label: string; className: string } {
  if (DONE_PHASES.has(phase)) return { label: "Done", className: "bg-ok/10 text-ok" };
  if (FAILED_PHASES.has(phase)) return { label: "Failed", className: "bg-danger/10 text-danger" };
  if (phase === "QUEUED" || phase === "WAITING_WORKTREE") {
    return { label: "Queued", className: "bg-line-1 text-fg-2" };
  }
  if (phase === "NEEDS_CAPTAIN") return { label: "Needs you", className: "bg-warn/10 text-warn" };
  return { label: "Running", className: "bg-teal-brand/10 text-teal-brand" };
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("bg-panel border border-line-2 rounded-2xl overflow-hidden", className)}>
      {children}
    </div>
  );
}

/** Inline sparkline over real daily values — no chart library, no fixture asset. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return <div className="h-full w-full" />;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const coords = points.map((p, i) => `${i * step},${40 - (p / max) * 36}`);
  const line = `M${coords.join(" L")}`;
  const area = `${line} L100,40 L0,40 Z`;
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="swarm-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#swarm-fill)" />
      <path
        d={line}
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SwarmActivityCard({
  analytics,
  lastEventAt,
}: {
  analytics: AnalyticsSnapshot | null;
  lastEventAt: string | null;
}) {
  const ready = analytics !== null;
  const daily = analytics?.daily ?? [];
  const completed = daily.map((d) => d.tasksCompleted);
  const totalCompleted = ready ? completed.reduce((a, b) => a + b, 0) : null;
  // Compare the most recent half of the window with the previous half — a real
  // trend over real data, null when there is not enough history to claim one.
  const half = Math.floor(daily.length / 2);
  const prior = completed.slice(0, half).reduce((a, b) => a + b, 0);
  const recent = completed.slice(half).reduce((a, b) => a + b, 0);
  const deltaPct =
    !ready || prior === 0 ? null : Number((((recent - prior) / prior) * 100).toFixed(1));
  const axis = [0, Math.floor(daily.length / 3), Math.floor((daily.length * 2) / 3), daily.length - 1]
    .map((i) => daily[i])
    .filter((d): d is NonNullable<typeof d> => d !== undefined);

  return (
    <div
      className="relative border border-line-2 rounded-2xl overflow-hidden p-6 flex flex-col gap-5"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 340px 390px at 5% 4%, rgba(59,130,246,0.08) 0%, rgba(59,130,246,0) 100%), radial-gradient(ellipse 360px 230px at 86% 80%, rgba(45,212,191,0.2) 0%, rgba(13,148,136,0) 100%), linear-gradient(90deg, #1a1a1a 0%, #1a1a1a 100%)",
      }}
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-fg-1">Swarm Activity</h3>
          <Icon src="info.svg" className="size-4" />
        </div>
        <div className="flex items-start justify-between">
          <span className="text-[13px] text-fg-2">Tasks completed</span>
          <span className="text-[13px] text-fg-2">
            {ready ? `last ${analytics.windowDays} days` : "unavailable"}
          </span>
        </div>
        <div className="flex items-start justify-between">
          <span className="text-xs text-fg-3">Total</span>
          <span className="text-sm font-bold text-fg-1">
            {totalCompleted === null ? "—" : totalCompleted}
          </span>
        </div>
      </div>
      <div className="relative h-[161px] w-full overflow-hidden">
        <Sparkline points={ready ? completed : []} />
      </div>
      <div className="flex items-start justify-between text-[11px] text-fg-3">
        {!ready ? (
          <span>Usage snapshot unavailable</span>
        ) : axis.length > 0 ? (
          axis.map((d, i) => <span key={`${d.day}-${i}`}>{d.day.slice(5)}</span>)
        ) : (
          <span>No activity recorded yet</span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-[22px] font-bold",
            deltaPct === null ? "text-fg-3" : deltaPct >= 0 ? "text-teal-brand" : "text-danger",
          )}
        >
          {deltaPct === null ? "—" : `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`}
        </span>
        <span className="text-[11px] text-fg-3">
          {lastEventAt !== null ? `Last updated ${lastEventAt}` : "Awaiting first event"}
        </span>
      </div>
    </div>
  );
}

function TokenConsumptionCard({ analytics }: { analytics: AnalyticsSnapshot | null }) {
  const totals = analytics?.totals;
  const ready = analytics !== null;
  const tokens =
    totals === undefined ? null : totals.inputTokens + totals.outputTokens;
  const cost = totals?.costUsd ?? null;
  const topModels = (analytics?.models ?? []).slice(0, 4);
  const modelMax = Math.max(...topModels.map((m) => m.inputTokens + m.outputTokens), 1);

  return (
    <Card className="p-6 flex flex-col">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-fg-1">Token Consumption</h3>
          <p className="text-[13px] text-fg-2">The sum of all token usage</p>
        </div>
        <span className="flex items-center gap-2 h-9 rounded-lg bg-panel-2 px-3 text-xs font-medium text-fg-2">
          {analytics?.windowDays ?? "—"}
          {analytics !== null ? "d" : ""}
        </span>
      </div>
      <p className="mt-4 text-4xl font-medium text-fg-1">
        {tokens === null ? "—" : compactNumber(tokens)}
      </p>
      <p className="mt-4 text-[11px] text-fg-3">
        {!ready
          ? "Usage snapshot unavailable"
          : totals?.costCoverage === "partial"
            ? `partial — ${totals.costReportedRequests} of ${totals.requests} requests reported cost ($${cost?.toFixed(2) ?? "0.00"})`
            : cost !== null
              ? `$${cost.toFixed(2)} reported by providers`
              : "Cost not reported by any connected provider"}
      </p>
      <p className="mt-2 text-xs text-fg-3">
        {!ready
          ? "—"
          : `${totals?.requests ?? 0} requests · in ${compactNumber(totals?.inputTokens ?? 0)} / out ${compactNumber(totals?.outputTokens ?? 0)}`}
      </p>
      <div className="mt-3 flex-1 rounded-2xl bg-panel-2 p-4 flex flex-col gap-3">
        {!ready ? (
          <EmptyState
            kind="no-data"
            title="Usage unavailable"
            body="Token consumption appears once the analytics snapshot loads."
            className="border-0 bg-transparent my-auto py-6"
          />
        ) : topModels.length === 0 ? (
          <EmptyState
            kind="no-data"
            title="No model usage yet"
            body="Spawn a crewmate to see consumption here."
            className="border-0 bg-transparent my-auto py-6"
          />
        ) : (
          topModels.map((m) => {
            const total = m.inputTokens + m.outputTokens;
            return (
              <div key={m.model} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono text-fg-2 truncate">{m.model}</span>
                  <span className="text-fg-1 shrink-0 ml-2">{compactNumber(total)}</span>
                </div>
                <div className="h-1.5 rounded-sm bg-line-2 overflow-hidden">
                  <div
                    className="h-full rounded-sm bg-teal-brand"
                    style={{ width: `${(total / modelMax) * 100}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

/** Real, useful actions for a local single-user fleet — not a SaaS upsell. */
function QuickActionsCard({ needsCaptain }: { needsCaptain: number }) {
  const actions = [
    { href: "/tasks", label: "Tasks board", hint: "Dispatch and track work" },
    { href: "/projects", label: "Projects", hint: "Register a repository" },
    { href: "/providers", label: "Providers & quota", hint: "Connections and limits" },
    { href: "/runs", label: "Live log stream", hint: "Everything the fleet emits" },
    { href: "/policies", label: "Policies", hint: "Layered config and safety" },
  ];
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg-1">Quick Actions</h3>
      </div>
      {needsCaptain > 0 && (
        <Link
          href="/notifications"
          className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 flex flex-col gap-1"
        >
          <span className="text-xs font-semibold text-warn">
            {needsCaptain} task{needsCaptain === 1 ? "" : "s"} need you
          </span>
          <span className="text-[11px] text-fg-2">Open the wake queue →</span>
        </Link>
      )}
      <div className="flex flex-col gap-2">
        {actions.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="rounded-xl bg-panel-2 border border-line-1 px-4 py-3 flex flex-col gap-0.5 hover:border-line-2 transition-colors"
          >
            <span className="text-[13px] font-medium text-fg-1">{action.label}</span>
            <span className="text-[11px] text-fg-3">{action.hint}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function TopAgentsCard({ analytics }: { analytics: AnalyticsSnapshot | null }) {
  const agents = (analytics?.agents ?? []).slice(0, 5);
  return (
    <Card className="w-[420px] shrink-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <h3 className="text-base font-semibold text-fg-1 py-1.5">Top Agents</h3>
        <span className="text-xs font-medium text-fg-3">
          {agents.length} role{agents.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {agents.length === 0 && (
          <EmptyState
            kind="no-data"
            title="No agent telemetry yet"
            body="Per-role usage appears as crewmates report tokens."
            className="border-0 bg-transparent py-6"
          />
        )}
        {agents.map((agent) => (
          <div
            key={agent.role}
            className="rounded-[14px] bg-panel-2 border border-line-1 p-3.5 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-[5px] bg-ok" />
                <span className="text-sm font-semibold text-fg-1 capitalize">{agent.role}</span>
              </span>
              <span className="text-[11px] text-fg-3">{agent.sharePct}% of tokens</span>
            </div>
            <div className="h-px bg-line-1" />
            <div className="flex gap-5">
              {(
                [
                  ["Input", compactNumber(agent.inputTokens)],
                  ["Output", compactNumber(agent.outputTokens)],
                  ["Requests", String(agent.requests)],
                ] as const
              ).map(([label, value]) => (
                <span key={label} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-fg-3">{label}</span>
                  <span className="text-sm font-semibold text-fg-1">{value}</span>
                </span>
              ))}
            </div>
            <div className="h-1 rounded-sm bg-line-2 overflow-hidden">
              <div
                className="h-full rounded-sm bg-teal-brand"
                style={{ width: `${agent.sharePct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RecentTasksTable({ tasks }: { tasks: TaskListItem[] }) {
  const recent = tasks.slice(0, 8);
  return (
    <Card className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h3 className="text-base font-semibold text-fg-1">Recent Tasks</h3>
        <Link href="/tasks" className="text-xs font-medium text-fg-2 hover:text-fg-1">
          View all →
        </Link>
      </div>
      {recent.length === 0 ? (
        <EmptyState
          kind="no-data"
          title="No tasks yet"
          body="Register a project and dispatch one to see it here."
          className="border-0 bg-transparent mx-4 my-6"
        />
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line-1 text-[11px] text-fg-3">
              {["Task", "Agent", "Model", "Shape", "Updated", "Status", ""].map((column) => (
                <th key={column} className="px-4 py-2.5 font-normal">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recent.map((task) => {
              const status = statusOf(task.phase);
              return (
                <tr key={task.id} className="border-b border-line-1/60 last:border-b-0">
                  <td className="px-4 py-3 text-[13px] font-medium text-fg-1">{task.title}</td>
                  <td className="px-4 py-3 text-[13px] text-fg-2 capitalize">
                    {task.agent ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-fg-2">{task.model ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-fg-2">{task.shape}</td>
                  <td className="px-4 py-3 text-xs text-fg-2">
                    {new Date(task.updatedAt).toLocaleTimeString("en-GB")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-semibold",
                        status.className,
                      )}
                    >
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/tasks/${task.id}`}
                      className="rounded-lg bg-panel-2 border border-line-1 px-4 py-1.5 text-xs font-medium text-fg-1"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

interface FleetSummaryView {
  active: number;
  queued: number;
  needsCaptain: number;
  doneToday: number;
  brainDown: boolean;
  brainStatus: string;
}

export function FleetDashboard() {
  const { events, lastEvent } = useEventStream();
  const refreshKey = lastEvent?.id ?? "init";
  const [summary, setSummary] = useState<FleetSummaryView | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [fleetRes, analyticsRes, tasksRes] = await Promise.allSettled([
        fetch("/api/agentos/fleet", { cache: "no-store" }),
        fetch("/api/agentos/analytics", { cache: "no-store" }),
        fetch("/api/agentos/tasks", { cache: "no-store" }),
      ]);
      if (cancelled) return;

      if (fleetRes.status === "fulfilled" && fleetRes.value.ok) {
        const body = (await fleetRes.value.json()) as {
          summary: FleetSummaryView & { brain: { status: string } };
        };
        setSummary({
          active: body.summary.active,
          queued: body.summary.queued,
          needsCaptain: body.summary.needsCaptain,
          doneToday: body.summary.doneToday,
          brainDown: body.summary.brainDown,
          brainStatus: body.summary.brain.status,
        });
      }
      if (analyticsRes.status === "fulfilled" && analyticsRes.value.ok) {
        setAnalytics((await analyticsRes.value.json()) as AnalyticsSnapshot);
      }
      if (tasksRes.status === "fulfilled" && tasksRes.value.ok) {
        const body = (await tasksRes.value.json()) as { tasks: TaskListItem[] };
        setTasks(body.tasks);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const latest = events[0];
  const lastEventAt =
    latest !== undefined
      ? new Date(latest.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : null;

  return (
    <div className="flex flex-col gap-5 p-8 pt-6">
      {analytics?.truncated === true && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 text-[12px] text-warn">
          Event history for this window was truncated at the analytics read bound —
          Token Consumption and Top Agents keep the newest frames and may omit older
          ones inside the {analytics.windowDays}-day range.
        </div>
      )}
      {summary !== null && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Active", value: summary.active },
            { label: "Queued", value: summary.queued },
            { label: "Needs you", value: summary.needsCaptain },
            { label: "Done today", value: summary.doneToday },
            { label: "Brain", value: summary.brainDown ? "DOWN" : summary.brainStatus },
          ].map((chip) => (
            <div
              key={chip.label}
              className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1"
            >
              <span className="text-[11px] uppercase tracking-wide text-fg-3">{chip.label}</span>
              <span
                className={cn(
                  "text-2xl font-semibold",
                  chip.label === "Brain" && summary.brainDown ? "text-danger" : "text-fg-1",
                )}
              >
                {chip.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {summary?.brainDown === true && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          BRAIN DOWN — sessions alive · wakes queued · no orchestration until restart
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_260px] gap-4">
        <SwarmActivityCard analytics={analytics} lastEventAt={lastEventAt} />
        <TokenConsumptionCard analytics={analytics} />
        <QuickActionsCard needsCaptain={summary?.needsCaptain ?? 0} />
      </div>
      <div className="flex gap-4 items-start">
        <TopAgentsCard analytics={analytics} />
        <RecentTasksTable tasks={tasks} />
      </div>
    </div>
  );
}
