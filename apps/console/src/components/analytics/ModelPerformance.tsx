"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { AnalyticsSnapshot } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Model Performance — Figma frame `41:4355`.
 *
 * Per-model measured usage from `ext.usage` telemetry. Deliberately NOT a
 * quality leaderboard: Agent OS has no ground truth for "which model is
 * better", so this reports what was measured — tokens, requests, average
 * response size and cost where the provider reported it — and nothing it
 * cannot observe.
 */

type LoadState = "loading" | "ready" | "unavailable";

const FAMILY_DOT: Record<string, string> = {
  anthropic: "bg-teal-brand",
  openai: "bg-electric",
  xai: "bg-[#a855f7]",
  google: "bg-warn",
  moonshot: "bg-ok",
};

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function ModelPerformance() {
  const { events } = useEventStream();
  const refreshKey = useStickyRefreshKey(
    events,
    (event) => event.event.type === "ext.usage" || event.event.type === "session.spawned",
    "models",
  );
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/agentos/analytics", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        setSnapshot((await res.json()) as AnalyticsSnapshot);
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

  if (state === "unavailable" && snapshot === null) {
    return (
      <EmptyState kind="server-error" body="Could not reach agentosd to load model telemetry." />
    );
  }
  if (state === "loading" && snapshot === null) {
    return <p className="py-10 text-center text-[13px] text-fg-3">Loading…</p>;
  }

  const models = snapshot?.models ?? [];
  if (models.length === 0) {
    return (
      <EmptyState
        kind="no-data"
        title="No model telemetry yet"
        body="Spawn a crewmate and its per-request usage will be measured here."
        action={{ href: "/tasks", label: "Go to tasks" }}
      />
    );
  }

  const maxTokens = Math.max(...models.map((m) => m.inputTokens + m.outputTokens), 1);

  return (
    <div className="flex flex-col gap-4">
      {snapshot?.truncated === true && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-2 text-[11px] text-warn">
          Window truncated — figures cover the most recent frames only.
        </div>
      )}
      <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line-1 text-[11px] text-fg-3">
              {["Model", "Family", "Requests", "Input", "Output", "Avg out/req", "Cost"].map((c) => (
                <th key={c} className="px-4 py-2.5 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const avgOut = m.requests === 0 ? null : Math.round(m.outputTokens / m.requests);
              // Same honesty rule as Analytics: a sum over only the legs that
              // reported cost is partial, not a complete model bill.
              const costComplete = m.costReportedRequests === m.requests;
              return (
                <tr key={m.model} className="border-b border-line-1/60 last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 rounded shrink-0",
                          FAMILY_DOT[m.family] ?? "bg-fg-3",
                        )}
                      />
                      <span className="font-mono text-[12px] text-fg-1">{m.model}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-2">{m.family}</td>
                  <td className="px-4 py-3 text-xs text-fg-1">{m.requests}</td>
                  <td className="px-4 py-3 text-xs text-fg-2">{compact(m.inputTokens)}</td>
                  <td className="px-4 py-3 text-xs text-fg-2">{compact(m.outputTokens)}</td>
                  <td className="px-4 py-3 text-xs text-fg-2">
                    {avgOut === null ? "—" : compact(avgOut)}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {m.costUsd === null ? (
                      <span className="text-fg-3">not reported</span>
                    ) : (
                      <span className={costComplete ? "text-fg-1" : "text-warn"}>
                        ${m.costUsd.toFixed(2)}
                        {!costComplete && " partial"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-2xl border border-line-2 bg-panel p-5 flex flex-col gap-3">
        <h3 className="text-[15px] font-semibold text-fg-1">Token share</h3>
        {models.map((m, i) => {
          const total = m.inputTokens + m.outputTokens;
          return (
            <div key={m.model} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-fg-2 truncate">{m.model}</span>
                <span className="text-fg-1 shrink-0 ml-2">{compact(total)}</span>
              </div>
              <div className="h-1.5 rounded-sm bg-line-2 overflow-hidden">
                <div
                  className={cn("h-full rounded-sm", FAMILY_DOT[m.family] ?? "bg-fg-3")}
                  style={{ width: `${(total / maxTokens) * 100}%` }}
                  aria-label={`${m.model} ${compact(total)} tokens`}
                />
              </div>
              {i === models.length - 1 && (
                <span className="mt-1 text-[10px] text-fg-3">
                  Measured from provider-reported usage — not a quality ranking.
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
