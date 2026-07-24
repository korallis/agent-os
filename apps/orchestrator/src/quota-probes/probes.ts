import { monotonicFactory } from "ulid";
import type {
  HonestyTier,
  OrchestratorEvent,
  PiProviderId,
  ProviderConnection,
  QuotaConfig,
  QuotaMetric,
  QuotaSample,
} from "@agent-os/protocol";
import { PROBE_ALLOWLIST, assertTokenUrlAllowed } from "./allowlist.js";
import { readProbeToken } from "./token-reader.js";

const nextUlid = monotonicFactory();

export interface ProbeContext {
  connection: ProviderConnection;
  config: QuotaConfig;
  authJsonPath: string;
  /** AGENTOS_HOME — used to read secrets/<provider>.key for pi-api-key probes. */
  agentosHome?: string;
  /** Injectable clock for fake-clock countdown tests. */
  now?: () => Date;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  fixtureToken?: string;
}

function nowIso(ctx: ProbeContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString();
}

function metric(
  kind: QuotaMetric["kind"],
  value: number,
  unit: QuotaMetric["unit"],
  tier: HonestyTier,
  source: string,
  syncedAt: string,
  extra?: Partial<QuotaMetric>,
): QuotaMetric {
  return {
    kind,
    value,
    unit,
    tier,
    source,
    syncedAt,
    reason: extra?.reason ?? null,
    resetsAt: extra?.resetsAt ?? null,
    limitReached: extra?.limitReached ?? (unit === "percent" && value >= 100),
  };
}

/**
 * Run probes for one connection. Failures degrade metrics to estimate/stale
 * without invalidating the connection.
 */
export async function probeConnection(ctx: ProbeContext): Promise<{
  sample: QuotaSample;
  events: OrchestratorEvent[];
}> {
  const provider = ctx.connection.provider;
  const providerKey = mapProviderConfigKey(provider);
  const providerCfg =
    providerKey !== null ? ctx.config.providers[providerKey] : null;
  if (providerCfg === null || !providerCfg.enabled) {
    const sample = emptyEstimateSample(ctx, "probe disabled in quota.json5");
    return { sample, events: [updatedEvent(ctx, sample)] };
  }

  const endpoints = PROBE_ALLOWLIST.filter((e) => e.provider === mapAllowlistProvider(provider));
  if (endpoints.length === 0) {
    const sample = emptyEstimateSample(ctx, "no probe endpoint for provider");
    return { sample, events: [updatedEvent(ctx, sample)] };
  }

  const metrics: QuotaMetric[] = [];
  const syncedAt = nowIso(ctx);
  const fetchImpl = ctx.fetchImpl ?? fetch;

  for (const endpoint of endpoints) {
    if (endpoint.tier === "best-effort" && !providerCfg.bestEffortAllowed) {
      continue;
    }
    try {
      assertTokenUrlAllowed(endpoint.url);
      const token = readProbeToken({
        provider: mapAllowlistProvider(provider),
        authJsonPath: ctx.authJsonPath,
        url: endpoint.url,
        billingMode: ctx.connection.billingMode,
        connectionKind: ctx.connection.kind,
        secretsProvider: provider,
        ...(ctx.agentosHome !== undefined ? { agentosHome: ctx.agentosHome } : {}),
        ...(ctx.fixtureToken !== undefined ? { fixtureToken: ctx.fixtureToken } : {}),
      });
      if (token === null) {
        metrics.push(
          metric("weekly-window-pct", 0, "percent", "estimate", `${endpoint.sourceLabel} · NO TOKEN`, syncedAt, {
            reason: "no readable credential for probe",
            limitReached: false,
          }),
        );
        continue;
      }

      const response = await fetchImpl(endpoint.url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token.token}`,
          ...token.headers,
        },
      });

      if (!response.ok) {
        metrics.push(
          metric("weekly-window-pct", 0, "percent", "estimate", `${endpoint.sourceLabel} · HTTP ${response.status}`, syncedAt, {
            reason: `probe HTTP ${response.status}`,
            limitReached: false,
          }),
        );
        continue;
      }

      const body: unknown = await response.json();
      metrics.push(...parseProbeBody(provider, endpoint.tier, endpoint.sourceLabel, body, syncedAt, ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : "probe failed";
      // setup-token / OAuth limitation → estimate with visible reason (Phase 2 gate).
      const reason = message.includes("setup-token")
        ? "setup-token cannot read usage; need real OAuth login"
        : message;
      metrics.push(
        metric("weekly-window-pct", 0, "percent", "estimate", `${endpoint.sourceLabel} · ERROR`, syncedAt, {
          reason,
          limitReached: false,
        }),
      );
    }
  }

  if (metrics.length === 0) {
    metrics.push(
      metric("weekly-window-pct", 0, "percent", "estimate", "TELEMETRY", syncedAt, {
        reason: "no probe metrics produced",
        limitReached: false,
      }),
    );
  }

  const sample: QuotaSample = {
    id: nextUlid(),
    connectionId: ctx.connection.id,
    provider,
    metrics,
    sampledAt: syncedAt,
  };

  const events: OrchestratorEvent[] = [updatedEvent(ctx, sample)];
  for (const m of metrics) {
    if (m.limitReached) {
      events.push({
        type: "quota.threshold",
        payload: {
          connectionId: ctx.connection.id,
          provider,
          kind: m.kind,
          tier: m.tier,
          value: m.value,
          level: "limit-reached",
          reason: m.reason ?? "LIMIT REACHED",
        },
      });
    } else if (m.unit === "percent" && m.value >= ctx.config.thresholds.windowPctCritical) {
      events.push({
        type: "quota.threshold",
        payload: {
          connectionId: ctx.connection.id,
          provider,
          kind: m.kind,
          tier: m.tier,
          value: m.value,
          level: "critical",
          reason: `window ${m.value}% ≥ ${ctx.config.thresholds.windowPctCritical}%`,
        },
      });
    } else if (m.unit === "percent" && m.value >= ctx.config.thresholds.windowPctWarn) {
      events.push({
        type: "quota.threshold",
        payload: {
          connectionId: ctx.connection.id,
          provider,
          kind: m.kind,
          tier: m.tier,
          value: m.value,
          level: "warn",
          reason: `window ${m.value}% ≥ ${ctx.config.thresholds.windowPctWarn}%`,
        },
      });
    }
  }

  return { sample, events };
}

function updatedEvent(ctx: ProbeContext, sample: QuotaSample): OrchestratorEvent {
  return {
    type: "quota.updated",
    payload: {
      connectionId: sample.connectionId,
      provider: sample.provider,
      metrics: sample.metrics,
      sampleId: sample.id,
    },
  };
}

function emptyEstimateSample(ctx: ProbeContext, reason: string): QuotaSample {
  const syncedAt = nowIso(ctx);
  return {
    id: nextUlid(),
    connectionId: ctx.connection.id,
    provider: ctx.connection.provider,
    metrics: [
      metric("weekly-window-pct", 0, "percent", "estimate", "ESTIMATE", syncedAt, {
        reason,
        limitReached: false,
      }),
    ],
    sampledAt: syncedAt,
  };
}

function mapAllowlistProvider(provider: PiProviderId): string {
  if (provider === "claude-agent-sdk") return "anthropic";
  if (provider === "kimi-coding") return "kimi-coding";
  return provider;
}

function mapProviderConfigKey(
  provider: PiProviderId,
): keyof QuotaConfig["providers"] | null {
  switch (provider) {
    case "anthropic":
    case "claude-agent-sdk":
      return provider === "claude-agent-sdk" ? "claude-agent-sdk" : "anthropic";
    case "openai":
      return "openai";
    case "xai":
      return "xai";
    case "openrouter":
      return "openrouter";
    case "kimi-coding":
      return "kimi-coding";
    case "vercel-ai-gateway":
      return "vercel-ai-gateway";
    default:
      return null;
  }
}

/** Whether quota.json5 enables live probes for this provider. */
export function isProbeEnabled(provider: PiProviderId, config: QuotaConfig): boolean {
  const key = mapProviderConfigKey(provider);
  if (key === null) return false;
  return config.providers[key].enabled;
}

function parseProbeBody(
  provider: PiProviderId,
  tier: HonestyTier,
  sourceLabel: string,
  body: unknown,
  syncedAt: string,
  ctx: ProbeContext,
): QuotaMetric[] {
  const metrics: QuotaMetric[] = [];
  if (typeof body !== "object" || body === null) {
    return [
      metric("weekly-window-pct", 0, "percent", "estimate", `${sourceLabel} · PARSE`, syncedAt, {
        reason: "unparseable probe body",
        limitReached: false,
      }),
    ];
  }
  const b = body as Record<string, unknown>;

  // Claude oauth/usage style
  if (provider === "anthropic" || provider === "claude-agent-sdk") {
    const fiveHour = num(b["five_hour"] ?? b["fiveHour"] ?? b["session_utilization"]);
    const weekly = num(b["seven_day"] ?? b["weekly"] ?? b["weekly_utilization"] ?? b["utilization"]);
    const extra = num(b["extra_usage"] ?? b["extraUsage"] ?? b["extra_usage_spend_usd"]);
    if (fiveHour !== null) {
      metrics.push(
        metric("session-window-pct", fiveHour, "percent", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: fiveHour >= 100,
          resetsAt: str(b["five_hour_resets_at"] ?? b["session_resets_at"]),
        }),
      );
    }
    if (weekly !== null) {
      metrics.push(
        metric("weekly-window-pct", weekly, "percent", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: weekly >= 100,
          resetsAt: str(b["seven_day_resets_at"] ?? b["weekly_resets_at"]),
        }),
      );
    }
    if (extra !== null) {
      metrics.push(
        metric("extra-usage-spend", extra, "usd", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: false,
        }),
      );
    }
    // R6-Q2: SDK pool may be absent — surface estimate reason when missing.
    if (provider === "claude-agent-sdk" || ctx.connection.billingMode === "subscription-sdk") {
      const sdkPool = num(b["sdk_credit_pool"] ?? b["sdkCreditPool"] ?? b["agent_sdk_credits"]);
      if (sdkPool !== null) {
        metrics.push(
          metric("sdk-credit-pool", sdkPool, "credits", tier, `${sourceLabel} · SYNCED`, syncedAt, {
            limitReached: false,
          }),
        );
      } else {
        metrics.push(
          metric("sdk-credit-pool", 0, "credits", "estimate", `${sourceLabel} · ESTIMATE`, syncedAt, {
            reason: "SDK monthly credit pool not exposed by usage endpoint (R6-Q2)",
            limitReached: false,
          }),
        );
      }
    }
  }

  // OpenRouter credits — API wraps fields under top-level `data`.
  if (provider === "openrouter") {
    const data =
      typeof b["data"] === "object" && b["data"] !== null && !Array.isArray(b["data"])
        ? (b["data"] as Record<string, unknown>)
        : b;
    const totalCredits = num(
      data["total_credits"] ?? data["totalCredits"] ?? b["total_credits"] ?? b["totalCredits"],
    );
    const totalUsage = num(
      data["total_usage"] ?? data["totalUsage"] ?? b["total_usage"] ?? b["totalUsage"],
    );
    const limitRemaining = num(
      data["limit_remaining"] ??
        data["limitRemaining"] ??
        b["limit_remaining"] ??
        b["limitRemaining"],
    );
    if (totalCredits !== null && totalUsage !== null) {
      metrics.push(
        metric("account-credits", totalCredits - totalUsage, "credits", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: totalCredits - totalUsage <= 0,
        }),
      );
    }
    if (limitRemaining !== null) {
      metrics.push(
        metric("key-limit-remaining", limitRemaining, "credits", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: limitRemaining <= 0,
          resetsAt: str(
            data["limit_reset"] ?? data["limitReset"] ?? b["limit_reset"] ?? b["limitReset"],
          ),
        }),
      );
    }
  }

  // Moonshot / Kimi balance — API wraps fields under top-level `data`.
  if (provider === "kimi-coding") {
    const data =
      typeof b["data"] === "object" && b["data"] !== null && !Array.isArray(b["data"])
        ? (b["data"] as Record<string, unknown>)
        : b;
    const balance = num(
      data["balance"] ??
        data["available_balance"] ??
        b["balance"] ??
        b["available_balance"],
    );
    const voucher = num(
      data["voucher"] ?? data["voucher_balance"] ?? b["voucher"] ?? b["voucher_balance"],
    );
    const cash = num(data["cash"] ?? data["cash_balance"] ?? b["cash"] ?? b["cash_balance"]);
    if (balance !== null) {
      metrics.push(
        metric("balance", balance, "usd", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: balance <= 0,
        }),
      );
    }
    if (voucher !== null) {
      metrics.push(metric("voucher-balance", voucher, "usd", tier, `${sourceLabel} · SYNCED`, syncedAt));
    }
    if (cash !== null) {
      metrics.push(metric("cash-balance", cash, "usd", tier, `${sourceLabel} · SYNCED`, syncedAt));
    }
  }

  // Codex / generic utilization
  if (provider === "openai") {
    const used = num(b["used_percent"] ?? b["plan_used_percent"] ?? b["utilization"]);
    if (used !== null) {
      metrics.push(
        metric("plan-window-pct", used, "percent", tier, `${sourceLabel} · SYNCED`, syncedAt, {
          limitReached: used >= 100,
          resetsAt: str(b["resets_at"] ?? b["reset_time"]),
        }),
      );
    }
  }

  if (metrics.length === 0) {
    metrics.push(
      metric("weekly-window-pct", 0, "percent", "estimate", `${sourceLabel} · PARSE`, syncedAt, {
        reason: "recognized provider but no known fields",
        limitReached: false,
      }),
    );
  }
  return metrics;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Fake-clock helper: format RESETS IN Xd/Yh from resetsAt. */
export function formatResetsIn(resetsAt: string, now: Date): string {
  const target = new Date(resetsAt).getTime();
  const ms = target - now.getTime();
  if (ms <= 0) return "RESETS SOON";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  if (days > 0) return `RESETS IN ${days}D/${remH}H`;
  return `RESETS IN ${hours}H`;
}

/**
 * LIMIT REACHED exclusion for resolve_cast (Phase 2 gate).
 */
export function isLimitReached(sample: QuotaSample | null): { reached: boolean; reason: string | null } {
  if (sample === null) return { reached: false, reason: null };
  for (const m of sample.metrics) {
    if (m.limitReached) {
      return { reached: true, reason: m.reason ?? `${m.kind} at limit` };
    }
  }
  return { reached: false, reason: null };
}
