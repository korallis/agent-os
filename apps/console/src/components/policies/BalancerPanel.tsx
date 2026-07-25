"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";

/**
 * Auto-balancer surface (master plan §11 Phase 10, [R7]).
 *
 * Shows the roster, the live headroom behind every candidate, and what the
 * balancer would suggest right now — including its refusal when it cannot make
 * a legal suggestion.
 *
 * The panel deliberately states the BASIS of the ranking. There is no price
 * table in this product and `costUsd` is null on subscription plans, so the
 * balancer ranks on quota-window headroom; presenting that as a dollar saving
 * would be inventing a number nobody measured.
 */

interface RosterEntry {
  model: string;
  brainCapable: boolean;
}

interface BalancerConfig {
  enabled: boolean;
  roster: RosterEntry[];
  steerAwayPct: number;
  useReportedCost: boolean;
}

interface Considered {
  model: string;
  usedPct: number | null;
  tier: string | null;
  limitReached: boolean;
}

interface Suggestion {
  role: string;
  model: string;
  family: string;
  reason: string;
}

interface SuggestResult {
  enabled: boolean;
  suggestions: Suggestion[];
  considered: Considered[];
  costUsable: boolean;
  basis: string;
  refusal: string | null;
}

export function BalancerPanel() {
  const [config, setConfig] = useState<BalancerConfig | null>(null);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const configRes = await fetch("/api/agentos/config/effective", { cache: "no-store" });
        if (!configRes.ok) throw new Error(String(configRes.status));
        const body = (await configRes.json()) as { config?: { balancer?: BalancerConfig } };
        if (cancelled) return;
        setConfig(body.config?.balancer ?? null);

        // Ask the balancer what it would do right now — advisory, so this is a
        // read of its opinion, never an action on the fleet.
        const suggestRes = await fetch("/api/agentos/tools/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool: "suggest_cast",
            input: { roles: ["builder", "validator"] },
          }),
        });
        if (!suggestRes.ok) return;
        const suggestBody = (await suggestRes.json()) as { ok?: boolean; data?: SuggestResult };
        if (!cancelled && suggestBody.ok === true && suggestBody.data !== undefined) {
          setResult(suggestBody.data);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="text-[13px] text-danger">Balancer configuration unavailable.</p>;
  }
  if (config === null) {
    return <p className="text-[13px] text-fg-3">Loading balancer…</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold text-fg-1">Auto-balancer</h3>
          <p className="text-[12px] text-fg-3">
            Spreads work across your roster by remaining quota window. Advisory — the Brain still
            chooses the cast, and the cross-family rule is never weakened to fit a suggestion.
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-[20px] px-3 py-1 text-[11px] font-semibold",
            config.enabled ? "bg-ok/10 text-ok" : "bg-panel-2 text-fg-3",
          )}
        >
          {config.enabled ? "ON" : "OFF"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-fg-3">Roster</span>
        {config.roster.map((entry) => (
          <div
            key={entry.model}
            className="flex items-center justify-between gap-3 rounded-[10px] border border-line-1 bg-shell px-4 py-2.5"
          >
            <span className="font-mono text-[12px] text-fg-1">{entry.model}</span>
            <span className="text-[11px] text-fg-3">
              {entry.brainCapable ? "crew + Brain" : "crew only"}
            </span>
          </div>
        ))}
        <p className="text-[11px] text-fg-3">
          Steers away past {config.steerAwayPct}% used — deliberately below the Brain handoff
          threshold, so crew work moves first and the Brain only moves if that was not enough.
        </p>
      </div>

      {result !== null && (
        <div className="flex flex-col gap-3">
          <span className="text-[11px] font-medium text-fg-3">
            What it would suggest right now (builder + validator)
          </span>

          {!result.enabled ? (
            <p className="text-[12px] text-fg-3">
              The balancer is off, so no suggestion is made and nothing is recorded.
            </p>
          ) : result.refusal !== null ? (
            <div className="rounded-[10px] border border-warn/40 bg-warn/[0.06] px-4 py-3">
              <p className="text-[12px] font-semibold text-warn">Declined to suggest</p>
              <p className="mt-1 text-[12px] text-fg-2">{result.refusal}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {result.suggestions.map((suggestion) => (
                <div
                  key={suggestion.role}
                  className="rounded-[10px] border border-line-1 bg-shell px-4 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-fg-3">
                      {suggestion.role}
                    </span>
                    <span className="font-mono text-[12px] text-fg-1">{suggestion.model}</span>
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-fg-2">
                      {suggestion.family}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-fg-3">{suggestion.reason}</p>
                </div>
              ))}
            </div>
          )}

          {result.considered.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-fg-3">Candidates considered</span>
              {result.considered.map((candidate) => (
                <div
                  key={candidate.model}
                  className="flex items-center justify-between gap-3 text-[11px]"
                >
                  <span className="font-mono text-fg-2">{candidate.model}</span>
                  <span className={cn(candidate.limitReached ? "text-danger" : "text-fg-3")}>
                    {candidate.limitReached
                      ? "LIMIT REACHED — excluded"
                      : candidate.usedPct === null
                        ? "no window metric reported"
                        : `${Math.round(100 - candidate.usedPct)}% headroom · ${candidate.tier ?? "unknown"}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* The basis is stated, never implied — this is the honesty line. */}
          <p className="text-[11px] text-fg-3">Ranked on: {result.basis}</p>
        </div>
      )}
    </div>
  );
}
