"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@agent-os/ui";
import type { PipelineRunSnapshot } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Live view of the `no-mistakes` gate (master plan §11 Phase 9, [R7]).
 *
 * Until now, work entering the gate meant Agent OS went blind. This renders the
 * gate's own state, republished onto Agent OS's event log, so it arrives over
 * the same SSE path as everything else.
 *
 * The header states the TRANSPORT and the observed lag as fact. A view labelled
 * "live" that is actually a one-second poll misleads in exactly the way a
 * `$0.00` cost estimate would, and this product does not do that.
 */

type PipelineStatus = {
  transport: "live" | "polled" | "unavailable";
  compatibility: { ok: boolean; reason: string | null; missingColumns: string[] };
  lagMs: number | null;
  home: string;
};

const STEP_TONE: Record<string, string> = {
  completed: "text-ok",
  running: "text-teal-brand",
  fixing: "text-warn",
  awaiting_approval: "text-warn",
  fix_review: "text-warn",
  failed: "text-danger",
  cancelled: "text-fg-3",
  pending: "text-fg-3",
  skipped: "text-fg-3",
};

/** A step the run is parked on needs a human or agent decision, not patience. */
function isAwaitingDecision(status: string): boolean {
  return status === "awaiting_approval" || status === "fix_review";
}

export function PipelineView() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [runs, setRuns] = useState<PipelineRunSnapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const { events } = useEventStream();

  // Newest-first buffer: index 0 is the newest frame (the .at(-1) trap again).
  const pipelineCursor =
    events.find((envelope) => envelope.event.type === "pipeline.run_updated")?.id ?? "none";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [statusRes, runsRes] = await Promise.all([
          fetch("/api/agentos/pipeline/status", { cache: "no-store" }),
          fetch("/api/agentos/pipeline/runs", { cache: "no-store" }),
        ]);
        if (!statusRes.ok || !runsRes.ok) throw new Error("pipeline unavailable");
        const statusBody = (await statusRes.json()) as { pipeline: PipelineStatus };
        const runsBody = (await runsRes.json()) as { runs: PipelineRunSnapshot[] };
        if (cancelled) return;
        setStatus(statusBody.pipeline);
        setRuns(runsBody.runs);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pipelineCursor]);

  // Incremental log output, accumulated per run+step from the live stream.
  useEffect(() => {
    const appended = events.filter((e) => e.event.type === "pipeline.log_appended");
    if (appended.length === 0) return;
    setLogs((current) => {
      const next = { ...current };
      // Oldest-first so the accumulated text reads in order.
      for (const envelope of [...appended].reverse()) {
        if (envelope.event.type !== "pipeline.log_appended") continue;
        const { runId, step, chunk } = envelope.event.payload;
        const key = `${runId}:${step}`;
        next[key] = `${next[key] ?? ""}${chunk}`.slice(-20_000);
      }
      return next;
    });
  }, [events]);

  const unavailableEvent = useMemo(
    () => events.find((e) => e.event.type === "pipeline.unavailable"),
    [events],
  );

  if (failed) {
    return (
      <EmptyState
        kind="server-error"
        title="Pipeline view unavailable"
        body="The daemon did not return pipeline state."
      />
    );
  }

  const incompatible = status !== null && !status.compatibility.ok;

  return (
    <div className="flex flex-col gap-5">
      {/* Transport honesty banner — always shown, never implied. */}
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-1 bg-panel px-4 py-3">
        <span
          className={cn(
            "rounded-[20px] px-2.5 py-1 text-[11px] font-semibold",
            status?.transport === "live"
              ? "bg-ok/10 text-ok"
              : status?.transport === "polled"
                ? "bg-electric/10 text-electric"
                : "bg-warn/10 text-warn",
          )}
        >
          {status?.transport === "live"
            ? "LIVE STREAM"
            : status?.transport === "polled"
              ? "POLLED"
              : "UNAVAILABLE"}
        </span>
        <span className="text-[12px] text-fg-2">
          {status === null
            ? "Checking the local gate…"
            : status.transport === "polled"
              ? `Reading no-mistakes state directly${
                  status.lagMs === null ? "" : ` · last read ${Math.round(status.lagMs)}ms ago`
                }`
              : status.transport === "live"
                ? "Subscribed to the gate's event stream"
                : "The local no-mistakes gate could not be read"}
        </span>
        <span className="ml-auto text-[11px] text-fg-3">read-only · never drives the pipeline</span>
      </div>

      {incompatible && (
        // Degrade visibly. Rendering stale rows as current would be worse than
        // rendering nothing, because it would look like the gate had stalled.
        <div className="rounded-[10px] border border-warn/40 bg-warn/[0.06] px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">Pipeline state unreadable</p>
          <p className="mt-1 text-[12px] text-fg-2">
            {status?.compatibility.reason ??
              (unavailableEvent?.event.type === "pipeline.unavailable"
                ? unavailableEvent.event.payload.reason
                : "The gate's on-disk schema is not one this build understands.")}
          </p>
          <p className="mt-1 text-[11px] text-fg-3">
            This usually means no-mistakes was upgraded. Nothing below is being shown as current.
          </p>
        </div>
      )}

      {runs === null ? (
        <p className="py-8 text-center text-[13px] text-fg-3">Loading pipeline runs…</p>
      ) : runs.length === 0 ? (
        <EmptyState
          kind="no-data"
          title="No pipeline runs yet"
          body="Runs appear here as soon as work enters the no-mistakes gate — including runs started outside Agent OS."
        />
      ) : (
        runs.map((run) => {
          const awaiting = run.steps.find((s) => isAwaitingDecision(s.status));
          const active = run.steps.find((s) => s.status === "running" || s.status === "fixing");
          const logKey = active ? `${run.runId}:${active.step}` : null;
          const logText = logKey === null ? null : (logs[logKey] ?? null);
          return (
            <div key={run.runId} className="rounded-[10px] border border-line-1 bg-panel">
              <div className="flex flex-wrap items-center gap-3 border-b border-line-1 px-4 py-3">
                <span className="font-mono text-[13px] text-fg-1">{run.branch}</span>
                <span
                  className={cn(
                    "rounded px-2 py-0.5 text-[11px] font-semibold",
                    run.status === "running"
                      ? "bg-teal-brand/10 text-teal-brand"
                      : run.status === "failed"
                        ? "bg-danger/10 text-danger"
                        : "bg-panel-2 text-fg-2",
                  )}
                >
                  {run.status}
                </span>
                {awaiting !== undefined && (
                  <span className="rounded px-2 py-0.5 text-[11px] font-semibold bg-warn/10 text-warn">
                    NEEDS A DECISION — {awaiting.step}
                    {awaiting.findingsCount > 0 ? ` · ${awaiting.findingsCount} findings` : ""}
                  </span>
                )}
                {run.prUrl !== null && (
                  <a
                    href={run.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-teal-brand hover:underline"
                  >
                    PR ↗
                  </a>
                )}
                <span className="ml-auto font-mono text-[11px] text-fg-3">
                  {run.headSha.slice(0, 8)}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 px-4 py-3">
                {run.steps.map((step) => (
                  <span
                    key={step.step}
                    title={step.lastActivity ?? undefined}
                    className={cn(
                      "rounded-lg border border-line-1 px-2.5 py-1 text-[11px] font-mono",
                      STEP_TONE[step.status] ?? "text-fg-3",
                    )}
                  >
                    {step.step}
                    {step.findingsCount > 0 ? ` (${step.findingsCount})` : ""}
                  </span>
                ))}
              </div>

              {active !== undefined && (
                <div className="border-t border-line-1 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-medium text-fg-3">
                      {active.step} · {active.status}
                    </span>
                    {active.lastActivity !== null && (
                      <span className="text-[11px] text-fg-2">{active.lastActivity}</span>
                    )}
                  </div>
                  {logText !== null && logText.length > 0 ? (
                    <pre className="max-h-[240px] overflow-auto rounded-[8px] bg-shell p-3 font-mono text-[11px] text-fg-2 whitespace-pre-wrap">
                      {logText}
                    </pre>
                  ) : (
                    <p className="text-[11px] text-fg-3">
                      Waiting for output from this step — new lines appear here as they are written.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
