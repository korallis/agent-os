"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { ProviderConnection, QuotaSample } from "@agent-os/protocol";
import { Icon } from "@/components/shell/Icon";

function ProviderLogo({ letter, className }: { letter: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-sm font-bold text-black",
        className,
      )}
    >
      {letter}
    </span>
  );
}

const LOGO: Record<string, { letter: string; className: string }> = {
  openai: { letter: "G", className: "bg-white" },
  anthropic: { letter: "A", className: "bg-[#d4a574]" },
  "claude-agent-sdk": { letter: "A", className: "bg-[#d4a574]" },
  openrouter: { letter: "O", className: "bg-[#6366f1]" },
  xai: { letter: "X", className: "bg-fg-1 text-black" },
  "kimi-coding": { letter: "K", className: "bg-teal-brand" },
};

/** Providers that support Pi subscription /login OAuth via the daemon. */
const OAUTH_PROVIDERS = ["openai", "anthropic", "xai"] as const;
/** Providers that accept API-key connect (keychain/file custody). */
const API_KEY_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;

type ConnectProvider = (typeof OAUTH_PROVIDERS)[number] | (typeof API_KEY_PROVIDERS)[number];

const CONNECT_ROWS: readonly {
  provider: ConnectProvider;
  oauth: boolean;
  apiKey: boolean;
}[] = [
  { provider: "openai", oauth: true, apiKey: true },
  { provider: "anthropic", oauth: true, apiKey: true },
  { provider: "openrouter", oauth: false, apiKey: true },
  { provider: "xai", oauth: true, apiKey: false },
];

function tierBadge(tier: string): string {
  if (tier === "live") return "● LIVE";
  if (tier === "best-effort") return "◌ BEST-EFFORT";
  return "≈ ESTIMATE";
}

/**
 * Live Providers panel — quota cards + connection rows (master plan §7.3).
 * Falls back to Figma-faithful empty/static treatment when the daemon is down.
 */
export function ProvidersPanel() {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [samples, setSamples] = useState<QuotaSample[]>([]);
  const [piVersion, setPiVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [oauthAttach, setOauthAttach] = useState<{
    provider: string;
    attachCommand: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/connections", { cache: "no-store" })
      .then(async (cRes) => {
        const qRes = await fetch("/api/agentos/quota", { cache: "no-store" });
        if (cancelled) return;
        if (!cRes.ok) {
          setError(`connections ${cRes.status}`);
          return;
        }
        const cBody = (await cRes.json()) as {
          connections: ProviderConnection[];
          piPinnedVersion?: string;
        };
        setConnections(cBody.connections);
        setPiVersion(cBody.piPinnedVersion ?? null);
        if (qRes.ok) {
          const qBody = (await qRes.json()) as { samples: QuotaSample[] };
          setSamples(qBody.samples);
        }
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("daemon unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const connectApiKey = async (provider: string, apiKey: string) => {
    setBusy(true);
    try {
      await fetch("/api/agentos/connections/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });
      setTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async (provider: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/agentos/connections/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          ...(provider === "anthropic" ? { billingMode: "extra-usage-oauth" } : {}),
        }),
      });
      if (!res.ok) {
        setError(`oauth/start ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        connectionId: string;
        attachCommand: string;
      };
      setOauthAttach({ provider, attachCommand: body.attachCommand });
      setTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  };

  const refreshQuota = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/agentos/connections/${id}/quota/refresh`, { method: "POST" });
      setTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  };

  const sampleFor = (id: string): QuotaSample | undefined =>
    samples.find((s) => s.connectionId === id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium uppercase tracking-wide text-fg-3">
          Pi harness {piVersion ?? "—"} · probes polled live
        </p>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          disabled={busy}
          className="rounded-lg border border-line-2 bg-panel-2 px-3 py-1.5 text-[12px] font-medium text-fg-2"
        >
          Refresh all ⟳
        </button>
      </div>

      {error !== null && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          {error} — showing last known / empty state
        </p>
      )}

      {oauthAttach !== null && (
        <div className="rounded-lg border border-teal-brand/30 bg-teal-brand/10 px-3 py-2">
          <p className="mb-1 text-[12px] font-semibold text-fg-1">
            OAuth login ready for {oauthAttach.provider}
          </p>
          <p className="mb-2 text-[12px] text-fg-3">
            Run this attach command in a terminal (uses managed PI_CONFIG_DIR):
          </p>
          <code className="block break-all rounded-md bg-shell px-2 py-1.5 text-[11px] text-fg-2">
            {oauthAttach.attachCommand}
          </code>
          <button
            type="button"
            className="mt-2 text-[12px] font-medium text-teal-brand"
            onClick={() => setOauthAttach(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Quota card grid */}
      {connections.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {connections.map((c) => {
            const sample = sampleFor(c.id);
            const primary = sample?.metrics[0];
            return (
              <div
                key={c.id}
                className="rounded-[12px] border border-line-2 bg-panel-1 p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-fg-1">{c.label}</span>
                  <span className="text-[11px] font-medium text-fg-3">
                    {primary ? tierBadge(primary.tier) : "—"}
                  </span>
                </div>
                {c.limitReached && (
                  <span className="mb-2 inline-flex rounded-[20px] bg-danger/15 px-2 py-0.5 text-[11px] font-semibold text-danger">
                    LIMIT REACHED
                  </span>
                )}
                {c.billingSurface === "extra-usage-per-token" && (
                  <p className="mb-2 text-[11px] font-medium text-warn">
                    EXTRA USAGE — PER-TOKEN BILLING
                  </p>
                )}
                {c.billingSurface === "sdk-credit-pool" && (
                  <p className="mb-2 text-[11px] font-medium text-ok">
                    SDK CREDIT POOL (subscription)
                  </p>
                )}
                {primary !== undefined ? (
                  <>
                    <p className="text-[28px] font-semibold tabular-nums text-fg-1">
                      {primary.unit === "percent"
                        ? `${primary.value}% used`
                        : `${primary.value} ${primary.unit}`}
                    </p>
                    {primary.unit === "percent" && (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-shell">
                        <div
                          className="h-full rounded-full bg-teal-brand"
                          style={{ width: `${Math.min(100, primary.value)}%` }}
                        />
                      </div>
                    )}
                    <p className="mt-2 text-[11px] uppercase tracking-wide text-fg-3">
                      {primary.source}
                    </p>
                    {primary.reason !== null && (
                      <p className="mt-1 text-[11px] text-fg-3">{primary.reason}</p>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-fg-3">No sample yet — refresh to probe</p>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refreshQuota(c.id)}
                  className="mt-3 text-[12px] font-medium text-teal-brand"
                >
                  Refresh card
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Connection management rows — Figma Settings · API Providers structure */}
      <div className="flex flex-col gap-3">
        {CONNECT_ROWS.map(({ provider, oauth, apiKey }) => {
          const existing = connections.find((c) => c.provider === provider);
          const logo = LOGO[provider] ?? { letter: "?", className: "bg-fg-3" };
          return (
            <div key={provider} className="flex flex-col gap-2 border-t border-line-2 pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2.5">
                  <ProviderLogo letter={logo.letter} className={logo.className} />
                  <span className="text-[15px] font-semibold text-fg-1">
                    {existing?.label ?? provider}
                  </span>
                </span>
                {existing !== undefined &&
                (existing.health === "healthy" || existing.kind === "pi-api-key") ? (
                  <span className="flex items-center gap-1.5 rounded-[20px] bg-ok/[0.08] px-2.5 py-1 text-[11px] font-semibold text-ok">
                    <span className="size-1.5 rounded-[3px] bg-ok" /> Connected
                  </span>
                ) : existing !== undefined && existing.kind === "pi-oauth" ? (
                  <span className="flex items-center gap-1.5 rounded-[20px] bg-warn/10 px-2.5 py-1 text-[11px] font-medium text-warn">
                    <span className="size-1.5 rounded-[3px] bg-warn" /> OAuth pending
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 rounded-[20px] bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-fg-3">
                    <span className="size-1.5 rounded-[3px] bg-fg-3" /> Not Connected
                  </span>
                )}
              </div>
              {existing?.kind === "pi-api-key" && existing.health === "healthy" ? (
                <div className="flex h-[42px] items-center justify-between rounded-[10px] bg-shell border border-line-2 px-[15px]">
                  <span className="text-[13px] text-fg-3">•••••••••••••••• (keychain)</span>
                  <Icon src="ap-eye.svg" className="size-3.5" />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {oauth && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void startOAuth(provider)}
                      className="self-start flex h-[33px] items-center rounded-lg border border-line-2 bg-panel-2 px-4 text-[13px] font-medium text-fg-2"
                    >
                      Connect with OAuth
                    </button>
                  )}
                  {apiKey && (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const key = String(fd.get("key") ?? "");
                        if (key.length > 0) void connectApiKey(provider, key);
                        e.currentTarget.reset();
                      }}
                    >
                      <input
                        name="key"
                        type="password"
                        placeholder={`Enter ${provider} API key…`}
                        className="h-[42px] rounded-[10px] border border-line-2 bg-shell px-[15px] text-[13px] text-fg-1 outline-none"
                        autoComplete="off"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        className="self-start flex h-[33px] items-center rounded-lg border border-line-2 bg-panel-2 px-4 text-[13px] font-medium text-fg-2"
                      >
                        Connect API key
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
