"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { Icon } from "@/components/shell/Icon";
import { useEventStream } from "@/lib/useEventStream";

/* Static roster/table data — pixel-faithful renderings of the Figma design.
   The task engine that feeds these lands in Phase 3 (master plan §11). */

const TOP_AGENTS = [
  {
    name: "Coder Agent",
    metric: "3,074 Tasks completed",
    delta: "+9.23 %",
    tools: ["tool-monitor.svg", "tool-terminal.svg", "tool-braces.svg"],
    tokens: "847K",
    latency: "1.2s",
    success: "98.7%",
    quotaLabel: "Task Quota",
    quota: "3,074 / 3,500",
    quotaPct: 88,
  },
  {
    name: "Writer Agent",
    metric: "2,931 Docs generated",
    delta: "+7.59 %",
    tools: ["tool-doc.svg", "tool-globe.svg", "tool-book.svg"],
    tokens: "621K",
    latency: "2.4s",
    success: "96.2%",
    quotaLabel: "Doc Quota",
    quota: "2,931 / 3,000",
    quotaPct: 98,
  },
] as const;

type TaskStatus = "Done" | "Failed" | "Queued";

const RECENT_TASKS: {
  rank: string;
  task: string;
  agent: string;
  avatar: string;
  created: string;
  type: string;
  tokens: string;
  status: TaskStatus;
}[] = [
  { rank: "#1", task: "API Refactor", agent: "Coder", avatar: "avatar-coder.jpg", created: "03/12/2026", type: "Code Gen", tokens: "12.4k", status: "Done" },
  { rank: "#2", task: "Unit Tests", agent: "Tester", avatar: "avatar-tester.jpg", created: "03/11/2026", type: "Testing", tokens: "8.7k", status: "Done" },
  { rank: "#3", task: "Doc Review", agent: "Writer", avatar: "avatar-writer.png", created: "03/10/2026", type: "Docs", tokens: "5.2k", status: "Failed" },
  { rank: "#4", task: "Deploy Script", agent: "DevOps", avatar: "avatar-devops.png", created: "03/09/2026", type: "Infra", tokens: "3.1k", status: "Done" },
  { rank: "#7", task: "Data Pipeline", agent: "Analyst", avatar: "avatar-analyst.png", created: "03/06/2026", type: "ETL", tokens: "9.3k", status: "Failed" },
  { rank: "#8", task: "Auth Middleware", agent: "Coder", avatar: "avatar-coder2.png", created: "03/05/2026", type: "Security", tokens: "2.1k", status: "Queued" },
];

const STATUS_STYLES: Record<TaskStatus, string> = {
  Done: "bg-ok/10 text-ok",
  Failed: "bg-danger/10 text-danger",
  Queued: "bg-line-1 text-fg-2",
};

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("bg-panel border border-line-2 rounded-2xl overflow-hidden", className)}>
      {children}
    </div>
  );
}

function SwarmActivityCard({ lastEventAt }: { lastEventAt: string | null }) {
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
          <span className="text-[13px] text-fg-2">Total tasks executed</span>
          <span className="text-[13px] text-fg-2">2x increase to the last month</span>
        </div>
        <div className="flex items-start justify-between">
          <span className="text-xs text-fg-3">Active agents</span>
          <span className="text-sm font-bold text-teal-brand">+12.83%</span>
        </div>
      </div>
      <div className="self-start flex gap-0.5 bg-panel-2 border border-line-2 rounded-[10px] p-[5px]">
        {(["24h", "Week", "Month"] as const).map((label) => (
          <span
            key={label}
            className={cn(
              "px-5 py-2 rounded-lg text-[13px] text-center",
              label === "Month"
                ? "bg-line-2 font-semibold text-fg-1"
                : "font-medium text-fg-3",
            )}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="relative h-[161px] w-full overflow-hidden">
        <div className="absolute inset-x-[5%] top-[22%] bottom-0">
          <Icon src="chart-area.svg" className="size-full" />
        </div>
        <div className="absolute inset-x-[5%] top-[22%] bottom-[22%]">
          <Icon src="chart-line.svg" className="size-full" />
        </div>
        <div className="absolute left-[58%] top-[20%] size-2">
          <Icon src="chart-dot.svg" className="size-full" />
        </div>
      </div>
      <div className="flex items-start justify-between text-[11px] text-fg-3">
        <span>Mar 8</span>
        <span>Mar 18</span>
        <span>Mar 28</span>
        <span>Apr 8</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[22px] font-bold text-teal-brand">+19.23%</span>
        <span className="text-[11px] text-fg-3">
          {lastEventAt !== null
            ? `Last updated ${lastEventAt}`
            : "Last updated Today, 06:49 AM"}
        </span>
      </div>
    </div>
  );
}

function TokenConsumptionCard() {
  return (
    <Card className="p-6 flex flex-col">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-fg-1">Token Consumption</h3>
          <p className="text-[13px] text-fg-2">The sum of all token usage</p>
        </div>
        <span className="flex items-center gap-2 h-9 rounded-lg bg-panel-2 px-3 text-xs font-medium text-fg-2">
          This Month
          <Icon src="chevron-down-sm.svg" className="size-3.5" />
        </span>
      </div>
      <p className="mt-4 text-4xl font-medium text-fg-1">$ 23,094.57</p>
      <p className="mt-4 text-[11px] text-fg-3">Compared to last month -37.16%</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-fg-3">
          Monthly avg: $34,502.19
          <Icon src="trend-up.svg" className="size-3.5" />
        </span>
        <span className="text-xs font-medium text-fg-1">How it works?</span>
      </div>
      <div className="relative mt-3 h-[216px] rounded-2xl bg-panel-2 overflow-hidden">
        <div className="absolute inset-y-0 right-0 w-[65%]">
          {/* eslint-disable-next-line @next/next/no-img-element -- exact Figma asset */}
          <img src="/figma/robot.png" alt="" className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-panel-2 to-transparent" />
        </div>
        <div className="relative z-10 flex h-full w-[220px] flex-col justify-center gap-3 pl-5">
          <h4 className="text-sm font-semibold text-fg-1">AI Assistant</h4>
          <p className="text-[13px] leading-[19.5px] text-fg-2 w-[178px]">
            is optimizing token allocation now...
          </p>
        </div>
      </div>
    </Card>
  );
}

function QuickActionsCard() {
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-fg-1">Quick Actions</h3>
        <span className="text-xs font-medium text-teal-brand">Next →</span>
      </div>
      <div className="flex flex-col justify-between gap-3 rounded-xl bg-panel-2 p-4 min-h-[327px]">
        <div className="rounded-lg overflow-hidden h-[153px]">
          {/* eslint-disable-next-line @next/next/no-img-element -- exact Figma asset */}
          <img
            src="/figma/promo-water.png"
            alt=""
            className="size-full object-cover"
            style={{ objectPosition: "center 30%" }}
          />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-fg-1">Upgrade to Pro</h4>
            <span className="rounded-md bg-warn px-2 py-1 text-[10px] font-bold text-shell">
              -50%
            </span>
          </div>
          <p className="text-xs leading-[18px] text-fg-2">
            Unlock premium features including advanced analytics, priority support, and
            unlimited agent deployments.
          </p>
          <span className="text-xs font-medium text-fg-1">Learn more →</span>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-3">Don&apos;t show again</span>
        <span className="rounded-lg bg-panel border border-line-1 px-5 py-2.5 text-[13px] font-medium text-fg-1">
          Get started
        </span>
      </div>
    </Card>
  );
}

function TopAgentsCard() {
  return (
    <Card className="w-[420px] shrink-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <h3 className="text-base font-semibold text-fg-1 py-1.5">Top Agents</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-fg-3">02 of 5</span>
          <span className="flex size-8 items-center justify-center rounded-lg bg-panel-2 border border-line-1">
            <Icon src="arrow-left.svg" className="size-4" />
          </span>
          <span className="flex size-8 items-center justify-center rounded-lg bg-panel-2 border border-line-1">
            <Icon src="arrow-right.svg" className="size-4" />
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {TOP_AGENTS.map((agent) => (
          <div
            key={agent.name}
            className="rounded-[14px] bg-panel-2 border border-line-1 p-3.5 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-[5px] bg-ok" />
                <span className="text-sm font-semibold text-fg-1">{agent.name}</span>
              </span>
              <Icon src="kebab.svg" className="size-4" />
            </div>
            <div className="flex gap-2 text-[13px]">
              <span className="font-medium text-fg-2">{agent.metric}</span>
              <span className="text-fg-3">{agent.delta}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {agent.tools.map((tool) => (
                <span
                  key={tool}
                  className="flex size-7 items-center justify-center rounded-[14px] bg-panel border border-line-1"
                >
                  <Icon src={tool} className="size-3.5" />
                </span>
              ))}
              <span className="flex h-7 items-center rounded-[14px] bg-panel-2 px-2 text-[10px] font-semibold text-fg-2">
                +5 tools
              </span>
              <span className="flex size-7 items-center justify-center rounded-[14px] bg-panel border border-line-1">
                <Icon src="tool-plus.svg" className="size-3.5" />
              </span>
            </div>
            <div className="h-px bg-line-1" />
            <div className="flex gap-5">
              {(
                [
                  ["Tokens", agent.tokens],
                  ["Latency", agent.latency],
                  ["Success Rate", agent.success],
                ] as const
              ).map(([label, value]) => (
                <span key={label} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-fg-3">{label}</span>
                  <span className="text-sm font-semibold text-fg-1">{value}</span>
                </span>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-fg-3">{agent.quotaLabel}</span>
              <span className="text-fg-2">{agent.quota}</span>
            </div>
            <div className="h-1 rounded-sm bg-line-2 overflow-hidden">
              <div
                className="h-full rounded-sm bg-fg-2"
                style={{ width: `${agent.quotaPct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RecentTasksTable() {
  return (
    <Card className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h3 className="text-base font-semibold text-fg-1">Recent Tasks</h3>
        <span className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 text-xs font-medium text-fg-2">
          ≡ as List
          <Icon src="chevron-down-sm.svg" className="size-3.5" />
        </span>
      </div>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line-1 text-[11px] text-fg-3">
            {["Rank", "Task", "Agent", "Created", "Type", "Tokens", "Status", "Action"].map(
              (column) => (
                <th key={column} className="px-4 py-2.5 font-normal">
                  {column}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {RECENT_TASKS.map((task) => (
            <tr key={task.rank} className="border-b border-line-1/60 last:border-b-0">
              <td className="px-4 py-3 text-xs text-fg-3">{task.rank}</td>
              <td className="px-4 py-3 text-[13px] font-medium text-fg-1">{task.task}</td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-2">
                  <span className="size-6 rounded-full overflow-hidden bg-panel-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- exact Figma asset */}
                    <img src={`/figma/${task.avatar}`} alt="" className="size-full object-cover" />
                  </span>
                  <span className="text-[13px] text-fg-1">{task.agent}</span>
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-fg-2">{task.created}</td>
              <td className="px-4 py-3 text-xs text-fg-2">{task.type}</td>
              <td className="px-4 py-3 text-xs text-fg-1">{task.tokens}</td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-semibold",
                    STATUS_STYLES[task.status],
                  )}
                >
                  {task.status}
                </span>
              </td>
              <td className="px-4 py-3">
                <span className="rounded-lg bg-panel-2 border border-line-1 px-4 py-1.5 text-xs font-medium text-fg-1">
                  View
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Fleet (§7.1) — the Figma "Home Dashboard" screen.
 * Live: swarm "last updated", fleet summary chips (active/queued/needs-you/brain).
 * Roster cards remain design placeholders where analytics still use fixtures.
 */
export function FleetDashboard() {
  const { events, lastEvent } = useEventStream();
  const refreshKey = lastEvent?.id ?? "init";
  const [summary, setSummary] = useState<{
    active: number;
    queued: number;
    needsCaptain: number;
    doneToday: number;
    brainDown: boolean;
    brainStatus: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/fleet", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          summary: {
            active: number;
            queued: number;
            needsCaptain: number;
            doneToday: number;
            brainDown: boolean;
            brain: { status: string };
          };
        };
        setSummary({
          active: body.summary.active,
          queued: body.summary.queued,
          needsCaptain: body.summary.needsCaptain,
          doneToday: body.summary.doneToday,
          brainDown: body.summary.brainDown,
          brainStatus: body.summary.brain.status,
        });
      })
      .catch(() => {
        // daemon down — leave previous
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const latest = events[0];
  const lastEventAt =
    latest !== undefined
      ? `Today, ${new Date(latest.ts).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : null;

  return (
    <div className="flex flex-col gap-5 p-8 pt-6">
      {summary !== null && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Active", value: summary.active },
            { label: "Queued", value: summary.queued },
            { label: "Needs you", value: summary.needsCaptain },
            { label: "Done today", value: summary.doneToday },
            {
              label: "Brain",
              value: summary.brainDown ? "DOWN" : summary.brainStatus,
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
        <SwarmActivityCard lastEventAt={lastEventAt} />
        <TokenConsumptionCard />
        <QuickActionsCard />
      </div>
      <div className="flex gap-4 items-start">
        <TopAgentsCard />
        <RecentTasksTable />
      </div>
    </div>
  );
}
