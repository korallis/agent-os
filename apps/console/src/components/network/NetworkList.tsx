"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { EmptyState } from "@/components/shell/EmptyState";
import { useEventStream } from "@/lib/useEventStream";
import { useDebouncedRefreshKey } from "@/lib/useDebouncedRefreshKey";

/**
 * Network I/O — every outbound HTTP call the daemon actually made.
 *
 * Today the only traffic Agent OS originates is the quota probes, and each one
 * is recorded as a `net.request` frame in the durable log. This list is that
 * log, not a synthesized view: an empty list means the daemon has made no
 * outbound calls yet, which is a real and informative state.
 */

export interface NetworkRequestRow {
  requestId: string;
  connectionId: string | null;
  provider: string;
  method: string;
  url: string;
  protocol: string;
  status: number | null;
  durationMs: number;
  requestBytes: number | null;
  responseBytes: number | null;
  error: string | null;
  ts: string;
}

export function statusTone(status: number | null, error: string | null): string {
  if (error !== null) return "text-danger";
  if (status === null) return "text-fg-2";
  if (status >= 500) return "text-danger";
  if (status >= 400) return "text-warn";
  return "text-ok";
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-[10px] border border-line-1 bg-panel", className)}>{children}</div>
  );
}

export function NetworkList() {
  const [rows, setRows] = useState<NetworkRequestRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const { events } = useEventStream();
  const refreshKey = useDebouncedRefreshKey(events, (eventType) => eventType === "net.request");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agentos/network?limit=200", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { requests: NetworkRequestRow[] };
        if (cancelled) return;
        setRows(body.requests);
        setStatus("ready");
      } catch {
        if (cancelled) return;
        // Say "unavailable" rather than rendering an empty list, which would
        // read as "the daemon made no calls".
        setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (status === "loading") {
    return <p className="py-8 text-center text-[13px] text-fg-3">Loading network activity…</p>;
  }
  if (status === "unavailable") {
    return (
      <EmptyState
        kind="server-error"
        title="Network activity unavailable"
        body="The daemon did not return its outbound request log."
      />
    );
  }
  if (rows === null || rows.length === 0) {
    return (
      <EmptyState
        kind="no-data"
        title="No outbound requests yet"
        body="Agent OS records every HTTP call it originates. Quota probes appear here once a provider connection is polled."
      />
    );
  }

  return (
    <Card className="flex flex-col">
      <div className="flex items-center h-9 px-4 border-b border-line-1 font-mono text-[10px] font-medium text-fg-3 tracking-[1px]">
        <span className="w-[90px] shrink-0">TIME</span>
        <span className="w-[70px] shrink-0">METHOD</span>
        <span className="flex-1 min-w-0">ENDPOINT</span>
        <span className="w-[110px] shrink-0">PROVIDER</span>
        <span className="w-[70px] shrink-0">STATUS</span>
        <span className="w-[80px] shrink-0 text-right">LATENCY</span>
        <span className="w-[80px] shrink-0 text-right">SIZE</span>
      </div>
      {rows.map((row) => (
        <Link
          key={row.requestId}
          href={`/network/${row.requestId}`}
          className="flex items-center px-4 py-2 text-xs border-b border-line-1 last:border-0 hover:bg-panel-2/60 transition-colors"
        >
          <span className="w-[90px] shrink-0 font-mono text-[11px] text-fg-2">
            {new Date(row.ts).toLocaleTimeString()}
          </span>
          <span className="w-[70px] shrink-0 font-mono text-[11px] text-fg-1">{row.method}</span>
          <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-fg-1">{row.url}</span>
          <span className="w-[110px] shrink-0 text-fg-2">{row.provider}</span>
          <span
            className={cn("w-[70px] shrink-0 font-mono text-[11px]", statusTone(row.status, row.error))}
          >
            {row.error !== null ? "ERROR" : (row.status ?? "—")}
          </span>
          <span className="w-[80px] shrink-0 text-right font-mono text-[11px] text-fg-2">
            {Math.round(row.durationMs)}ms
          </span>
          <span className="w-[80px] shrink-0 text-right font-mono text-[11px] text-fg-2">
            {formatBytes(row.responseBytes)}
          </span>
        </Link>
      ))}
    </Card>
  );
}
