"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { FusionRun, FusionRunDetailResponse } from "@agent-os/protocol";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Live fusion side-by-side columns (master plan §7.2).
 *
 * Each side is one clean-room family answering the same question. The header
 * carries the clean-room proof — `promptsIdentical` plus the shared prompt
 * hash — because "these answers are independent" is a claim the UI should
 * evidence rather than assert. A run whose sides saw different bytes is shown
 * in red: that is a broken experiment, not a nicer-looking one.
 */

const FAMILY_ACCENT: Record<string, string> = {
  anthropic: "border-t-teal-brand",
  openai: "border-t-electric",
  xai: "border-t-[#a855f7]",
  google: "border-t-warn",
  moonshot: "border-t-ok",
};

function shortHash(hash: string | null): string {
  return hash === null ? "—" : hash.slice(0, 12);
}

export function FusionColumns({ taskId }: { taskId: string }) {
  const { lastEvent } = useEventStream();
  const refreshKey =
    lastEvent !== null && lastEvent.event.type.startsWith("fusion.") ? lastEvent.id : "init";
  const [runs, setRuns] = useState<FusionRun[]>([]);
  const [detail, setDetail] = useState<FusionRunDetailResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agentos/tasks/${taskId}/fusion`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setListStatus((prev) => (prev === "ready" ? prev : "unavailable"));
          return;
        }
        const body = (await res.json()) as { runs: FusionRun[] };
        setRuns(body.runs);
        setListStatus("ready");
        setSelected((prev) => {
          if (prev !== null && body.runs.some((r) => r.runId === prev)) return prev;
          return body.runs[0]?.runId ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setListStatus((prev) => (prev === "ready" ? prev : "unavailable"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    fetch(`/api/agentos/tasks/${taskId}/fusion/${selected}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        setDetail((await res.json()) as FusionRunDetailResponse);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, selected, refreshKey]);

  if (listStatus === "unavailable" && runs.length === 0) {
    return (
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-fg-1">Fusion</h3>
          <span className="text-[11px] text-fg-3">unavailable</span>
        </div>
        <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3">
          <p className="text-[12px] text-fg-3">
            Fusion runs unavailable — the daemon could not be reached.
          </p>
        </div>
      </section>
    );
  }

  if (runs.length === 0) return null;

  const run = detail?.run ?? runs.find((r) => r.runId === selected) ?? null;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg-1">Fusion</h3>
        {runs.length > 1 && (
          <div className="flex gap-0.5 bg-panel-2 border border-line-2 rounded-[10px] p-1">
            {runs.slice(0, 5).map((r) => (
              <button
                key={r.runId}
                type="button"
                onClick={() => setSelected(r.runId)}
                className={cn(
                  "px-3 py-1 rounded-lg text-[11px] transition-colors",
                  r.runId === selected
                    ? "bg-line-2 font-semibold text-fg-1"
                    : "font-medium text-fg-3 hover:text-fg-2",
                )}
              >
                {r.kind}
              </button>
            ))}
          </div>
        )}
      </div>

      {run !== null && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5 text-fg-2">
            {run.kind}
          </span>
          <span
            className={cn(
              "rounded-md border px-2 py-0.5 font-medium",
              run.promptsIdentical
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-danger/30 bg-danger/10 text-danger",
            )}
            title="Every side must receive byte-identical rendered instructions for the panel to be independent"
          >
            {run.promptsIdentical ? "CLEAN-ROOM ✓ identical prompts" : "PROMPTS DIVERGED ⚠"}
          </span>
          {run.aggregatorFamily !== null && (
            <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5 text-fg-2">
              aggregator: {run.aggregatorFamily}
            </span>
          )}
          {run.contractOk !== null && (
            <span
              className={cn(
                "rounded-md border px-2 py-0.5 font-medium",
                run.contractOk
                  ? "border-ok/30 bg-ok/10 text-ok"
                  : "border-danger/30 bg-danger/10 text-danger",
              )}
            >
              contract {run.contractOk ? "OK" : "FAILED"}
            </span>
          )}
          {run.templateRef !== null && (
            <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5 font-mono text-fg-3">
              {run.templateRef} @ {run.templateLayer}
            </span>
          )}
          {run.error != null && run.error.length > 0 && (
            <span className="rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-danger">
              {run.error}
            </span>
          )}
        </div>
      )}

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(run?.sides.length ?? 1, 1)}, minmax(0, 1fr))`,
        }}
      >
        {(run?.sides ?? []).map((side, i) => {
          const artifact = detail?.sideArtifacts.find(
            (a) => a.role === side.role && a.model === side.model,
          );
          return (
            <div
              key={`${side.role}-${side.model}-${i}`}
              className={cn(
                "rounded-2xl border border-line-2 border-t-2 bg-panel p-4 flex flex-col gap-2 min-w-0",
                FAMILY_ACCENT[side.family] ?? "border-t-line-2",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide text-fg-3">{side.role}</span>
                <span className="text-[10px] uppercase tracking-wide text-fg-3">
                  {side.family}
                </span>
              </div>
              <span className="text-[13px] font-mono text-fg-1 truncate" title={side.model}>
                {side.model}
              </span>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-3">
                <span title="Shared across every side — the clean-room proof">
                  prompt {shortHash(side.promptHash)}
                </span>
                <span>
                  in {side.inputTokens ?? "—"} / out {side.outputTokens ?? "—"}
                </span>
                {side.costUsd !== null && <span>${side.costUsd.toFixed(4)}</span>}
              </div>
              <div className="h-px bg-line-1" />
              {artifact === undefined ? (
                <p className="text-[12px] text-fg-3 py-4">
                  {side.settledAt == null ? "In flight…" : "No artifact captured."}
                </p>
              ) : (
                <pre className="text-[11px] leading-[17px] text-fg-2 whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto font-mono">
                  {artifact.content}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {detail?.fused != null && detail.spans.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line-2 bg-panel p-4 flex flex-col gap-3">
          <h4 className="text-[13px] font-semibold text-fg-1">Fused artifact</h4>
          {detail.spans.map((span, i) => (
            <div key={`${span.tag}-${i}`} className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-teal-brand">
                [{span.tag}]
              </span>
              <pre className="text-[11px] leading-[17px] text-fg-2 whitespace-pre-wrap break-words font-mono">
                {span.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
