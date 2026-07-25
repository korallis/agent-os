"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type {
  AnalyticsSnapshot,
  BudgetsConfig,
  ProviderConnection,
  QuotaSample,
} from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Settings · Billing — Figma frame `41:6309`.
 *
 * The billing surface a local-first product can honestly show: how each
 * connection bills, what its probe reported, measured spend where providers
 * reported it, and the ceilings configured in Policies ▸ Budgets. There is no
 * invoice, no plan upsell and no payment method — this product bills through
 * the Captain's own vendor subscriptions and API keys, and pretending otherwise
 * would be fiction.
 */

type LoadState = "loading" | "ready" | "unavailable";

const BILLING_LABEL: Record<string, { label: string; tone: string; note: string }> = {
  "extra-usage-per-token": {
    label: "EXTRA USAGE — PER TOKEN",
    tone: "text-warn border-warn/30 bg-warn/10",
    note: "Anthropic bills third-party-harness usage from extra usage per token, not plan limits.",
  },
  "sdk-credit-pool": {
    label: "SDK CREDIT POOL",
    tone: "text-ok border-ok/30 bg-ok/10",
    note: "Bills to the subscription's Agent SDK monthly credit pool.",
  },
  "api-key-metered": {
    label: "API KEY — METERED",
    tone: "text-fg-2 border-line-2 bg-line-1",
    note: "Metered against the key's own balance or account credits.",
  },
};

function spendNote(
  analyticsStatus: LoadState,
  coverage: AnalyticsSnapshot["totals"]["costCoverage"] | undefined,
  totals: AnalyticsSnapshot["totals"] | undefined,
): { text: string; tone: string } {
  if (analyticsStatus === "loading") {
    return { text: "loading analytics…", tone: "text-fg-3" };
  }
  if (analyticsStatus === "unavailable" || totals === undefined) {
    return { text: "analytics unavailable", tone: "text-warn" };
  }
  if (coverage === "complete") {
    return { text: "all requests reported cost", tone: "text-fg-3" };
  }
  if (coverage === "partial") {
    return {
      text: `partial — ${totals.costReportedRequests} of ${totals.requests} requests reported cost`,
      tone: "text-warn",
    };
  }
  return { text: "no provider reported cost", tone: "text-fg-3" };
}

export function BillingView() {
  const { events } = useEventStream();
  const refreshKey = useStickyRefreshKey(
    events,
    (event) =>
      event.event.type.startsWith("quota.") ||
      event.event.type.startsWith("provider.") ||
      event.event.type === "config.changed",
    "billing",
  );
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [samples, setSamples] = useState<QuotaSample[]>([]);
  const [budgets, setBudgets] = useState<BudgetsConfig | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [analyticsStatus, setAnalyticsStatus] = useState<LoadState>("loading");
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const results = await Promise.allSettled([
        fetch("/api/agentos/connections", { cache: "no-store" }),
        fetch("/api/agentos/quota", { cache: "no-store" }),
        fetch("/api/agentos/config/effective", { cache: "no-store" }),
        fetch("/api/agentos/analytics", { cache: "no-store" }),
      ]);
      if (cancelled) return;
      let anyOk = false;
      const [connRes, quotaRes, configRes, analyticsRes] = results;
      if (connRes.status === "fulfilled" && connRes.value.ok) {
        anyOk = true;
        setConnections(
          ((await connRes.value.json()) as { connections: ProviderConnection[] }).connections,
        );
      }
      if (quotaRes.status === "fulfilled" && quotaRes.value.ok) {
        anyOk = true;
        setSamples(((await quotaRes.value.json()) as { samples: QuotaSample[] }).samples);
      }
      if (configRes.status === "fulfilled" && configRes.value.ok) {
        anyOk = true;
        const body = (await configRes.value.json()) as { config: { budgets: BudgetsConfig } };
        setBudgets(body.config.budgets);
      }
      if (analyticsRes.status === "fulfilled" && analyticsRes.value.ok) {
        anyOk = true;
        setAnalytics((await analyticsRes.value.json()) as AnalyticsSnapshot);
        setAnalyticsStatus("ready");
      } else {
        setAnalyticsStatus((prev) => (prev === "ready" ? "ready" : "unavailable"));
      }
      setState((prev) => (anyOk ? "ready" : prev === "ready" ? "ready" : "unavailable"));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (state === "unavailable") {
    return <EmptyState kind="server-error" body="Could not reach agentosd to load billing." />;
  }
  if (state === "loading") {
    return <p className="py-10 text-center text-[13px] text-fg-3">Loading…</p>;
  }

  const analyticsReady = analyticsStatus === "ready" && analytics !== null;
  const totals = analyticsReady ? analytics.totals : undefined;
  const coverage = totals?.costCoverage;
  const spend = spendNote(analyticsStatus, coverage, totals);
  const windowDays = analytics?.windowDays ?? 14;

  return (
    <div className="flex flex-col gap-5">
      {analyticsReady && analytics.truncated === true && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 text-[12px] text-warn">
          Analytics history was truncated at a read bound — reported spend keeps the
          newest frames and may omit older in-window usage inside the {windowDays}-day
          range.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-fg-3">
            Reported spend ({windowDays}d)
          </span>
          <span className="text-2xl font-semibold text-fg-1">
            {!analyticsReady || totals?.costUsd == null ? "—" : `$${totals.costUsd.toFixed(2)}`}
          </span>
          <span className={cn("text-[11px]", spend.tone)}>{spend.text}</span>
        </div>
        <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-fg-3">Fleet ceiling</span>
          <span className="text-2xl font-semibold text-fg-1">
            {budgets === null
              ? "—"
              : budgets.gatewayHardUsd > 0
                ? `$${budgets.gatewayHardUsd.toFixed(2)}`
                : "none"}
          </span>
          <Link href="/policies" className="text-[11px] text-teal-brand">
            Edit in Policies ▸ Budgets →
          </Link>
        </div>
        <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-fg-3">Connections</span>
          <span className="text-2xl font-semibold text-fg-1">{connections.length}</span>
          <span className="text-[11px] text-fg-3">
            {connections.filter((c) => c.limitReached).length} at limit
          </span>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-[15px] font-semibold text-fg-1">How each connection bills</h3>
        {connections.length === 0 ? (
          <EmptyState
            kind="no-data"
            title="No connections"
            body="Connect a provider to see how it bills."
            action={{ href: "/providers", label: "Go to providers" }}
          />
        ) : (
          <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
            <ul className="divide-y divide-line-1/60">
              {connections.map((c) => {
                const billing = BILLING_LABEL[c.billingSurface ?? "api-key-metered"];
                const sample = samples.find((s) => s.connectionId === c.id);
                const money = sample?.metrics.find(
                  (m) => m.unit === "usd" || m.unit === "credits",
                );
                return (
                  <li key={c.id} className="flex items-start gap-4 px-4 py-3">
                    <span className="flex-1 min-w-0 flex flex-col gap-1">
                      <span className="text-[13px] font-medium text-fg-1">{c.label}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        {billing !== undefined && (
                          <span
                            className={cn(
                              "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                              billing.tone,
                            )}
                          >
                            {billing.label}
                          </span>
                        )}
                        {c.limitReached && (
                          <span className="rounded-[20px] bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">
                            LIMIT REACHED
                          </span>
                        )}
                      </span>
                      {billing !== undefined && (
                        <span className="text-[11px] text-fg-3">{billing.note}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right flex flex-col gap-0.5">
                      <span className="text-[13px] font-medium text-fg-1">
                        {money === undefined
                          ? "—"
                          : money.unit === "usd"
                            ? `$${money.value.toFixed(2)}`
                            : `${money.value} credits`}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-fg-3">
                        {money?.source ?? "no probe"}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-fg-3">
          Amounts render exactly as the vendor reported them — no currency conversion is applied.
        </p>
      </section>

      {budgets !== null && (
        <section className="rounded-2xl border border-line-2 bg-panel p-5 flex flex-col gap-2">
          <h3 className="text-[15px] font-semibold text-fg-1">Configured ceilings</h3>
          {[
            { label: "Per-task", value: `$${budgets.perTaskUsd.toFixed(2)}` },
            { label: "Claude extra-usage daily", value: `$${budgets.claudeExtraUsageDailyUsd.toFixed(2)}` },
            { label: "Gateway hard cap (fleet)", value: `$${budgets.gatewayHardUsd.toFixed(2)}` },
            { label: "Brain tokens per day", value: budgets.brainTokensPerDay.toLocaleString() },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between text-[12px]">
              <span className="text-fg-3">{row.label}</span>
              <span className="font-medium text-fg-1">{row.value}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
