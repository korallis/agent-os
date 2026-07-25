"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { useEventStream } from "@/lib/useEventStream";
import { fetchTaskEvents } from "@/lib/fetchTaskEvents";

/**
 * Brain decision lane (master plan §7.2).
 *
 * Every judgment the Brain made about this task, as the tool calls it actually
 * issued through the typed surface. Refusals are shown as prominently as
 * successes: a `POLICY_VIOLATION` or `ILLEGAL_TRANSITION` is the substrate
 * correcting the Brain, and that record is the evidence the substrate — not the
 * model — is what enforces the rules.
 */

interface Invocation {
  tool: string;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
  ts: string;
}

const TOOL_TYPES = new Set(["tool.invoked"]);

export function BrainDecisionLane({ taskId }: { taskId: string }) {
  const { lastEvent } = useEventStream();
  const refreshKey =
    lastEvent !== null && lastEvent.event.type === "tool.invoked" ? lastEvent.id : "init";
  const [calls, setCalls] = useState<Invocation[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTaskEvents(taskId, TOOL_TYPES)
      .then((result) => {
        if (cancelled) return;
        const mine: Invocation[] = [];
        for (const envelope of result.events) {
          if (envelope.event.type !== "tool.invoked") continue;
          mine.push({
            tool: envelope.event.payload.tool,
            ok: envelope.event.payload.ok,
            errorCode: envelope.event.payload.errorCode,
            durationMs: envelope.event.payload.durationMs,
            ts: envelope.ts,
          });
        }
        setCalls(mine);
        setTruncated(result.truncated);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (calls.length === 0 && !truncated) return null;
  const refused = calls.filter((c) => !c.ok).length;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg-1">Brain decisions</h3>
        <span className="text-[11px] text-fg-3">
          {calls.length === 0
            ? "history truncated"
            : `${calls.length} tool call${calls.length === 1 ? "" : "s"}${
                refused > 0 ? ` · ${refused} refused by the substrate` : ""
              }${truncated ? " · history truncated" : ""}`}
        </span>
      </div>
      {calls.length === 0 ? (
        <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3">
          <p className="text-[12px] text-fg-3">
            Event history was truncated before this task&apos;s tool calls were reached.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
          <ul className="divide-y divide-line-1/60">
            {calls.map((call, i) => (
              <li key={`${call.ts}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={cn(
                    "shrink-0 size-1.5 rounded-full",
                    call.ok ? "bg-ok" : "bg-danger",
                  )}
                />
                <span className="flex-1 min-w-0 font-mono text-[12px] text-fg-1 truncate">
                  {call.tool}
                </span>
                {!call.ok && call.errorCode !== null && (
                  <span
                    className="shrink-0 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger"
                    title="The substrate refused this move — the Brain must choose a legal one"
                  >
                    {call.errorCode}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-fg-3 w-14 text-right">
                  {call.durationMs}ms
                </span>
                <span className="shrink-0 text-[11px] text-fg-3 w-20 text-right">
                  {new Date(call.ts).toLocaleTimeString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
