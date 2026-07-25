"use client";

import { useEffect, useState } from "react";
import type { QuotaSample } from "@agent-os/protocol";
import { selectPrimaryQuotaMetric } from "@/lib/selectPrimaryQuotaMetric";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Live quota strip for Token Usage (§7.3).
 *
 * Loading, unavailable, and genuinely empty are distinct — a failed probe
 * fetch must not read as "connect providers".
 *
 * Refreshes on `quota.updated` over SSE, not just on the 30 s poll: a Captain
 * who just hit refresh on a provider card should see the strip agree with it
 * immediately, and a half-minute of disagreement between two live surfaces
 * reads as one of them being wrong.
 */
export function QuotaUsageStrip() {
  const [samples, setSamples] = useState<QuotaSample[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const { events } = useEventStream();
  // Latest quota frame id — changes whenever the daemon reports new numbers.
  // useEventStream PREPENDS, so the newest frame is at index 0. Reading the
  // tail would pin this to the oldest buffered frame and never re-fire.
  const quotaCursor =
    events.find((envelope) => envelope.event.type === "quota.updated")?.id ?? "none";

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/agentos/quota");
        if (!res.ok) {
          if (!cancelled) {
            setStatus((prev) => (prev === "ready" ? prev : "unavailable"));
          }
          return;
        }
        const body = (await res.json()) as { samples: QuotaSample[] };
        if (!cancelled) {
          setSamples(body.samples);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setStatus((prev) => (prev === "ready" ? prev : "unavailable"));
        }
      }
    };
    void load();
    // The poll stays as a safety net for a dropped stream; SSE is the fast path.
    const id = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [quotaCursor]);

  if (status === "loading" && samples.length === 0) {
    return (
      <p className="mb-4 text-[12px] text-fg-3">Loading quota probes…</p>
    );
  }

  if (status === "unavailable" && samples.length === 0) {
    return (
      <p className="mb-4 text-[12px] text-fg-3">
        Quota probes unavailable — the daemon could not be reached.
      </p>
    );
  }

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
        const { primary: m } = selectPrimaryQuotaMetric(s.metrics);
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
