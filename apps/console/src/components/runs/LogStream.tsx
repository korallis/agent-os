"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import type { EventEnvelope } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";
import { useEventStream } from "@/lib/useEventStream";

type Level = "INFO" | "WARN" | "ERROR";
type Filter = "All" | "Info" | "Warn" | "Error";

function levelOf(envelope: EventEnvelope): Level {
  switch (envelope.event.type) {
    case "config.rejected":
    case "provider.billing_mismatch":
    case "session.lost":
    case "brain.down":
    case "scout.write_violation":
      return "ERROR";
    case "daemon.stopping":
    case "quota.threshold":
    case "captain.escalation":
    case "wake.classified":
    case "crew.question":
      return "WARN";
    case "policy.changed":
      return envelope.event.payload.safetyOverride ? "WARN" : "INFO";
    case "daemon.started":
    case "config.installed":
    case "config.changed":
    case "provider.connection_updated":
    case "provider.credential_refreshed":
    case "quota.updated":
    case "ext.hello":
    case "ext.usage":
    case "onboarding.step":
    case "onboarding.completed":
    case "project.registered":
    case "project.updated":
    case "task.created":
    case "task.phase_changed":
    case "task.updated":
    case "task.cast_resolved":
    case "task.delivery_block_resolved":
    case "session.spawned":
    case "session.stopped":
    case "worktree.leased":
    case "worktree.released":
    case "brain.status":
    case "brain.handoff":
    case "tool.invoked":
    case "gate.result":
    case "gate.red_proven":
    case "fusion.dispatched":
    case "fusion.side_completed":
    case "prompt.installed":
    case "crew.answered":
    case "bridge.tool_call":
      return "INFO";
    case "fusion.completed":
      return envelope.event.payload.error != null && envelope.event.payload.error.length > 0
        ? "ERROR"
        : "INFO";
    default: {
      const _exhaustive: never = envelope.event;
      void _exhaustive;
      return "INFO";
    }
  }
}

function sourceOf(envelope: EventEnvelope): string {
  switch (envelope.event.type) {
    case "daemon.started":
    case "daemon.stopping":
      return "agentosd";
    case "config.installed":
      return "config";
    case "config.changed":
    case "config.rejected":
      return envelope.event.payload.domain;
    case "policy.changed":
      return "policies";
    case "provider.connection_updated":
    case "provider.credential_refreshed":
    case "provider.billing_mismatch":
      return "providers";
    case "quota.updated":
    case "quota.threshold":
      return "quota";
    case "ext.hello":
    case "ext.usage":
      return "extension";
    case "onboarding.step":
    case "onboarding.completed":
      return "onboarding";
    case "project.registered":
    case "project.updated":
      return "projects";
    case "task.created":
    case "task.phase_changed":
    case "task.updated":
    case "task.cast_resolved":
    case "task.delivery_block_resolved":
      return "tasks";
    case "session.spawned":
    case "session.stopped":
    case "session.lost":
      return "sessions";
    case "crew.question":
    case "crew.answered":
      return "crew";
    case "scout.write_violation":
      return "scout";
    case "bridge.tool_call":
      return "bridge";
    case "worktree.leased":
    case "worktree.released":
      return "worktrees";
    case "wake.classified":
      return "watcher";
    case "brain.status":
    case "brain.handoff":
    case "brain.down":
      return "brain";
    case "tool.invoked":
      return "tools";
    case "gate.result":
    case "gate.red_proven":
      return "gate";
    case "fusion.dispatched":
    case "fusion.side_completed":
    case "fusion.completed":
      return "fusion";
    case "prompt.installed":
      return "prompts";
    case "captain.escalation":
      return "captain";
    default: {
      const _exhaustive: never = envelope.event;
      void _exhaustive;
      return "events";
    }
  }
}

function messageOf(envelope: EventEnvelope): string {
  const { event } = envelope;
  switch (event.type) {
    case "daemon.started":
      return `agentosd v${event.payload.version} started — pid ${event.payload.pid}, listening on 127.0.0.1:${event.payload.port}`;
    case "daemon.stopping":
      return event.payload.signal !== null
        ? `agentosd stopping — ${event.payload.reason} (${event.payload.signal})`
        : `agentosd stopping — ${event.payload.reason}`;
    case "config.installed":
      return `Shipped defaults installed — ${event.payload.domains.join(", ")}`;
    case "config.changed":
      return event.payload.hotReloaded
        ? `Config hot-reloaded — ${event.payload.domain} from ${event.payload.layer} layer (${event.payload.contentHash.slice(0, 8)})`
        : `Config applied — ${event.payload.domain} from ${event.payload.layer} layer (${event.payload.contentHash.slice(0, 8)})`;
    case "config.rejected":
      return `Config rejected — ${event.payload.domain}: ${event.payload.issues[0]?.path ?? ""} ${event.payload.issues[0]?.message ?? ""}`;
    case "policy.changed":
      return event.payload.safetyOverride
        ? "Safety policy override ACTIVE — confirmation was supplied"
        : "Policy change applied — all safety policies ON";
    case "provider.connection_updated":
      return `Connection ${event.payload.provider} · ${event.payload.health}${event.payload.limitReached ? " · LIMIT REACHED" : ""}`;
    case "provider.credential_refreshed":
      return `Credential presence refreshed — ${event.payload.provider}`;
    case "provider.billing_mismatch":
      return `BILLING_MISMATCH — expected ${event.payload.expectedPath}, observed ${event.payload.observedPath}`;
    case "quota.updated":
      return `Quota sample — ${event.payload.provider} (${event.payload.metrics.length} metrics)`;
    case "quota.threshold":
      return `Quota ${event.payload.level} — ${event.payload.provider}: ${event.payload.reason}`;
    case "ext.hello":
      return `Extension hello — session ${event.payload.sessionId.slice(0, 8)}… role ${event.payload.role}`;
    case "ext.usage":
      return `Usage — ${event.payload.provider}/${event.payload.model} in=${event.payload.inputTokens ?? "?"} out=${event.payload.outputTokens ?? "?"}`;
    case "onboarding.step":
      return `Onboarding step → ${event.payload.step}`;
    case "onboarding.completed":
      return `Onboarding completed at ${event.payload.at}`;
    case "project.registered":
      return `Project registered — ${event.payload.name} (${event.payload.mode})`;
    case "project.updated":
      return `Project updated — ${event.payload.projectId.slice(0, 8)}…`;
    case "task.created":
      return `Task created — ${event.payload.title} [${event.payload.shape}]`;
    case "task.phase_changed":
      return `Task phase ${event.payload.from} → ${event.payload.to}`;
    case "task.updated":
      return `Task updated — ${event.payload.taskId.slice(0, 8)}…`;
    case "task.cast_resolved":
      return `Cast resolved — ${event.payload.roles.map((r) => r.role).join(", ")}`;
    case "task.delivery_block_resolved":
      return `Delivery block resolved — task ${event.payload.taskId.slice(0, 8)}… by ${event.payload.clearedBy}: ${event.payload.reason}`;
    case "session.spawned":
      return `Session spawned — ${event.payload.role} ${event.payload.model}`;
    case "session.stopped":
      return `Session stopped — ${event.payload.reason}`;
    case "session.lost":
      return `Session lost — ${event.payload.reason}`;
    case "worktree.leased":
      return `Worktree leased — ${event.payload.path}`;
    case "worktree.released":
      return `Worktree released${event.payload.quarantined ? " (quarantined)" : ""}`;
    case "wake.classified":
      return `Wake ${event.payload.class}${event.payload.absorbed ? " absorbed" : " → brain"}: ${event.payload.summary}`;
    case "brain.status":
      return `Brain ${event.payload.status}${event.payload.model !== null ? ` · ${event.payload.model}` : ""}`;
    case "brain.handoff":
      return `Brain handoff ${event.payload.fromModel} → ${event.payload.toModel}`;
    case "brain.down":
      return `BRAIN DOWN — ${event.payload.wakeQueueDepth} wakes queued — ${event.payload.reason}`;
    case "tool.invoked":
      return `Tool ${event.payload.tool} ${event.payload.ok ? "ok" : event.payload.errorCode ?? "err"} (${event.payload.durationMs}ms)`;
    case "gate.result":
      return `Gate ${event.payload.target} → ${event.payload.outcome}`;
    case "gate.red_proven":
      return `Gate RED proven — ${event.payload.outcome} · source ${event.payload.gateSourceHash.slice(0, 8)}`;
    case "fusion.dispatched":
      return `Fusion ${event.payload.kind} dispatched`;
    case "fusion.side_completed":
      return `Fusion side — ${event.payload.role} ${event.payload.model} (${event.payload.family}) · prompt ${event.payload.promptHash.slice(0, 8)}`;
    case "fusion.completed":
      return `Fusion ${event.payload.kind} complete — prompts ${event.payload.promptsIdentical ? "IDENTICAL" : "DIVERGED ⚠"}${event.payload.aggregatorFamily !== null ? ` · aggregator ${event.payload.aggregatorFamily}` : ""}${event.payload.contractOk === null ? "" : event.payload.contractOk ? " · contract OK" : " · CONTRACT FAILED"}${event.payload.error != null && event.payload.error.length > 0 ? ` · ERROR: ${event.payload.error}` : ""}`;
    case "prompt.installed":
      return `Prompt packs installed — ${event.payload.refs.join(", ")}`;
    case "crew.question":
      return `Crewmate asked — ${event.payload.question}`;
    case "crew.answered":
      return event.payload.delivered
        ? `Answer delivered to session ${event.payload.sessionId.slice(0, 8)}`
        : `Answer UNDELIVERED — session ${event.payload.sessionId.slice(0, 8)} has no live channel`;
    case "scout.write_violation":
      return `SCOUT WRITE VIOLATION — ${event.payload.changedPaths.length} path(s) in ${event.payload.worktreePath}${event.payload.quarantined ? " (worktree quarantined)" : ""}`;
    case "bridge.tool_call":
      return event.payload.accepted
        ? `Bridge ${event.payload.tool} accepted from ${event.payload.sessionId.slice(0, 8)}`
        : `Bridge ${event.payload.tool} refused — ${event.payload.reason ?? "unknown"}`;
    case "captain.escalation":
      return `Captain [${event.payload.severity}] ${event.payload.summary}`;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return "Unhandled event";
    }
  }
}

const LEVEL_TEXT: Record<Level, string> = {
  INFO: "text-fg-2",
  WARN: "text-warn",
  ERROR: "text-danger",
};

function timestampOf(envelope: EventEnvelope): string {
  const date = new Date(envelope.ts);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.toLocaleTimeString("en-GB")}.${ms}`;
}

function UtcClock() {
  const [now, setNow] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(`${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`);
    };
    const raf = requestAnimationFrame(tick);
    const timer = setInterval(tick, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, []);
  return <span className="font-mono text-xs text-fg-3">{now}</span>;
}

/**
 * Runs (§7.1 live feed) — the Figma "Live Log Stream" screen wired to the
 * real daemon SSE stream (NDJSON → SQLite → SSE with Last-Event-ID replay).
 * Filters, pause, search, and the detail panel operate on live events.
 */
export function LogStream() {
  const { state, events } = useEventStream(500);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<EventEnvelope[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const togglePause = () => {
    if (!paused) setFrozen(events); // freeze exactly what is on screen
    setPaused(!paused);
  };

  const visible = useMemo(() => {
    const source = paused ? frozen : events;
    return source.filter((envelope) => {
      if (filter !== "All" && levelOf(envelope) !== filter.toUpperCase()) return false;
      if (query.length > 0) {
        const haystack = `${messageOf(envelope)} ${sourceOf(envelope)}`.toLowerCase();
        if (!haystack.includes(query.toLowerCase())) return false;
      }
      return true;
    });
  }, [events, frozen, paused, filter, query]);

  const selected =
    visible.find((envelope) => envelope.id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="h-14 shrink-0 bg-panel border-b border-white/[0.04] flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link
            href="/fleet"
            className="flex items-center gap-1.5 h-[30px] rounded-lg bg-panel-2 border border-line-1 px-3"
          >
            <Icon src="ls-back.svg" className="size-3.5" />
            <span className="font-mono text-xs text-fg-2">Back</span>
          </Link>
          <span className="font-mono text-sm font-bold text-fg-1 tracking-[2px]">
            LIVE LOG STREAM
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 h-[19px] rounded px-2",
              state === "live" ? "bg-ok/[0.07]" : state === "down" ? "bg-danger/[0.07]" : "bg-line-1",
            )}
          >
            <span
              className={cn(
                "size-2 rounded",
                state === "live" ? "bg-ok" : state === "down" ? "bg-danger" : "bg-fg-3",
              )}
            />
            <span
              className={cn(
                "font-mono text-[10px] font-bold",
                state === "live" ? "text-ok" : state === "down" ? "text-danger" : "text-fg-3",
              )}
            >
              {state === "live" ? "STREAMING" : state === "down" ? "OFFLINE" : "CONNECTING"}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <UtcClock />
          <button
            type="button"
            onClick={togglePause}
            className="flex items-center gap-1.5 h-[29px] rounded-lg bg-panel-2 border border-line-1 px-3"
          >
            <Icon src="ls-pause.svg" className="size-3.5" />
            <span className="font-mono text-[11px] text-fg-2">
              {paused ? "Resume" : "Pause"}
            </span>
          </button>
          <Icon src="ls-gear.svg" className="size-[18px]" />
        </div>
      </div>

      {/* Filter bar */}
      <div className="h-12 shrink-0 border-b border-line-1 flex items-center justify-between px-6">
        <div className="flex items-center gap-2">
          {(
            [
              ["All", null],
              ["Info", "bg-ok"],
              ["Warn", "bg-warn"],
              ["Error", "bg-danger"],
            ] as const
          ).map(([label, dot]) => (
            <button
              key={label}
              type="button"
              onClick={() => setFilter(label)}
              className={cn(
                "flex items-center gap-1.5 h-[27px] rounded-md px-3 font-mono text-[11px] font-medium",
                filter === label
                  ? "bg-panel-2 border border-line-2 text-fg-1"
                  : "border border-transparent text-fg-2",
              )}
            >
              {dot !== null && <span className={cn("size-1.5 rounded-[3px]", dot)} />}
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 h-8 w-60 rounded-md bg-shell border border-line-2 px-3">
          <Icon src="ls-search.svg" className="size-3.5" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs..."
            className="w-full bg-transparent font-mono text-[11px] text-fg-1 placeholder:text-fg-4 focus:outline-none"
          />
        </label>
      </div>

      {/* Table + detail panel */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-9 shrink-0 bg-white/[0.02] border-b border-line-1 flex items-center px-6 font-mono text-[10px] font-medium text-fg-4 tracking-[1px]">
            <span className="w-[110px] shrink-0">TIMESTAMP</span>
            <span className="w-[70px] shrink-0">LEVEL</span>
            <span className="w-[140px] shrink-0">SOURCE</span>
            <span className="flex-1">MESSAGE</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-6 py-8 font-mono text-[11px] text-fg-3">
                {state === "down"
                  ? "agentosd unreachable — start the daemon: agentos start"
                  : "waiting for events..."}
              </p>
            ) : (
              visible.map((envelope) => {
                const level = levelOf(envelope);
                const isSelected = selected !== null && selected.id === envelope.id;
                return (
                  <button
                    key={envelope.id}
                    type="button"
                    onClick={() => setSelectedId(envelope.id)}
                    className={cn(
                      "w-full h-9 flex items-center px-6 border-b font-mono text-[11px] text-left",
                      level === "ERROR"
                        ? "bg-danger/[0.03] border-danger/[0.06]"
                        : isSelected
                          ? "bg-white/[0.03] border-white/[0.04] border-l-2 border-l-fg-1 pl-[22px]"
                          : "border-white/[0.02]",
                    )}
                  >
                    <span className="w-[110px] shrink-0 text-fg-3">
                      {timestampOf(envelope)}
                    </span>
                    <span className={cn("w-[70px] shrink-0 font-medium", LEVEL_TEXT[level])}>
                      [{level}]
                    </span>
                    <span className="w-[140px] shrink-0 text-fg-3 truncate">
                      {sourceOf(envelope)}
                    </span>
                    <span
                      className={cn(
                        "flex-1 truncate",
                        level === "ERROR"
                          ? "text-danger"
                          : level === "WARN"
                            ? "text-fg-1"
                            : "text-fg-2",
                      )}
                    >
                      {messageOf(envelope)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Detail panel */}
        <aside className="w-[380px] shrink-0 border-l border-line-1 overflow-y-auto">
          <div className="flex items-center justify-between px-5 py-4">
            <span className="font-mono text-[10px] font-medium text-fg-4 tracking-[1px]">
              LOG DETAIL
            </span>
            <Icon src="ls-close.svg" className="size-3.5" />
          </div>
          {selected === null ? (
            <p className="px-5 font-mono text-[11px] text-fg-3">no event selected</p>
          ) : (
            <div className="px-5 flex flex-col gap-5 pb-6">
              <span
                className={cn(
                  "self-start flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] font-bold",
                  levelOf(selected) === "ERROR"
                    ? "bg-danger/[0.07] text-danger"
                    : levelOf(selected) === "WARN"
                      ? "bg-warn/[0.07] text-warn"
                      : "bg-ok/[0.07] text-ok",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded",
                    levelOf(selected) === "ERROR"
                      ? "bg-danger"
                      : levelOf(selected) === "WARN"
                        ? "bg-warn"
                        : "bg-ok",
                  )}
                />
                {levelOf(selected) === "ERROR"
                  ? "ERROR"
                  : levelOf(selected) === "WARN"
                    ? "WARNING"
                    : "INFO"}
              </span>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] text-fg-4 tracking-[1px]">Message</span>
                <p className="font-mono text-[11px] leading-relaxed text-fg-1">
                  {messageOf(selected)}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] text-fg-4 tracking-[1px]">Metadata</span>
                {(
                  [
                    ["Timestamp", timestampOf(selected)],
                    ["Source", sourceOf(selected)],
                    ["Sequence", `#${selected.seq}`],
                    ["Event ID", selected.id.slice(0, 18)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-1 font-mono text-[11px]">
                    <span className="text-fg-3">{label}</span>
                    <span className="text-fg-1 font-medium">{value}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] text-fg-4 tracking-[1px]">Context</span>
                <pre className="rounded-lg bg-panel-2 border border-line-1 p-4 font-mono text-[10px] leading-[1.6] text-fg-2 overflow-x-auto">
                  {JSON.stringify(selected.event.payload, null, 2)}
                </pre>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
                  }}
                  className="flex items-center justify-center gap-2 h-9 rounded-lg bg-panel-2 border border-line-1 font-mono text-[11px] text-fg-2"
                >
                  <Icon src="ls-copy.svg" className="size-3.5" /> Copy
                </button>
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 h-9 rounded-lg bg-panel-2 border border-line-1 font-mono text-[11px] text-fg-2"
                >
                  <Icon src="ls-share.svg" className="size-3.5" /> Share
                </button>
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 h-9 rounded-lg bg-panel-2 border border-line-1 font-mono text-[11px] text-fg-2"
                >
                  <Icon src="ls-alert.svg" className="size-3.5" /> Alert
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
