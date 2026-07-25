"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { EmptyState } from "@/components/shell/EmptyState";
import { formatBytes, statusTone, type NetworkRequestRow } from "./NetworkList";

/**
 * Network I/O Detail — Figma frame `41:4815`.
 *
 * Inspects one outbound call the daemon actually made. Two honesty rules carry
 * over from the rest of the Console:
 *
 *  - Credentials are stored redacted at capture time, so the Authorization row
 *    shows `Bearer ****7f3a`. The full value is never written to the durable
 *    log, which would be permanent.
 *  - The Figma frame includes a per-phase Request Timeline (DNS, TCP, TLS,
 *    server processing, transfer). The fetch API does not expose those phases,
 *    so rather than inventing a plausible split of the total, this renders the
 *    measured total and states which phases are not instrumented.
 */

interface NetworkRequestDetail extends NetworkRequestRow {
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  responseBody: string | null;
}

type LoadState = "loading" | "ready" | "unavailable" | "not-found";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-[10px] border border-line-1 bg-panel", className)}>{children}</div>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card className="flex-1 min-w-0 px-4 py-3 flex flex-col gap-1">
      <span className="text-[11px] font-medium text-fg-3">{label}</span>
      <span className={cn("text-[20px] font-bold", tone ?? "text-fg-1")}>{value}</span>
    </Card>
  );
}

function HeaderRows({ rows }: { rows: Array<[string, string]> }) {
  if (rows.length === 0) {
    return <p className="text-[12px] text-fg-3">No headers recorded.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([name, value]) => (
        <div key={name} className="flex gap-2 font-mono text-[12px]">
          <span className="text-teal-brand shrink-0">{name}:</span>
          <span className="text-fg-2 break-all">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function NetworkDetail({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<NetworkRequestDetail | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [requestTab, setRequestTab] = useState<"headers" | "body">("headers");
  const [responseTab, setResponseTab] = useState<"headers" | "body">("body");

  useEffect(() => {
    let cancelled = false;
    // Parent remounts this component via key={requestId} on navigation so we
    // never need a sync state reset here (avoids cascading renders + the
    // cross-id identity bug already fixed on Session Detail).
    void (async () => {
      try {
        const res = await fetch(`/api/agentos/network/${requestId}`, { cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setState("not-found");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { request: NetworkRequestDetail };
        if (cancelled) return;
        setRequest(body.request);
        setState("ready");
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (state === "loading") {
    return <p className="py-10 text-center text-[13px] text-fg-3">Loading request…</p>;
  }
  if (state === "not-found") {
    return (
      <EmptyState
        kind="no-data"
        title="Request not found"
        body="This request is no longer in the retained window of the event log."
      />
    );
  }
  if (state === "unavailable" || request === null) {
    return (
      <EmptyState
        kind="server-error"
        title="Request unavailable"
        body="The daemon did not return this request."
      />
    );
  }

  const statusLabel =
    request.error !== null ? "FAILED" : request.status === null ? "—" : String(request.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/network"
            aria-label="Back to network activity"
            className="size-9 shrink-0 rounded-lg border border-line-1 bg-panel flex items-center justify-center text-fg-2 hover:text-fg-1"
          >
            ←
          </Link>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[16px] font-bold text-fg-1 truncate">
                {request.method} {request.url}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold",
                  request.error !== null || (request.status ?? 0) >= 400
                    ? "bg-danger/10 text-danger"
                    : "bg-ok/10 text-ok",
                )}
              >
                {statusLabel}
              </span>
            </div>
            <span className="text-[12px] text-fg-3">
              Request ID: {request.requestId} · Agent OS → {request.provider}
            </span>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <MetricCard
          label="Latency"
          value={`${Math.round(request.durationMs)}ms`}
          tone={statusTone(request.status, request.error)}
        />
        <MetricCard label="Request Size" value={formatBytes(request.requestBytes)} />
        <MetricCard label="Response Size" value={formatBytes(request.responseBytes)} />
        <MetricCard label="Timestamp" value={new Date(request.ts).toLocaleTimeString()} />
        <MetricCard label="Protocol" value={request.protocol} tone="text-electric" />
      </div>

      <div className="flex gap-5 items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <Card className="flex flex-col overflow-hidden">
            <div className="flex items-center gap-4 h-9 px-4 border-b border-line-1">
              <button
                type="button"
                onClick={() => setRequestTab("headers")}
                className={cn(
                  "text-[13px]",
                  requestTab === "headers" ? "font-semibold text-teal-brand" : "text-fg-3",
                )}
              >
                Request Headers
              </button>
              <button
                type="button"
                onClick={() => setRequestTab("body")}
                className={cn(
                  "text-[13px]",
                  requestTab === "body" ? "font-semibold text-teal-brand" : "text-fg-3",
                )}
              >
                Body
              </button>
            </div>
            <div className="p-4">
              {requestTab === "headers" ? (
                <HeaderRows rows={request.requestHeaders} />
              ) : (
                <p className="text-[12px] text-fg-3">
                  This request had no body — quota probes are GETs.
                </p>
              )}
            </div>
          </Card>

          <Card className="flex flex-col overflow-hidden">
            <div className="flex items-center gap-4 h-9 px-4 border-b border-line-1">
              <button
                type="button"
                onClick={() => setResponseTab("headers")}
                className={cn(
                  "text-[13px]",
                  responseTab === "headers" ? "font-semibold text-teal-brand" : "text-fg-3",
                )}
              >
                Response Headers
              </button>
              <button
                type="button"
                onClick={() => setResponseTab("body")}
                className={cn(
                  "text-[13px]",
                  responseTab === "body" ? "font-semibold text-teal-brand" : "text-fg-3",
                )}
              >
                Body
              </button>
            </div>
            <div className="bg-[#0d0d0d] p-4 min-h-[240px] overflow-x-auto">
              {responseTab === "headers" ? (
                <HeaderRows rows={request.responseHeaders} />
              ) : request.error !== null ? (
                <p className="font-mono text-[11px] text-danger">{request.error}</p>
              ) : request.responseBody === null ? (
                <p className="text-[12px] text-fg-3">No response body was captured.</p>
              ) : (
                <pre className="font-mono text-[11px] leading-[17.6px] text-job-id whitespace-pre-wrap">
                  {prettyJson(request.responseBody)}
                </pre>
              )}
            </div>
          </Card>
        </div>

        <div className="w-[300px] shrink-0 flex flex-col gap-4">
          <Card className="p-4 flex flex-col gap-3">
            <h3 className="text-[14px] font-semibold text-fg-1">Request Details</h3>
            {[
              ["Method", request.method],
              ["Status Code", statusLabel],
              ["Provider", request.provider],
              ["Protocol", request.protocol],
              ["Connection", request.connectionId ?? "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-fg-3">{label}</span>
                <span className="font-mono text-[12px] text-fg-1 truncate max-w-[170px]">
                  {value}
                </span>
              </div>
            ))}
          </Card>

          <Card className="p-4 flex flex-col gap-3">
            <h3 className="text-[14px] font-semibold text-fg-1">Request Timeline</h3>
            <div className="flex gap-2 items-start">
              <span className="mt-1 size-2 rounded bg-teal-brand shrink-0" />
              <div className="flex flex-col">
                <span className="text-[12px] font-medium text-fg-1">Total round trip</span>
                <span className="font-mono text-[11px] text-fg-3">
                  {Math.round(request.durationMs)}ms
                </span>
              </div>
            </div>
            {["DNS lookup", "TCP connection", "TLS handshake", "Server processing", "Content transfer"].map(
              (phase) => (
                <div key={phase} className="flex gap-2 items-start">
                  <span className="mt-1 size-2 rounded bg-line-2 shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-[12px] font-medium text-fg-2">{phase}</span>
                    <span className="font-mono text-[11px] text-fg-3">—</span>
                  </div>
                </div>
              ),
            )}
            {/* Stating why beats showing five plausible numbers that add to the
                total but were never measured. */}
            <p className="text-[11px] text-fg-3 leading-snug">
              Per-phase timings are not instrumented — the HTTP client reports only the total round
              trip. Only the measured figure is shown.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
