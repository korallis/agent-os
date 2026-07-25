"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { useEventStream } from "@/lib/useEventStream";
import { fetchTaskEvents } from "@/lib/fetchTaskEvents";

/**
 * Auto-validate evidence (master plan §7.2).
 *
 * Shows the gate's own verdicts for this task, in order, with the distinction
 * that matters most: a GATE_ERROR is an infrastructure failure, not a RED
 * verdict, and it does not consume a validation attempt. Rendering those two
 * states identically would hide the difference between "the code is wrong" and
 * "the gate never ran".
 */

interface GateResult {
  target: "baseline" | "candidate";
  outcome: string;
  attempt: number;
  outputHash: string | null;
  ts: string;
}

const OUTCOME_STYLE: Record<string, string> = {
  PASS: "border-ok/30 bg-ok/10 text-ok",
  EXPECTED_RED: "border-teal-brand/30 bg-teal-brand/10 text-teal-brand",
  FAIL: "border-danger/30 bg-danger/10 text-danger",
  GATE_ERROR: "border-warn/30 bg-warn/10 text-warn",
};

const OUTCOME_MEANING: Record<string, string> = {
  PASS: "Gate passed against the candidate tree",
  EXPECTED_RED: "Baseline proven semantically red — the gate can detect the absence",
  FAIL: "Candidate rejected by the gate",
  GATE_ERROR: "The gate could not run — infrastructure error, not a verdict, no attempt consumed",
};

const GATE_TYPES = new Set(["gate.result"]);

export function ValidationEvidence({
  taskId,
  validationAttempt,
  maxValidations,
}: {
  taskId: string;
  validationAttempt: number;
  maxValidations: number;
}) {
  const { lastEvent } = useEventStream();
  const refreshKey =
    lastEvent !== null && lastEvent.event.type === "gate.result" ? lastEvent.id : "init";
  const [results, setResults] = useState<GateResult[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTaskEvents(taskId, GATE_TYPES)
      .then((result) => {
        if (cancelled) return;
        const mine: GateResult[] = [];
        for (const envelope of result.events) {
          if (envelope.event.type !== "gate.result") continue;
          mine.push({
            target: envelope.event.payload.target,
            outcome: envelope.event.payload.outcome,
            attempt: envelope.event.payload.attempt,
            outputHash: envelope.event.payload.outputHash,
            ts: envelope.ts,
          });
        }
        setResults(mine);
        setTruncated(result.truncated);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (results.length === 0) return null;

  const exhausted = validationAttempt >= maxValidations;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg-1">Validation evidence</h3>
        <span
          className={cn(
            "text-[11px] font-medium",
            exhausted ? "text-danger" : "text-fg-3",
          )}
        >
          attempt {validationAttempt} / {maxValidations}
          {exhausted && " — halted at cap"}
          {truncated && " · history truncated"}
        </span>
      </div>
      <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
        <ul className="divide-y divide-line-1/60">
          {results.map((r, i) => (
            <li key={`${r.ts}-${i}`} className="flex items-start gap-3 px-4 py-3">
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  OUTCOME_STYLE[r.outcome] ?? "border-line-2 bg-line-1 text-fg-2",
                )}
              >
                {r.outcome}
              </span>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[13px] text-fg-1">
                  {r.target === "baseline" ? "Baseline" : "Candidate"} run
                  {r.target === "candidate" && ` · attempt ${r.attempt}`}
                </span>
                <span className="text-[11px] text-fg-3">
                  {OUTCOME_MEANING[r.outcome] ?? "Gate outcome"}
                </span>
              </span>
              <span className="shrink-0 flex flex-col items-end gap-0.5 text-[11px] text-fg-3">
                <span>{new Date(r.ts).toLocaleTimeString("en-GB")}</span>
                {r.outputHash !== null && (
                  <span className="font-mono" title="sha256 of the gate's stdout">
                    {r.outputHash.slice(0, 10)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
