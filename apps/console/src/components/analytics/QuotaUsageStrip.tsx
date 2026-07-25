"use client";

import { useEffect, useState } from "react";
import type { QuotaSample } from "@agent-os/protocol";

/**
 * Live quota strip for Token Usage (§7.3). Falls back to empty when daemon
 * has no samples yet — Figma chart layout remains in the parent page.
 */
export function QuotaUsageStrip() {
  const [samples, setSamples] = useState<QuotaSample[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/agentos/quota");
        if (!res.ok) return;
        const body = (await res.json()) as { samples: QuotaSample[] };
        if (!cancelled) setSamples(body.samples);
      } catch {
        // daemon down — leave empty
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (samples.length === 0) {
    return (
      <p className="mb-4 text-[12px] text-fg-3">
        Quota probes will appear here once providers are connected.
      </p>
    );
  }

  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {samples.map((s) => {
        const m = s.metrics[0];
        return (
          <div
            key={s.id}
            className="min-w-[160px] rounded-[12px] border border-line-2 bg-panel-1 px-4 py-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">
              {s.provider}
            </p>
            <p className="mt-1 text-[22px] font-semibold tabular-nums text-fg-1">
              {m
                ? m.unit === "percent"
                  ? `${m.value}%`
                  : `${m.value} ${m.unit}`
                : "?"}
            </p>
            <p className="text-[10px] uppercase text-fg-3">
              {m ? `${m.tier} · ${m.source}` : "no metric"}
            </p>
            {m?.limitReached === true && (
              <span className="mt-1 inline-block text-[10px] font-bold text-danger">
                LIMIT REACHED
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
