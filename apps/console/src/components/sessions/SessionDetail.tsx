"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type {
  EventEnvelope,
  SessionDetailResponse,
  SessionEventsResponse,
} from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useStickyRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Session detail — Figma "Agent Detail" (`41:2`) and "Agent Logs" (`41:456`).
 *
 * One seat's whole story: what it is, where it runs, and every frame its Pi
 * extension reported. The attach command is shown rather than executed — the
 * daemon never attaches to a pane on the Captain's behalf, and the plan is
 * explicit that crewmates stay human-attachable.
 *
 * Load states follow the same vocabulary as the rest of the Console: loading,
 * unavailable (with reason), genuinely empty, populated.
 */

type LoadState = "loading" | "ready" | "unavailable" | "missing";

const LIFECYCLE_TONE: Record<string, string> = {
  "session.spawned": "text-teal-brand",
  "session.stopped": "text-fg-2",
  "session.lost": "text-danger",
  "scout.write_violation": "text-danger",
  "ext.hello": "text-fg-2",
  "ext.usage": "text-fg-3",
  "bridge.tool_call": "text-fg-2",
  "crew.question": "text-warn",
  "crew.answered": "text-ok",
};

function summarise(envelope: EventEnvelope): string {
  const { event } = envelope;
  switch (event.type) {
    case "session.spawned":
      return `spawned — ${event.payload.role} ${event.payload.model} in ${event.payload.tmuxWindow}`;
    case "session.stopped":
      return `stopped — ${event.payload.reason}`;
    case "session.lost":
      return `lost — ${event.payload.reason}`;
    case "ext.hello":
      return `extension connected — Pi ${event.payload.piVersion}, role ${event.payload.role}`;
    case "ext.usage":
      return `usage — ${event.payload.provider}/${event.payload.model} in=${event.payload.inputTokens ?? "?"} out=${event.payload.outputTokens ?? "?"}${event.payload.costUsd !== null ? ` $${event.payload.costUsd}` : ""}`;
    case "bridge.tool_call":
      return event.payload.accepted
        ? `tool bridge — ${event.payload.tool} accepted`
        : `tool bridge — ${event.payload.tool} REFUSED: ${event.payload.reason ?? "unknown"}`;
    case "crew.question":
      return `asked — ${event.payload.question}`;
    case "crew.answered":
      return event.payload.delivered ? "answer delivered" : "answer UNDELIVERED";
    case "scout.write_violation":
      return `SCOUT WRITE VIOLATION — ${event.payload.changedPaths.length} path(s)`;
    case "wake.classified":
      return `wake ${event.payload.class} — ${event.payload.summary}`;
    default:
      return event.type;
  }
}

function formatUsageValue(value: string, partial: boolean): string {
  return partial ? `${value} partial` : value;
}

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const { events: streamEvents } = useEventStream();
  const refreshKey = useStickyRefreshKey(
    streamEvents,
    (event) => {
      const payload = event.event.payload as { sessionId?: string };
      return payload.sessionId === sessionId;
    },
    sessionId,
  );

  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [log, setLog] = useState<EventEnvelope[]>([]);
  const [logState, setLogState] = useState<LoadState>("loading");
  const [logTruncated, setLogTruncated] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const boundSessionId = useRef(sessionId);

  if (boundSessionId.current !== sessionId) {
    boundSessionId.current = sessionId;
    setDetail(null);
    setDetailState("loading");
    setLog([]);
    setLogState("loading");
    setLogTruncated(false);
    setCopyState("idle");
  }

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/agentos/sessions/${sessionId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setDetail(null);
          setDetailState("missing");
          return;
        }
        if (!res.ok) {
          setDetailState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        setDetail((await res.json()) as SessionDetailResponse);
        setDetailState("ready");
      } catch {
        if (!cancelled) setDetailState((prev) => (prev === "ready" ? "ready" : "unavailable"));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/agentos/sessions/${sessionId}/events?limit=2000`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setLogState((prev) => (prev === "ready" ? "ready" : "unavailable"));
          return;
        }
        const body = (await res.json()) as SessionEventsResponse;
        setLog(body.events);
        setLogTruncated(body.truncated);
        setLogState("ready");
      } catch {
        if (!cancelled) setLogState((prev) => (prev === "ready" ? "ready" : "unavailable"));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const session = detail?.session ?? null;
  const usageTotals = useMemo(() => {
    let input = 0;
    let output = 0;
    let cost = 0;
    let costReported = false;
    let requests = 0;
    for (const envelope of log) {
      if (envelope.event.type !== "ext.usage") continue;
      requests += 1;
      input += envelope.event.payload.inputTokens ?? 0;
      output += envelope.event.payload.outputTokens ?? 0;
      if (envelope.event.payload.costUsd !== null) {
        cost += envelope.event.payload.costUsd;
        costReported = true;
      }
    }
    return { input, output, cost: costReported ? cost : null, requests };
  }, [log]);

  const usagePartial = logState === "ready" && logTruncated;

  const copyAttachCommand = async (): Promise<void> => {
    const command = detail?.attachCommand;
    if (command === null || command === undefined) return;
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopyState("failed");
      setTimeout(() => setCopyState("idle"), 2000);
      return;
    }
    try {
      await clipboard.writeText(command);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  if (detailState === "missing") {
    return (
      <main className="flex-1 p-8">
        <EmptyState
          kind="not-found"
          title="Session not found"
          body="This seat is not in the current fleet registry. Sessions from a previous daemon life are not retained in memory."
          action={{ href: "/fleet", label: "Back to the fleet" }}
        />
      </main>
    );
  }

  if (detailState === "unavailable" && session === null) {
    return (
      <main className="flex-1 p-8">
        <EmptyState
          kind="server-error"
          body="Could not reach agentosd to load this session."
        />
      </main>
    );
  }

  if (session === null) {
    return <main className="flex-1 p-8 text-fg-3 text-sm">Loading…</main>;
  }

  return (
    <main className="flex-1 flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-2">
        {session.taskId !== null && (
          <Link
            href={`/tasks/${session.taskId}`}
            className="text-[12px] text-fg-3 hover:text-fg-2 w-fit"
          >
            ← {detail?.taskTitle ?? "Task"}
          </Link>
        )}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-bold text-fg-1 capitalize">{session.role}</h2>
            <p
              className="text-[13px] font-mono text-fg-2 mt-1"
              aria-label={`Model: ${session.model}`}
            >
              {session.model}
            </p>
          </div>
          <span
            className={cn(
              "rounded-lg px-3 py-1.5 text-[12px] font-mono",
              session.status === "running"
                ? "bg-teal-brand/10 text-teal-brand"
                : session.status === "lost"
                  ? "bg-danger/10 text-danger"
                  : "bg-panel-2 text-fg-2",
            )}
          >
            {session.status}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px] text-fg-2">
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5">
            {session.family}
          </span>
          <span className="rounded-md bg-panel border border-line-1 px-2 py-0.5">
            {session.thinking}
          </span>
          <span
            className="rounded-md bg-panel border border-line-1 px-2 py-0.5 font-mono"
            aria-label={`Pane: ${session.tmuxWindow}`}
          >
            {session.tmuxWindow}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Requests",
            value:
              logState === "ready"
                ? formatUsageValue(String(usageTotals.requests), usagePartial)
                : "—",
          },
          {
            label: "Input tokens",
            value:
              logState === "ready"
                ? formatUsageValue(usageTotals.input.toLocaleString(), usagePartial)
                : "—",
          },
          {
            label: "Output tokens",
            value:
              logState === "ready"
                ? formatUsageValue(usageTotals.output.toLocaleString(), usagePartial)
                : "—",
          },
          {
            label: "Cost",
            value:
              logState !== "ready"
                ? "—"
                : usageTotals.cost === null
                  ? formatUsageValue("not reported", usagePartial)
                  : formatUsageValue(`$${usageTotals.cost.toFixed(4)}`, usagePartial),
          },
        ].map((chip) => (
          <div
            key={chip.label}
            className="rounded-2xl border border-line-2 bg-panel px-4 py-3 flex flex-col gap-1"
          >
            <span className="text-[11px] uppercase tracking-wide text-fg-3">{chip.label}</span>
            <span
              className={cn(
                "text-xl font-semibold text-fg-1",
                usagePartial && logState === "ready" && "text-warn",
              )}
            >
              {chip.value}
            </span>
          </div>
        ))}
      </div>

      {session.worktreePath !== null && (
        <div className="rounded-2xl border border-line-2 bg-panel p-4 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-fg-3">Worktree</span>
          <span className="text-[12px] font-mono text-fg-2 break-all">{session.worktreePath}</span>
        </div>
      )}

      {detail?.attachCommand != null && (
        <div className="rounded-2xl border border-line-2 bg-panel p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-fg-3">
              Attach to this seat
            </span>
            <button
              type="button"
              onClick={() => {
                void copyAttachCommand();
              }}
              className="rounded-lg bg-panel-2 border border-line-1 px-3 py-1 text-[11px] font-medium text-fg-1"
            >
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </button>
          </div>
          <code className="text-[12px] font-mono text-teal-brand break-all">
            {detail.attachCommand}
          </code>
          {copyState === "failed" && (
            <p className="text-[11px] text-danger" role="status">
              Could not copy — select the command and copy it manually.
            </p>
          )}
          <p className="text-[11px] text-fg-3">
            Run this yourself — Agent OS never attaches on your behalf. The pane survives daemon
            restarts.
          </p>
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-fg-1">Agent log</h3>
          <span className="text-[11px] text-fg-3">
            {logState === "ready" ? `${log.length} frames` : logState === "loading" ? "loading…" : logState}
            {logTruncated && " · oldest frames truncated"}
          </span>
        </div>
        {logState === "loading" && log.length === 0 ? (
          <div className="rounded-2xl border border-line-2 bg-panel px-4 py-3">
            <p className="text-[12px] text-fg-3">Loading agent log…</p>
          </div>
        ) : logState === "unavailable" && log.length === 0 ? (
          <EmptyState
            kind="server-error"
            title="Log unavailable"
            body="Could not reach agentosd to load this session's frames."
          />
        ) : logState === "ready" && log.length === 0 ? (
          <EmptyState
            kind="no-data"
            title="No frames yet"
            body="This seat has not reported any lifecycle or usage frames."
          />
        ) : (
          <div className="rounded-2xl border border-line-2 bg-panel overflow-hidden">
            <ul className="divide-y divide-line-1/60 max-h-[560px] overflow-y-auto">
              {[...log].reverse().map((envelope) => (
                <li key={envelope.id} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="shrink-0 w-20 text-[11px] font-mono text-fg-3">
                    {new Date(envelope.ts).toLocaleTimeString("en-GB")}
                  </span>
                  <span className="shrink-0 w-40 text-[11px] font-mono text-fg-3 truncate">
                    {envelope.event.type}
                  </span>
                  <span
                    className={cn(
                      "flex-1 min-w-0 text-[12px] break-words",
                      LIFECYCLE_TONE[envelope.event.type] ?? "text-fg-2",
                    )}
                  >
                    {summarise(envelope)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
