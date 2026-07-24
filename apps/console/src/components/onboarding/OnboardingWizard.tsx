"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import type { OnboardingState, PiProviderId } from "@agent-os/protocol";
import { Topbar } from "@/components/shell/Topbar";

const OAUTH_PROVIDERS = new Set(["openai", "anthropic", "xai"]);
const API_KEY_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "openrouter",
  "kimi-coding",
  "vercel-ai-gateway",
]);

/**
 * Guided, resumable onboarding wizard (§4.10).
 * Visual language matches the Figma dark dashboard; steps are live-verified.
 */
export function OnboardingWizard() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [oauthAttach, setOauthAttach] = useState<{
    provider: string;
    attachCommand: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/onboarding", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(`status ${res.status}`);
          return;
        }
        const body = (await res.json()) as { state: OnboardingState };
        setState(body.state);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("daemon unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agentos/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        state?: OnboardingState;
        error?: { message: string };
      };
      if (!res.ok) {
        setError(json.error?.message ?? `status ${res.status}`);
        return;
      }
      if (json.state) setState(json.state);
      else setTick((t) => t + 1);
    } catch {
      setError("request failed");
    } finally {
      setBusy(false);
    }
  };

  const connectApiKey = async (provider: string) => {
    const apiKey = window.prompt(`API key for ${provider}`);
    if (apiKey === null || apiKey.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agentos/connections/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (!res.ok) {
        setError(`api-key connect ${res.status}`);
        return;
      }
      await act({ action: "verify-auth", provider });
    } catch {
      setError("api-key connect failed");
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async (provider: string) => {
    setBusy(true);
    setError(null);
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
    } catch {
      setError("oauth/start failed");
    } finally {
      setBusy(false);
    }
  };

  const verifySelectedAuth = async () => {
    if (state === null) return;
    const selected = state.providers.filter((p) => p.selected);
    if (selected.length === 0) {
      setError("select at least one provider before verifying auth");
      return;
    }
    for (const row of selected) {
      await act({ action: "verify-auth", provider: row.provider });
    }
  };

  const selectedProviders =
    state?.providers.filter((p) => p.selected) ??
    ([] as OnboardingState["providers"]);

  return (
    <div className="flex min-h-full flex-col">
      <Topbar title="Onboarding Guide" />
      <div className="flex flex-1 flex-col gap-6 p-8">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-fg-3">
            First run · resumable
          </p>
          <h1 className="mt-1 text-[28px] font-semibold text-fg-1">Set up Agent OS</h1>
          <p className="mt-2 max-w-xl text-[14px] text-fg-2">
            Live verification after every step — no trust-me checkboxes. Pi is the only
            harness; connections and quota probes follow detection.
          </p>
        </div>

        {error !== null && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        {state === null ? (
          <p className="text-fg-3">Loading…</p>
        ) : (
          <>
            <StepRail step={state.step} />

            {state.step === "doctor" || state.doctor.length > 0 ? (
              <section className="rounded-[12px] border border-line-2 bg-panel-1 p-5">
                <h2 className="text-[16px] font-semibold text-fg-1">Step 0 · Environment doctor</h2>
                <ul className="mt-4 flex flex-col gap-2">
                  {state.doctor.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-start justify-between rounded-lg border border-line-2 bg-shell px-3 py-2"
                    >
                      <div>
                        <p className="text-[13px] font-semibold text-fg-1">
                          {d.ok ? "✓" : "○"} {d.id}
                          {d.version ? ` · ${d.version}` : ""}
                        </p>
                        <p className="text-[12px] text-fg-3">{d.detail}</p>
                        {!d.ok && d.installHint !== null && (
                          <code className="mt-1 block rounded bg-panel-2 px-2 py-1 text-[11px] text-teal-brand">
                            {d.installHint}
                          </code>
                        )}
                      </div>
                      {d.required !== null && (
                        <span className="text-[11px] text-fg-3">need {d.required}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "refresh-doctor" })}
                  className="mt-4 rounded-lg bg-teal-brand px-4 py-2 text-[13px] font-semibold text-black"
                >
                  Re-probe environment
                </button>
              </section>
            ) : null}

            <section className="rounded-[12px] border border-line-2 bg-panel-1 p-5">
              <h2 className="text-[16px] font-semibold text-fg-1">
                Step 1 · Provider checklist
              </h2>
              <p className="mt-1 text-[13px] text-fg-3">
                Already present in Pi show ⟨DETECTED⟩ and are pre-selected.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(
                  [
                    "anthropic",
                    "openai",
                    "xai",
                    "openrouter",
                    "kimi-coding",
                    "vercel-ai-gateway",
                  ] as const
                ).map((provider) => {
                  const row = state.providers.find((p) => p.provider === provider);
                  const selected = row?.selected ?? false;
                  return (
                    <button
                      key={provider}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const current = new Set(
                          state.providers.filter((p) => p.selected).map((p) => p.provider),
                        );
                        if (current.has(provider)) current.delete(provider);
                        else current.add(provider);
                        void act({ action: "set-providers", providers: [...current] });
                      }}
                      className={cn(
                        "rounded-[20px] border px-3 py-1.5 text-[12px] font-medium",
                        selected
                          ? "border-teal-brand/40 bg-teal-brand/15 text-teal-brand"
                          : "border-line-2 bg-shell text-fg-2",
                      )}
                    >
                      {provider}
                      {row?.detected === true ? " ⟨DETECTED⟩" : ""}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-[12px] border border-line-2 bg-panel-1 p-5">
              <h2 className="text-[16px] font-semibold text-fg-1">
                Step 2 · Auth verification
              </h2>
              <p className="mt-1 text-[13px] text-fg-3">
                Connect OAuth or paste an API key, then re-check presence in the auth store.
              </p>
              {selectedProviders.length === 0 ? (
                <p className="mt-3 text-[13px] text-fg-3">
                  Select providers above, then verify auth here.
                </p>
              ) : (
                <ul className="mt-4 flex flex-col gap-2">
                  {selectedProviders.map((row) => (
                    <li
                      key={row.provider}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-2 bg-shell px-3 py-2"
                    >
                      <div>
                        <p className="text-[13px] font-semibold text-fg-1">
                          {row.authVerified ? "✓" : "○"} {row.provider}
                          {row.detected ? " ⟨DETECTED⟩" : ""}
                        </p>
                        <p className="text-[12px] text-fg-3">
                          {row.authVerified
                            ? "credential present / verified"
                            : "not verified — connect or re-check"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {OAUTH_PROVIDERS.has(row.provider) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void startOAuth(row.provider)}
                            className="rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1.5 text-[11px] font-medium text-fg-2"
                          >
                            OAuth /login
                          </button>
                        )}
                        {API_KEY_PROVIDERS.has(row.provider) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void connectApiKey(row.provider)}
                            className="rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1.5 text-[11px] font-medium text-fg-2"
                          >
                            API key
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "verify-auth",
                              provider: row.provider as PiProviderId,
                            })
                          }
                          className="rounded-lg border border-teal-brand/40 bg-teal-brand/15 px-2.5 py-1.5 text-[11px] font-semibold text-teal-brand"
                        >
                          Verify
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {oauthAttach !== null && (
                <div className="mt-3 rounded-lg border border-teal-brand/30 bg-teal-brand/10 px-3 py-2">
                  <p className="mb-1 text-[12px] font-semibold text-fg-1">
                    OAuth login ready for {oauthAttach.provider}
                  </p>
                  <code className="block break-all text-[11px] text-teal-brand">
                    {oauthAttach.attachCommand}
                  </code>
                  <p className="mt-1 text-[11px] text-fg-3">
                    Run the command, finish login, then Verify.
                  </p>
                </div>
              )}
              <button
                type="button"
                disabled={busy || selectedProviders.length === 0}
                onClick={() => void verifySelectedAuth()}
                className="mt-4 rounded-lg bg-teal-brand px-4 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
              >
                Verify all selected
              </button>
            </section>

            <section className="rounded-[12px] border border-line-2 bg-panel-1 p-5">
              <h2 className="text-[16px] font-semibold text-fg-1">
                Step 2a · Claude billing branch
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {(
                  [
                    ["subscription-sdk", "Subscription (SDK credit pool)"],
                    ["extra-usage-oauth", "Extra-usage OAuth ⚠"],
                    ["api-key", "API key"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "set-claude-billing", claudeBillingMode: mode })
                    }
                    className="rounded-lg border border-line-2 bg-shell px-3 py-2 text-[12px] text-fg-1"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "verify-claude-sdk" })}
                className="mt-3 rounded-lg border border-line-2 bg-panel-2 px-3 py-2 text-[12px] font-medium text-fg-2"
              >
                Verify Claude SDK path
              </button>
              {state.providers.find((p) => p.provider === "anthropic")?.claudeSdk && (
                <pre className="mt-3 overflow-auto rounded-lg bg-shell p-3 text-[11px] text-fg-3">
                  {JSON.stringify(
                    state.providers.find((p) => p.provider === "anthropic")?.claudeSdk,
                    null,
                    2,
                  )}
                </pre>
              )}
            </section>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "enable-probes" })}
                className="rounded-lg border border-line-2 bg-panel-2 px-4 py-2 text-[13px] font-medium text-fg-2"
              >
                Enable probes for detected
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "complete" })}
                className="rounded-lg bg-teal-brand px-4 py-2 text-[13px] font-semibold text-black"
              >
                Complete onboarding
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "restart" })}
                className="rounded-lg border border-line-2 px-4 py-2 text-[13px] text-fg-3"
              >
                Start over
              </button>
            </div>

            {state.completedAt !== null && (
              <p className="text-[13px] text-ok">
                Completed at {state.completedAt} — resume-safe state on disk.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepRail({ step }: { step: string }) {
  const steps = ["doctor", "providers", "auth", "claude-billing", "probes", "complete"];
  return (
    <ol className="flex flex-wrap gap-2">
      {steps.map((s) => (
        <li
          key={s}
          className={cn(
            "rounded-[20px] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide",
            s === step ? "bg-teal-brand text-black" : "bg-panel-2 text-fg-3",
          )}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}
