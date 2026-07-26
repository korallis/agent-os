"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@agent-os/ui";
import type { PipelineFinding, PipelineRunSnapshot } from "@agent-os/protocol";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Live view of the `no-mistakes` gate (master plan §11 Phase 9, [R7]).
 *
 * Until now, work entering the gate meant Agent OS went blind. This renders the
 * gate's own state, republished onto Agent OS's event log, so it arrives over
 * the same SSE path as everything else.
 *
 * Latency under quiet: quiet surfaces pipeline.run_updated (run-level state is
 * not log firehose) so this page invalidates from those SSE frames and hits the
 * 1s Console budget without a 1s REST poll floor. A short REST poll remains as
 * a backstop when SSE is down or a frame is missed; streamPipelineLogs stays
 * off under quiet so step-log volume is still opted into. config.changed still
 * refreshes profile knobs without a full reload.
 *
 * The header states the TRANSPORT and the observed lag as fact. Labels match
 * modes that can actually occur today: WAL-assisted (fs.watch + poll floor) or
 * interval-only. A true push `live` path is not claimed until it exists.
 */

type PipelineTransport = "wal-assisted" | "interval-only" | "unavailable";

type PipelineLogBehind = {
  runId: string;
  step: string;
  unreadBytes: number;
};

type PipelineStatus = {
  transport: PipelineTransport;
  compatibility: { ok: boolean; reason: string | null; missingColumns: string[] };
  lagMs: number | null;
  home: string;
  logBehind?: PipelineLogBehind[];
  profile?: {
    name: string;
    pipelineLogChars: number;
    streamPipelineLogs: boolean;
  };
};

type LogRange = { start: number; end: number };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function utf8SliceByBytes(text: string, startByte: number, endByte?: number): string {
  const bytes = utf8Encoder.encode(text);
  return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

/**
 * Merge a file range into a continuous client buffer by byte offset.
 * Overlapping regions keep the existing text and only take uncovered suffixes/prefixes.
 */
function mergeLogRange(
  cur: { start: number; end: number; text: string } | undefined,
  rangeStart: number,
  rangeText: string,
  rangeEnd?: number,
): { start: number; end: number; text: string } {
  const end = rangeEnd ?? rangeStart + utf8ByteLength(rangeText);
  if (!cur) return { start: rangeStart, end, text: rangeText };
  if (rangeStart >= cur.start && end <= cur.end) return cur;

  if (rangeStart <= cur.end && end > cur.end) {
    const skip = Math.max(0, cur.end - rangeStart);
    const suffix = skip === 0 ? rangeText : utf8SliceByBytes(rangeText, skip);
    return { start: cur.start, end, text: cur.text + suffix };
  }

  if (end >= cur.start && rangeStart < cur.start) {
    const take = Math.max(0, cur.start - rangeStart);
    const prefix = take === 0 ? "" : utf8SliceByBytes(rangeText, 0, take);
    return { start: rangeStart, end: cur.end, text: prefix + cur.text };
  }

  if (rangeStart > cur.end) {
    return { start: cur.start, end, text: cur.text + rangeText };
  }
  if (end < cur.start) {
    return { start: rangeStart, end: cur.end, text: rangeText + cur.text };
  }
  return cur;
}

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

function transportLabel(transport: PipelineTransport | undefined): string {
  switch (transport) {
    case "wal-assisted":
      return "WAL-ASSISTED";
    case "interval-only":
      return "INTERVAL-ONLY";
    default:
      return "UNAVAILABLE";
  }
}

function transportTone(transport: PipelineTransport | undefined): string {
  switch (transport) {
    case "wal-assisted":
      return "bg-ok/10 text-ok";
    case "interval-only":
      return "bg-electric/10 text-electric";
    default:
      return "bg-warn/10 text-warn";
  }
}

function transportDescription(status: PipelineStatus | null): string {
  if (status === null) return "Checking the local gate…";
  switch (status.transport) {
    case "wal-assisted":
      return `WAL-assisted — near-immediate reaction on gate writes${
        status.lagMs === null ? "" : ` · last read ${Math.round(status.lagMs)}ms ago`
      }`;
    case "interval-only":
      return `Interval-only — polling the gate at the configured cadence${
        status.lagMs === null ? "" : ` · last read ${Math.round(status.lagMs)}ms ago`
      }`;
    default:
      return "The local no-mistakes gate could not be read";
  }
}

/** Consecutive BFF/daemon blips before the whole page is treated as dead. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function clearLogState(
  appliedLogIds: { current: Set<string> },
  logsRef: { current: Record<string, string> },
  logTruncatedRef: { current: Record<string, boolean> },
  logRangesRef: { current: Record<string, LogRange> },
  setLogs: (v: Record<string, string>) => void,
  setLogTruncated: (v: Record<string, boolean>) => void,
  seededCatchUpKeys: { current: Set<string> },
): void {
  appliedLogIds.current.clear();
  seededCatchUpKeys.current.clear();
  logsRef.current = {};
  logTruncatedRef.current = {};
  logRangesRef.current = {};
  setLogs({});
  setLogTruncated({});
}

export function PipelineView() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [runs, setRuns] = useState<PipelineRunSnapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  /** Transient refresh failure with last-known data still shown (not schema drift). */
  const [stale, setStale] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logTruncated, setLogTruncated] = useState<Record<string, boolean>>({});
  const [pollTick, setPollTick] = useState(0);
  const { events } = useEventStream();
  /** Event ids already folded into log state — SSE ring eviction must not erase text. */
  const appliedLogIds = useRef(new Set<string>());
  /** Mirror of `logs` for append-only updates without reading stale state. */
  const logsRef = useRef<Record<string, string>>({});
  const logTruncatedRef = useRef<Record<string, boolean>>({});
  /** Byte ranges covered by each step log buffer (for seed/SSE de-dupe). */
  const logRangesRef = useRef<Record<string, LogRange>>({});
  const consecutivePollFailures = useRef(0);
  /** Whether we have ever painted a successful pipeline status response. */
  const hasLastKnown = useRef(false);
  /** Keys already seeded via /v1/pipeline/log-tails (or SSE) so catch-up runs once. */
  const seededCatchUpKeys = useRef(new Set<string>());

  // Hold retention at 0 until /v1/pipeline/status lands the real profile
  // budget — a provisional 20k window permanently discards middle text when
  // the active profile allows more (e.g. firehose 200k).
  const logChars = status?.profile?.pipelineLogChars ?? 0;
  const streamPipelineLogs = status?.profile?.streamPipelineLogs ?? false;

  // Profile / watch knobs land as config.changed and must re-fetch status so
  // pipelineLogChars and transport updates take effect without waiting a poll.
  const observabilityConfigCursor =
    events.find(
      (envelope) =>
        envelope.event.type === "config.changed" &&
        envelope.event.payload.domain === "observability",
    )?.id ?? "none";

  // Run-card frames (including under quiet) invalidate the REST snapshot.
  const runUpdatedCursor =
    events.find((envelope) => envelope.event.type === "pipeline.run_updated")?.id ?? "none";
  const unavailableCursor =
    events.find((envelope) => envelope.event.type === "pipeline.unavailable")?.id ?? "none";

  // Short REST backstop (~400ms) so a missed SSE frame cannot freeze the page.
  // Primary path is SSE-driven invalidation of pipeline.run_updated above.
  useEffect(() => {
    const id = setInterval(() => {
      setPollTick((n) => n + 1);
    }, 400);
    return () => clearInterval(id);
  }, []);

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
        const runsBody = (await runsRes.json()) as {
          runs: PipelineRunSnapshot[];
          unavailable?: boolean;
        };
        if (cancelled) return;
        consecutivePollFailures.current = 0;
        hasLastKnown.current = true;
        setStale(false);
        setFailed(false);
        setStatus(statusBody.pipeline);
        // Never paint prior snapshots when the gate is not currently readable.
        // This is schema/transport unreadable — not a transient fetch blip.
        const unreadable =
          statusBody.pipeline.compatibility.ok === false ||
          statusBody.pipeline.transport === "unavailable" ||
          runsBody.unavailable === true;
        if (unreadable) {
          setRuns([]);
          clearLogState(
            appliedLogIds,
            logsRef,
            logTruncatedRef,
            logRangesRef,
            setLogs,
            setLogTruncated,
            seededCatchUpKeys,
          );
        } else {
          setRuns(runsBody.runs);
        }
      } catch {
        if (cancelled) return;
        consecutivePollFailures.current += 1;
        // Keep last-known rows across brief BFF/daemon blips. Only blank the
        // page after consecutive failures; without last-known data, stay on
        // the loading path until the threshold is hit.
        if (consecutivePollFailures.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setFailed(true);
          setStale(false);
        } else if (hasLastKnown.current) {
          setStale(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollTick, observabilityConfigCursor, runUpdatedCursor, unavailableCursor]);

  // Append-only by event id, then window with pipelineLogChars. Rebuilding the
  // whole string from the capped SSE ring would drop middle text when frames
  // leave the ring while retention still had room — worse than a trailing window.
  // Chunks carry a file byte offset so attach-time seeds can de-dupe by range.
  useEffect(() => {
    const retention = Math.max(0, logChars);
    if (retention === 0) {
      clearLogState(
        appliedLogIds,
        logsRef,
        logTruncatedRef,
        logRangesRef,
        setLogs,
        setLogTruncated,
        seededCatchUpKeys,
      );
      return;
    }

    const appended = events.filter((e) => e.event.type === "pipeline.log_appended");
    // Newest-first buffer → process oldest-first so chunks concatenate in order.
    const chronological = [...appended].reverse();
    const fresh = chronological.filter((e) => !appliedLogIds.current.has(e.id));

    const next = { ...logsRef.current };
    const nextTrunc = { ...logTruncatedRef.current };
    const nextRanges = { ...logRangesRef.current };
    let textChanged = false;
    let truncChanged = false;

    for (const envelope of fresh) {
      appliedLogIds.current.add(envelope.id);
      if (envelope.event.type !== "pipeline.log_appended") continue;
      const payload = envelope.event.payload;
      const { runId, step, chunk } = payload;
      const key = `${runId}:${step}`;
      const offset =
        "offset" in payload && typeof payload.offset === "number" ? payload.offset : undefined;
      const prior = nextRanges[key];
      const merged = mergeLogRange(
        prior ? { start: prior.start, end: prior.end, text: next[key] ?? "" } : undefined,
        offset ?? prior?.end ?? 0,
        chunk,
      );
      if (merged.text !== (next[key] ?? "")) {
        next[key] = merged.text;
        textChanged = true;
      }
      nextRanges[key] = { start: merged.start, end: merged.end };
      seededCatchUpKeys.current.add(key);
    }

    // Re-window against current retention (overflow from new chunks or profile shrink).
    for (const [key, text] of Object.entries(next)) {
      if (text.length > retention) {
        const sliced = text.slice(-retention);
        next[key] = sliced;
        textChanged = true;
        const range = nextRanges[key];
        if (range !== undefined) {
          const newBytes = utf8ByteLength(sliced);
          nextRanges[key] = { start: range.end - newBytes, end: range.end };
        }
        if (nextTrunc[key] !== true) {
          nextTrunc[key] = true;
          truncChanged = true;
        }
      }
    }

    if (textChanged || fresh.length > 0) {
      logsRef.current = next;
      logRangesRef.current = nextRanges;
      if (textChanged) setLogs(next);
    }
    if (truncChanged) {
      logTruncatedRef.current = nextTrunc;
      setLogTruncated(nextTrunc);
    }
  }, [events, logChars]);

  // Prune retained log text for runs that left the visible set so a long-lived
  // Console tab under working/firehose cannot accumulate every historical step.
  useEffect(() => {
    if (runs === null) return;
    const liveRunIds = new Set(runs.map((r) => r.runId));
    const pruneRecord = <T,>(record: Record<string, T>): { next: Record<string, T>; changed: boolean } => {
      let changed = false;
      const next: Record<string, T> = {};
      for (const [key, value] of Object.entries(record)) {
        const sep = key.indexOf(":");
        const runId = sep === -1 ? key : key.slice(0, sep);
        if (liveRunIds.has(runId)) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return { next, changed };
    };

    const prunedLogs = pruneRecord(logsRef.current);
    const prunedTrunc = pruneRecord(logTruncatedRef.current);
    const prunedRanges = pruneRecord(logRangesRef.current);
    if (prunedLogs.changed) {
      logsRef.current = prunedLogs.next;
      setLogs(prunedLogs.next);
    }
    if (prunedTrunc.changed) {
      logTruncatedRef.current = prunedTrunc.next;
      setLogTruncated(prunedTrunc.next);
    }
    if (prunedRanges.changed) {
      logRangesRef.current = prunedRanges.next;
    }
    for (const key of [...seededCatchUpKeys.current]) {
      const sep = key.indexOf(":");
      const runId = sep === -1 ? key : key.slice(0, sep);
      if (!liveRunIds.has(runId)) seededCatchUpKeys.current.delete(key);
    }
  }, [runs]);

  // Attach-time catch-up: seed the last pipelineLogChars of each active step.
  // Pure read on the daemon — seed and live frames may overlap; merge by byte
  // offset so early SSE chunks never permanently discard the seed prefix.
  useEffect(() => {
    if (runs === null || status === null) return;
    if (!status.compatibility.ok || status.transport === "unavailable") return;
    if (!streamPipelineLogs || logChars <= 0) return;

    const needsSeed = runs.some((run) => {
      const active = run.steps.find((s) => s.status === "running" || s.status === "fixing");
      if (active === undefined) return false;
      const key = `${run.runId}:${active.step}`;
      return !seededCatchUpKeys.current.has(key);
    });
    if (!needsSeed) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agentos/pipeline/log-tails", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          streamPipelineLogs: boolean;
          pipelineLogChars: number;
          tails: Array<{
            runId: string;
            step: string;
            text: string;
            truncated: boolean;
            startOffset: number;
            endOffset: number;
          }>;
        };
        if (cancelled || !body.streamPipelineLogs) return;
        const next = { ...logsRef.current };
        const nextTrunc = { ...logTruncatedRef.current };
        const nextRanges = { ...logRangesRef.current };
        let textChanged = false;
        let truncChanged = false;
        for (const tail of body.tails) {
          const key = `${tail.runId}:${tail.step}`;
          seededCatchUpKeys.current.add(key);
          if (tail.text.length === 0) continue;
          const prior = nextRanges[key];
          const merged = mergeLogRange(
            prior ? { start: prior.start, end: prior.end, text: next[key] ?? "" } : undefined,
            tail.startOffset,
            tail.text,
            tail.endOffset,
          );
          if (merged.text !== (next[key] ?? "")) {
            next[key] = merged.text;
            textChanged = true;
          }
          nextRanges[key] = { start: merged.start, end: merged.end };
          if (tail.truncated) {
            nextTrunc[key] = true;
            truncChanged = true;
          }
        }
        // Mark remaining active keys as seeded even when empty so we do not
        // re-fetch every poll while a step has not written yet.
        for (const run of runs) {
          const active = run.steps.find((s) => s.status === "running" || s.status === "fixing");
          if (active === undefined) continue;
          seededCatchUpKeys.current.add(`${run.runId}:${active.step}`);
        }
        // Re-window after merge so a large seed cannot exceed retention.
        const retention = Math.max(0, logChars);
        if (retention > 0) {
          for (const [key, text] of Object.entries(next)) {
            if (text.length > retention) {
              const sliced = text.slice(-retention);
              next[key] = sliced;
              textChanged = true;
              const range = nextRanges[key];
              if (range !== undefined) {
                nextRanges[key] = {
                  start: range.end - utf8ByteLength(sliced),
                  end: range.end,
                };
              }
              if (nextTrunc[key] !== true) {
                nextTrunc[key] = true;
                truncChanged = true;
              }
            }
          }
        }
        if (textChanged) {
          logsRef.current = next;
          logRangesRef.current = nextRanges;
          setLogs(next);
        } else {
          logRangesRef.current = nextRanges;
        }
        if (truncChanged) {
          logTruncatedRef.current = nextTrunc;
          setLogTruncated(nextTrunc);
        }
      } catch {
        // Catch-up is best-effort; live SSE still covers new growth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runs, status, streamPipelineLogs, logChars]);

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
  const transportDown = status !== null && status.transport === "unavailable";
  // Suppress the run list whenever the view is not readable — a banner that
  // says nothing below is current must not sit above last-known rows.
  // Transient poll failures (stale) deliberately keep last-known rows.
  const visibleRuns = incompatible || transportDown ? [] : (runs ?? []);

  return (
    <div className="flex flex-col gap-5">
      {/* Transport honesty banner — always shown, never implied. */}
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-1 bg-panel px-4 py-3">
        <span
          className={cn(
            "rounded-[20px] px-2.5 py-1 text-[11px] font-semibold",
            transportTone(status?.transport),
          )}
        >
          {transportLabel(status?.transport)}
        </span>
        <span className="text-[12px] text-fg-2">{transportDescription(status)}</span>
        <span className="ml-auto text-[11px] text-fg-3">read-only · never drives the pipeline</span>
      </div>

      {stale && !incompatible && (
        // Distinct from schema-unreadable: data was trustworthy a moment ago;
        // we simply could not refresh. Last-known rows stay visible.
        <div className="rounded-[10px] border border-electric/40 bg-electric/[0.06] px-4 py-3">
          <p className="text-[13px] font-semibold text-electric">Refresh delayed — showing last-known</p>
          <p className="mt-1 text-[12px] text-fg-2">
            The pipeline API could not be reached on the last poll. Rows below are
            the last successful read, not confirmed current.
          </p>
        </div>
      )}

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

      {incompatible ? null : runs === null ? (
        <p className="py-8 text-center text-[13px] text-fg-3">Loading pipeline runs…</p>
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          kind="no-data"
          title="No pipeline runs yet"
          body="Runs appear here as soon as work enters the no-mistakes gate — including runs started outside Agent OS."
        />
      ) : (
        visibleRuns.map((run) => {
          const awaiting = run.steps.find((s) => isAwaitingDecision(s.status));
          const active = run.steps.find((s) => s.status === "running" || s.status === "fixing");
          const logKey = active ? `${run.runId}:${active.step}` : null;
          const logText = logKey === null ? null : (logs[logKey] ?? null);
          const findings: PipelineFinding[] = awaiting?.findings ?? [];
          const logBehind =
            active === undefined
              ? undefined
              : status?.logBehind?.find((b) => b.runId === run.runId && b.step === active.step);
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

              {awaiting !== undefined && findings.length > 0 && (
                <div className="border-t border-line-1 px-4 py-3">
                  <p className="mb-2 text-[11px] font-medium text-fg-3">Findings</p>
                  <div className="overflow-x-auto rounded-[8px] border border-line-1">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-panel-2 text-fg-3">
                        <tr>
                          <th className="px-3 py-2 font-medium">Severity</th>
                          <th className="px-3 py-2 font-medium">Action</th>
                          <th className="px-3 py-2 font-medium">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {findings.map((finding) => (
                          <tr key={finding.id} className="border-t border-line-1">
                            <td className="px-3 py-2 font-mono text-fg-2">{finding.severity}</td>
                            <td className="px-3 py-2 font-mono text-warn">{finding.action}</td>
                            <td className="px-3 py-2 text-fg-1">{finding.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {active !== undefined && (
                <div className="border-t border-line-1 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-medium text-fg-3">
                      {active.step} · {active.status}
                    </span>
                    {active.lastActivity !== null && (
                      <span className="text-[11px] text-fg-2">{active.lastActivity}</span>
                    )}
                    {logKey !== null && logTruncated[logKey] === true && logChars > 0 && (
                      <span className="text-[11px] text-fg-3">
                        showing the last {logChars.toLocaleString()} characters
                      </span>
                    )}
                    {logBehind !== undefined && logBehind.unreadBytes > 0 && (
                      <span className="text-[11px] text-warn">
                        stream behind · {logBehind.unreadBytes.toLocaleString()} bytes unread
                      </span>
                    )}
                  </div>
                  {!streamPipelineLogs ? (
                    <p className="text-[11px] text-fg-3">
                      Step log streaming is off under the active observability profile (
                      {status?.profile?.name ?? "quiet"}). Switch to working or firehose to see live
                      output.
                    </p>
                  ) : logText !== null && logText.length > 0 ? (
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
