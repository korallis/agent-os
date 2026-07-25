"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { AnalyticsSnapshot, BudgetsConfig } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";
import { EmptyState } from "@/components/shell/EmptyState";
import { QuotaUsageStrip } from "@/components/analytics/QuotaUsageStrip";
import { useEventStream } from "@/lib/useEventStream";
import {
  isFleetAnalyticsEvent,
  useDebouncedRefreshKey,
} from "@/lib/useDebouncedRefreshKey";

/**
 * Analytics — the Figma "Token Usage" frame (node 37:2265), bound to the real
 * usage snapshot the daemon derives from its event log.
 *
 * Two honesty rules govern this screen:
 *  - a figure that cannot be derived renders as "—" with a stated reason, never
 *    as a plausible number;
 *  - cost is distinguished between "no provider reported it", "partial coverage",
 *    and "complete" — subscription legs never silently read as $0.00.
 */

const SERIES_COLORS = ["bg-teal-brand", "bg-electric", "bg-[#a855f7]", "bg-warn", "bg-ok"] as const;
const CONIC_COLORS = ["#2dd4bf", "#3b82f6", "#a855f7", "#fbbf24", "#4ade80"] as const;

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatRowCost(
  costUsd: number | null,
  costReportedRequests: number,
  requests: number,
): string {
  if (costUsd === null || costReportedRequests === 0) return "—";
  if (costReportedRequests < requests) {
    return `$${costUsd.toFixed(2)} partial`;
  }
  return `$${costUsd.toFixed(2)}`;
}

function costNote(totals: AnalyticsSnapshot["totals"] | undefined, windowDays: number): string {
  if (totals === undefined) return `over ${windowDays}d`;
  if (totals.costCoverage === "absent") return "not reported by providers";
  if (totals.costCoverage === "partial") {
    return `partial — ${totals.costReportedRequests} of ${totals.requests} requests reported cost`;
  }
  return `over ${windowDays}d`;
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("bg-panel border border-line-2 rounded-2xl", className)}>{children}</div>
  );
}

type LoadStatus = "loading" | "ready" | "unavailable";

export function AnalyticsView() {
  const { lastEvent } = useEventStream();
  const refreshKey = useDebouncedRefreshKey(lastEvent, isFleetAnalyticsEvent);
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<LoadStatus>("loading");
  const [budgets, setBudgets] = useState<BudgetsConfig | null>(null);
  const [budgetsStatus, setBudgetsStatus] = useState<LoadStatus>("loading");

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
        setSnapshotStatus("ready");
      } else {
        setSnapshotStatus((prev) => (prev === "ready" ? prev : "unavailable"));
      }
      if (configRes.status === "fulfilled" && configRes.value.ok) {
        const body = (await configRes.value.json()) as { config: { budgets: BudgetsConfig } };
        setBudgets(body.config.budgets);
        setBudgetsStatus("ready");
      } else {
        setBudgetsStatus((prev) => (prev === "ready" ? prev : "unavailable"));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const totals = snapshot?.totals;
  const snapshotReady = snapshotStatus === "ready" && snapshot !== null;
  const tokensUsed =
    !snapshotReady || totals === undefined ? null : totals.inputTokens + totals.outputTokens;
  const cost = snapshotReady ? (totals?.costUsd ?? null) : null;
  const daily = snapshot?.daily ?? [];
  const maxDaily = Math.max(...daily.map((d) => d.inputTokens + d.outputTokens), 1);
  const models = snapshot?.models ?? [];
  const agents = snapshot?.agents ?? [];
  const modelCostTotal = models.reduce(
    (sum, m) => sum + (m.costUsd === null ? 0 : m.costUsd),
    0,
  );
  const anyModelCost = models.some((m) => m.costUsd !== null);
  const windowDays = snapshot?.windowDays ?? 14;

  const pendingNote = snapshotStatus === "loading" ? "loading…" : "unavailable";

  const stats = [
    {
      label: "Total Spend",
      value: !snapshotReady ? "—" : cost === null ? "—" : `$${cost.toFixed(2)}`,
      note: !snapshotReady ? pendingNote : costNote(totals, windowDays),
      noteClass: totals?.costCoverage === "partial" ? "text-warn" : "text-fg-3",
    },
    {
      label: "Tokens Used",
      value: tokensUsed === null ? "—" : compact(tokensUsed),
      note: !snapshotReady
        ? pendingNote
        : `${totals?.requests ?? 0} requests · last ${windowDays}d`,
      noteClass: "text-fg-3",
    },
    {
      label: "Tasks Done",
      value: !snapshotReady ? "—" : String(totals?.tasksDone ?? 0),
      note: !snapshotReady
        ? pendingNote
        : `${totals?.tasksTotal ?? 0} created · last ${windowDays}d`,
      noteClass: "text-fg-3",
    },
    {
      label: "Success Rate",
      value:
        !snapshotReady || totals?.successRatePct === null || totals?.successRatePct === undefined
          ? "—"
          : `${totals.successRatePct}%`,
      note: !snapshotReady
        ? pendingNote
        : totals?.successRatePct === null
          ? "no terminal tasks yet"
          : `${totals?.tasksFailed ?? 0} failed`,
      noteClass: totals?.tasksFailed ? "text-danger" : "text-fg-3",
    },
  ];

  // Only a genuine fleet-wide ceiling may drive the bar — never per-task.
  // Three distinct states: budgets not loaded, loaded with zero ceiling, configured.
  const fleetCeiling =
    budgetsStatus === "ready" && budgets !== null ? budgets.gatewayHardUsd : null;
  const budgetPct =
    cost !== null && fleetCeiling !== null && fleetCeiling > 0
      ? Math.min(100, (cost / fleetCeiling) * 100)
      : null;

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
          Last {windowDays} days
        </span>
      </div>

      {snapshot?.truncated === true && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 text-[12px] text-warn">
          Analytics history was truncated at a read bound — figures keep the newest
          frames and may omit older in-window usage or pre-window session attribution
          inside the {windowDays}-day range.
        </div>
      )}

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
            {snapshotStatus === "loading" ? (
              <p className="py-10 text-center text-[13px] text-fg-3">Loading usage snapshot…</p>
            ) : snapshotStatus === "unavailable" ? (
              <EmptyState
                kind="server-error"
                title="Usage unavailable"
                body="Daily token consumption could not be loaded from the daemon."
                className="border-0 bg-transparent py-10"
              />
            ) : daily.every((d) => d.inputTokens + d.outputTokens === 0) ? (
              <EmptyState
                kind="no-data"
                title="No usage recorded yet"
                body="Token consumption appears here as providers report usage frames."
                className="border-0 bg-transparent py-10"
              />
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
            {snapshotStatus === "loading" ? (
              <p className="py-6 text-center text-[13px] text-fg-3">Loading usage…</p>
            ) : snapshotStatus === "unavailable" ? (
              <EmptyState
                kind="server-error"
                title="Usage unavailable"
                body="Per-role usage could not be loaded from the daemon."
                className="border-0 bg-transparent py-6"
              />
            ) : agents.length === 0 ? (
              <EmptyState
                kind="no-data"
                title="No agent telemetry yet"
                body="Per-role usage appears after crewmates report ext.usage frames."
                className="border-0 bg-transparent py-6"
              />
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
                      {formatRowCost(
                        agent.costUsd,
                        agent.costReportedRequests,
                        agent.requests,
                      )}
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
            {snapshotStatus === "loading" ? (
              <p className="py-6 text-center text-[13px] text-fg-3">Loading usage…</p>
            ) : snapshotStatus === "unavailable" ? (
              <EmptyState
                kind="server-error"
                title="Usage unavailable"
                body="Per-model cost and tokens could not be loaded from the daemon."
                className="border-0 bg-transparent py-6"
              />
            ) : models.length === 0 ? (
              <EmptyState
                kind="no-data"
                title="No model usage yet"
                body="Per-model cost and tokens appear once providers report usage."
                className="border-0 bg-transparent py-6"
              />
            ) : (
              <>
                <div className="flex items-center justify-center py-2">
                  <div
                    className="relative size-[150px] rounded-full"
                    style={{ background: conicFor(models, anyModelCost ? modelCostTotal : 0) }}
                  >
                    <div className="absolute inset-[18px] rounded-full bg-panel flex flex-col items-center justify-center">
                      <span className="text-lg font-bold text-fg-1">
                        {anyModelCost
                          ? `$${modelCostTotal.toFixed(0)}`
                          : compact(
                              models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0),
                            )}
                      </span>
                      <span className="text-[10px] text-fg-3">
                        {anyModelCost ? "reported" : "tokens"}
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
                      {formatRowCost(
                        model.costUsd,
                        model.costReportedRequests,
                        model.requests,
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Card>

          <Card className="p-5 flex flex-col gap-4">
            <h3 className="text-[15px] font-semibold text-fg-1">Budget &amp; Limits</h3>
            {budgetsStatus === "loading" ? (
              <p className="text-[11px] text-fg-3">Loading budget configuration…</p>
            ) : budgetsStatus === "unavailable" || budgets === null ? (
              <p className="text-[11px] text-fg-3">Budget configuration unavailable</p>
            ) : budgetPct === null ? (
              <p className="text-[11px] text-fg-3">
                {fleetCeiling === null || fleetCeiling <= 0
                  ? "No fleet spend ceiling configured — set gatewayHardUsd in Policies ▸ Budgets."
                  : totals?.costCoverage === "partial"
                    ? `partial — ${totals.costReportedRequests} of ${totals.requests} requests reported cost; spend against budget cannot be shown as complete.`
                    : "Providers have not reported cost, so spend against budget cannot be shown."}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-fg-3">Spend vs fleet ceiling</span>
                  <span className="text-fg-1">
                    ${(cost ?? 0).toFixed(2)} / ${(fleetCeiling ?? 0).toFixed(2)}
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
                    ⚠ {budgetPct.toFixed(1)}% of the configured fleet ceiling used
                  </div>
                )}
                {totals?.costCoverage === "partial" && (
                  <p className="text-[11px] text-warn">
                    partial — {totals.costReportedRequests} of {totals.requests} requests reported
                    cost; the bar only includes reported spend.
                  </p>
                )}
              </div>
            )}
            {budgets !== null && (
              <div className="flex flex-col gap-1 text-[11px] text-fg-3">
                <span>Per-task cap: ${budgets.perTaskUsd.toFixed(2)} (not a fleet ceiling)</span>
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
    const value = useCost ? (m.costUsd ?? 0) : m.inputTokens + m.outputTokens;
    const deg = (value / total) * 360;
    stops.push(`${CONIC_COLORS[i % CONIC_COLORS.length]} ${cursor}deg ${cursor + deg}deg`);
    cursor += deg;
  });
  if (cursor < 360) stops.push(`#222222 ${cursor}deg 360deg`);
  return `conic-gradient(${stops.join(", ")})`;
}
