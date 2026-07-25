"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { AnalyticsSnapshot, BudgetsConfig } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";
import { QuotaUsageStrip } from "@/components/analytics/QuotaUsageStrip";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Analytics — the Figma "Token Usage" frame (node 37:2265), bound to the real
 * usage snapshot the daemon derives from its event log.
 *
 * Two honesty rules govern this screen:
 *  - a figure that cannot be derived renders as "—" with a stated reason, never
 *    as a plausible number;
 *  - cost is distinguished between "no provider reported it" and "zero", since
 *    subscription-billed connections legitimately report no per-token cost.
 */

const SERIES_COLORS = ["bg-teal-brand", "bg-electric", "bg-[#a855f7]", "bg-warn", "bg-ok"] as const;
const CONIC_COLORS = ["#2dd4bf", "#3b82f6", "#a855f7", "#fbbf24", "#4ade80"] as const;

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("bg-panel border border-line-2 rounded-2xl", className)}>{children}</div>
  );
}

export function AnalyticsView() {
  const { lastEvent } = useEventStream();
  const refreshKey = lastEvent?.id ?? "init";
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [budgets, setBudgets] = useState<BudgetsConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [analyticsRes, configRes] = await Promise.allSettled([
        fetch("/api/agentos/analytics", { cache: "no-store" }),
        fetch("/api/agentos/config/effective", { cache: "no-store" }),
      ]);
      if (cancelled) return;
      if (analyticsRes.status === "fulfilled" && analyticsRes.value.ok) {
        setSnapshot((await analyticsRes.value.json()) as AnalyticsSnapshot);
      }
      if (configRes.status === "fulfilled" && configRes.value.ok) {
        const body = (await configRes.value.json()) as { config: { budgets: BudgetsConfig } };
        setBudgets(body.config.budgets);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const totals = snapshot?.totals;
  const tokensUsed = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
  const cost = totals?.costUsd ?? null;
  const daily = snapshot?.daily ?? [];
  const maxDaily = Math.max(...daily.map((d) => d.inputTokens + d.outputTokens), 1);
  const models = snapshot?.models ?? [];
  const agents = snapshot?.agents ?? [];
  const modelCostTotal = models.reduce((sum, m) => sum + m.costUsd, 0);

  const stats = [
    {
      label: "Total Spend",
      value: cost === null ? "—" : `$${cost.toFixed(2)}`,
      note: cost === null ? "not reported by providers" : `over ${snapshot?.windowDays ?? 14}d`,
      noteClass: "text-fg-3",
    },
    {
      label: "Tokens Used",
      value: compact(tokensUsed),
      note: `${totals?.requests ?? 0} requests`,
      noteClass: "text-fg-3",
    },
    {
      label: "Tasks Done",
      value: String(totals?.tasksDone ?? 0),
      note: `${totals?.tasksTotal ?? 0} total`,
      noteClass: "text-fg-3",
    },
    {
      label: "Success Rate",
      value: totals?.successRatePct === null || totals?.successRatePct === undefined
        ? "—"
        : `${totals.successRatePct}%`,
      note: totals?.successRatePct === null ? "no terminal tasks yet" : `${totals?.tasksFailed ?? 0} failed`,
      noteClass: totals?.tasksFailed ? "text-danger" : "text-fg-3",
    },
  ];

  // Budget bar only renders when a budget is actually configured AND cost is
  // known — a progress bar against an unknown numerator is worse than none.
  const monthlyBudget = budgets?.perTaskUsd ?? 0;
  const gatewayBudget = budgets?.gatewayHardUsd ?? 0;
  const budgetCeiling = gatewayBudget > 0 ? gatewayBudget : monthlyBudget;
  const budgetPct =
    cost !== null && budgetCeiling > 0 ? Math.min(100, (cost / budgetCeiling) * 100) : null;

  return (
    <main className="flex-1 flex flex-col gap-5 p-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <Icon src="trend-up.svg" className="size-5" />
            <h2 className="text-[22px] font-bold text-fg-1">Token Usage &amp; Billing</h2>
          </div>
          <p className="text-[13px] text-fg-2">
            Derived from the daemon event log — no sampled estimates
          </p>
        </div>
        <span className="flex items-center gap-2 h-9 rounded-lg bg-panel border border-line-1 px-3.5 text-[13px] font-medium text-fg-1">
          <Icon src="calendar.svg" className="size-4" />
          Last {snapshot?.windowDays ?? 14} days
        </span>
      </div>

      <QuotaUsageStrip />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="p-5 flex flex-col gap-2">
            <span className="text-xs text-fg-2">{stat.label}</span>
            <span className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-fg-1">{stat.value}</span>
              <span className={cn("text-xs font-semibold", stat.noteClass)}>{stat.note}</span>
            </span>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
        <div className="flex flex-col gap-4">
          <Card className="p-6 flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-fg-1">Daily Token Consumption</h3>
              <span className="text-[11px] text-fg-3">input + output</span>
            </div>
            {daily.length === 0 ? (
              <p className="py-12 text-center text-[13px] text-fg-3">
                No usage recorded yet.
              </p>
            ) : (
              <div className="flex items-end gap-3 h-[180px]">
                {daily.map((d) => {
                  const total = d.inputTokens + d.outputTokens;
                  return (
                    <div
                      key={d.day}
                      className="flex-1 flex flex-col items-center gap-2 h-full justify-end"
                      title={`${d.day}: ${total.toLocaleString()} tokens`}
                    >
                      <div
                        className="w-full rounded-t-md bg-gradient-to-b from-teal-brand to-teal-brand/40"
                        style={{ height: `${Math.max((total / maxDaily) * 100, total > 0 ? 2 : 0)}%` }}
                      />
                      <span className="text-[10px] text-fg-3">{d.day.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-6 flex flex-col gap-4">
            <h3 className="text-[15px] font-semibold text-fg-1">Usage by Agent</h3>
            {agents.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-fg-3">
                No agent telemetry yet.
              </p>
            ) : (
              <>
                <div className="flex items-center h-8 text-[11px] text-fg-3 border-b border-line-1">
                  <span className="flex-1">Role</span>
                  <span className="w-[100px]">Tokens</span>
                  <span className="w-[90px]">Cost</span>
                  <span className="w-[80px]">% Share</span>
                  <span className="w-[90px]">Requests</span>
                </div>
                {agents.map((agent, i) => (
                  <div key={agent.role} className="flex items-center text-xs">
                    <span className="flex-1 flex items-center gap-2 text-fg-1 capitalize">
                      <span className={cn("size-2 rounded", SERIES_COLORS[i % SERIES_COLORS.length])} />
                      {agent.role}
                    </span>
                    <span className="w-[100px] text-fg-1">
                      {compact(agent.inputTokens + agent.outputTokens)}
                    </span>
                    <span className="w-[90px] text-fg-1">
                      {agent.costUsd > 0 ? `$${agent.costUsd.toFixed(2)}` : "—"}
                    </span>
                    <span className="w-[80px] text-fg-2">{agent.sharePct}%</span>
                    <span className="w-[90px] text-fg-2">{agent.requests}</span>
                  </div>
                ))}
              </>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-5 flex flex-col gap-4">
            <h3 className="text-[15px] font-semibold text-fg-1">Cost by Model</h3>
            {models.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-fg-3">No model usage yet.</p>
            ) : (
              <>
                <div className="flex items-center justify-center py-2">
                  <div
                    className="relative size-[150px] rounded-full"
                    style={{ background: conicFor(models, modelCostTotal) }}
                  >
                    <div className="absolute inset-[18px] rounded-full bg-panel flex flex-col items-center justify-center">
                      <span className="text-lg font-bold text-fg-1">
                        {modelCostTotal > 0 ? `$${modelCostTotal.toFixed(0)}` : compact(
                          models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0),
                        )}
                      </span>
                      <span className="text-[10px] text-fg-3">
                        {modelCostTotal > 0 ? "total" : "tokens"}
                      </span>
                    </div>
                  </div>
                </div>
                {models.slice(0, 5).map((model, i) => (
                  <div key={model.model} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-fg-2 truncate">
                      <span
                        className={cn("size-2 rounded shrink-0", SERIES_COLORS[i % SERIES_COLORS.length])}
                      />
                      <span className="font-mono truncate">{model.model}</span>
                    </span>
                    <span className="font-medium text-fg-1 shrink-0 ml-2">
                      {model.costUsd > 0
                        ? `$${model.costUsd.toFixed(2)}`
                        : compact(model.inputTokens + model.outputTokens)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Card>

          <Card className="p-5 flex flex-col gap-4">
            <h3 className="text-[15px] font-semibold text-fg-1">Budget &amp; Limits</h3>
            {budgetPct === null ? (
              <p className="text-[11px] text-fg-3">
                {budgetCeiling === 0
                  ? "No spend ceiling configured — set one in Policies ▸ Budgets."
                  : "Providers have not reported cost, so spend against budget cannot be shown."}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-fg-3">Spend vs ceiling</span>
                  <span className="text-fg-1">
                    ${(cost ?? 0).toFixed(2)} / ${budgetCeiling.toFixed(2)}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-line-2 overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded",
                      budgetPct >= 80
                        ? "bg-warn"
                        : "bg-gradient-to-r from-teal-brand to-electric",
                    )}
                    style={{ width: `${budgetPct}%` }}
                  />
                </div>
                {budgetPct >= 80 && (
                  <div className="rounded-lg bg-warn/[0.06] border border-warn/20 px-3 py-2 text-[11px] text-warn">
                    ⚠ {budgetPct.toFixed(1)}% of the configured ceiling used
                  </div>
                )}
              </div>
            )}
            {budgets !== null && (
              <div className="flex flex-col gap-1 text-[11px] text-fg-3">
                <span>Brain tokens/day cap: {budgets.brainTokensPerDay.toLocaleString()}</span>
                <span>Claude extra-usage daily: ${budgets.claudeExtraUsageDailyUsd.toFixed(2)}</span>
              </div>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}

/** Conic gradient sized by real per-model share; falls back to token share. */
function conicFor(
  models: AnalyticsSnapshot["models"],
  costTotal: number,
): string {
  const useCost = costTotal > 0;
  const total = useCost
    ? costTotal
    : models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0);
  if (total === 0) return "conic-gradient(#222222 0deg 360deg)";
  let cursor = 0;
  const stops: string[] = [];
  models.slice(0, 5).forEach((m, i) => {
    const value = useCost ? m.costUsd : m.inputTokens + m.outputTokens;
    const deg = (value / total) * 360;
    stops.push(`${CONIC_COLORS[i % CONIC_COLORS.length]} ${cursor}deg ${cursor + deg}deg`);
    cursor += deg;
  });
  if (cursor < 360) stops.push(`#222222 ${cursor}deg 360deg`);
  return `conic-gradient(${stops.join(", ")})`;
}
