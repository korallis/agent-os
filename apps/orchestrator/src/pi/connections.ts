import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import {
  providerConnectionSchema,
  type AuthStorePresence,
  type BillingSurface,
  type ClaudeBillingMode,
  type EffectiveCredentialPath,
  type ModelFamily,
  type OrchestratorEvent,
  type PiProviderId,
  type ProviderConnection,
  type ConnectionKind,
} from "@agent-os/protocol";
import { hasReadableClaudeCodeCredential } from "../security/claude-code-credentials.js";
import type { ProviderKeyEnvName } from "../security/env-scrub.js";
import { listDetectedProviders } from "./manager.js";

const nextUlid = monotonicFactory();

const PROVIDER_META: Record<
  string,
  { label: string; family: ModelFamily; defaultBilling: BillingSurface }
> = {
  anthropic: { label: "Anthropic / Claude", family: "anthropic", defaultBilling: "extra-usage-per-token" },
  "claude-agent-sdk": { label: "Claude Agent SDK", family: "anthropic", defaultBilling: "sdk-credit-pool" },
  openai: { label: "OpenAI / Codex", family: "openai", defaultBilling: "plan-quota" },
  xai: { label: "xAI / Grok", family: "xai", defaultBilling: "plan-quota" },
  openrouter: { label: "OpenRouter", family: "other", defaultBilling: "api-metered" },
  "github-copilot": { label: "GitHub Copilot", family: "openai", defaultBilling: "plan-quota" },
  "kimi-coding": { label: "Kimi / Moonshot", family: "moonshot", defaultBilling: "api-metered" },
  "vercel-ai-gateway": { label: "Vercel AI Gateway", family: "other", defaultBilling: "api-metered" },
  google: { label: "Google", family: "google", defaultBilling: "api-metered" },
};

export type ProbeAutoEnableHandler = (input: {
  provider: PiProviderId;
  billingMode: ClaudeBillingMode | null;
}) => void;

export class ConnectionRegistry {
  private connections = new Map<string, ProviderConnection>();
  private sink: (event: OrchestratorEvent) => void = () => undefined;
  private probeAutoEnable: ProbeAutoEnableHandler | null = null;

  constructor(private readonly home: string) {
    this.load();
  }

  onEvent(sink: (event: OrchestratorEvent) => void): void {
    this.sink = sink;
  }

  /**
   * R5.1: when a connection is created or newly detected, flip matching
   * quota probes on (still individually toggleable afterward).
   */
  onProbeAutoEnable(handler: ProbeAutoEnableHandler): void {
    this.probeAutoEnable = handler;
  }

  private storePath(): string {
    return join(this.home, "connections.json");
  }

  private load(): void {
    const path = this.storePath();
    if (!existsSync(path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const parsed = providerConnectionSchema.safeParse(item);
        if (parsed.success) this.connections.set(parsed.data.id, parsed.data);
      }
    } catch {
      // ignore corrupt store; re-sync from detection
    }
  }

  private persist(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.storePath(),
      JSON.stringify([...this.connections.values()], null, 2),
      { mode: 0o600 },
    );
  }

  list(): ProviderConnection[] {
    return [...this.connections.values()];
  }

  get(id: string): ProviderConnection | null {
    return this.connections.get(id) ?? null;
  }

  findByProviderKind(provider: PiProviderId, kind: ConnectionKind): ProviderConnection | null {
    return (
      [...this.connections.values()].find((c) => c.provider === provider && c.kind === kind) ?? null
    );
  }

  /**
   * Sync connections from Pi auth-store presence (detection-driven, §4.9 R5.1).
   * Only persists / emits when presence hash, health, or membership actually changes.
   * subscription-sdk cards use Claude Code credential extractability for health,
   * not Pi auth.json presence.
   */
  syncFromAuthStore(): ProviderConnection[] {
    const presence = listDetectedProviders(this.home);
    const now = new Date().toISOString();
    let dirty = false;
    const presentProviders = new Set(presence.map((p) => p.provider));
    const claudeCodeOk = hasReadableClaudeCodeCredential();

    for (const p of presence) {
      // Auth-store presence only drives pi-oauth cards; never attach to pi-api-key.
      const existing = [...this.connections.values()].find(
        (c) => c.provider === p.provider && c.kind === "pi-oauth",
      );
      if (existing !== undefined) {
        const subscriptionSdk = existing.billingMode === "subscription-sdk";
        const nextHealth = subscriptionSdk
          ? claudeCodeOk
            ? "healthy"
            : "setup"
          : p.present
            ? "healthy"
            : "unknown";
        const nextPath = resolveCredentialPath(existing.kind, existing.billingMode);
        if (
          presenceUnchanged(existing.authStorePresence, p) &&
          existing.health === nextHealth &&
          existing.effectiveCredentialPath === nextPath
        ) {
          continue;
        }
        const updated: ProviderConnection = {
          ...existing,
          authStorePresence: p,
          health: nextHealth,
          effectiveCredentialPath: nextPath,
          updatedAt: now,
        };
        this.connections.set(updated.id, updated);
        this.emitUpdated(updated);
        dirty = true;
      } else {
        // Build once with presence/health so first detection does not double-emit.
        const created = this.buildConnection({
          provider: p.provider,
          kind: "pi-oauth",
          billingMode: p.provider === "anthropic" ? "extra-usage-oauth" : null,
        });
        const withPresence: ProviderConnection = {
          ...created,
          authStorePresence: p,
          health: "healthy",
          updatedAt: now,
        };
        this.connections.set(withPresence.id, withPresence);
        this.emitUpdated(withPresence);
        this.probeAutoEnable?.({
          provider: withPresence.provider,
          billingMode: withPresence.billingMode,
        });
        dirty = true;
      }
    }

    // subscription-sdk cards not covered above (e.g. no Pi auth entry): refresh health/path.
    for (const existing of this.connections.values()) {
      if (existing.billingMode !== "subscription-sdk") continue;
      const nextHealth = claudeCodeOk ? "healthy" : "setup";
      const nextPath = resolveCredentialPath(existing.kind, existing.billingMode);
      if (existing.health === nextHealth && existing.effectiveCredentialPath === nextPath) {
        continue;
      }
      const updated: ProviderConnection = {
        ...existing,
        health: nextHealth,
        effectiveCredentialPath: nextPath,
        updatedAt: now,
      };
      this.connections.set(updated.id, updated);
      this.emitUpdated(updated);
      dirty = true;
    }

    // Reflect logout / credential removal: providers no longer in the auth store.
    for (const existing of this.connections.values()) {
      if (presentProviders.has(existing.provider)) continue;
      // API-key connections are not driven by auth-store presence.
      if (existing.kind === "pi-api-key") continue;
      // subscription-sdk health is driven by Claude Code credentials above.
      if (existing.billingMode === "subscription-sdk") continue;
      if (
        existing.authStorePresence === null &&
        (existing.health === "unknown" || existing.health === "setup")
      ) {
        continue;
      }
      const cleared: ProviderConnection = {
        ...existing,
        authStorePresence: null,
        health: "unknown",
        updatedAt: now,
      };
      this.connections.set(cleared.id, cleared);
      this.emitUpdated(cleared);
      dirty = true;
    }

    if (dirty) this.persist();
    return this.list();
  }

  createConnection(input: {
    provider: PiProviderId;
    kind: ConnectionKind;
    billingMode?: ClaudeBillingMode | null;
    label?: string;
  }): ProviderConnection {
    const connection = this.buildConnection(input);
    this.connections.set(connection.id, connection);
    this.persist();
    this.emitUpdated(connection);
    this.probeAutoEnable?.({
      provider: connection.provider,
      billingMode: connection.billingMode,
    });
    return connection;
  }

  /**
   * Update-or-create by provider+kind so repeated Connect/login does not
   * accumulate duplicate connection cards.
   */
  upsertConnection(input: {
    provider: PiProviderId;
    kind: ConnectionKind;
    billingMode?: ClaudeBillingMode | null;
    label?: string;
  }): ProviderConnection {
    const existing = this.findByProviderKind(input.provider, input.kind);
    if (existing === null) {
      return this.createConnection(input);
    }

    const meta = PROVIDER_META[input.provider] ?? {
      label: input.provider,
      family: "other" as const,
      defaultBilling: "api-metered" as const,
    };
    let billingSurface = meta.defaultBilling;
    const billingMode = input.billingMode ?? existing.billingMode;
    if (billingMode === "subscription-sdk") billingSurface = "sdk-credit-pool";
    if (billingMode === "extra-usage-oauth") billingSurface = "extra-usage-per-token";
    if (billingMode === "api-key") billingSurface = "api-metered";

    const nextPath = resolveCredentialPath(input.kind, billingMode);
    let nextHealth = existing.health;
    if (billingMode === "subscription-sdk") {
      nextHealth = hasReadableClaudeCodeCredential() ? "healthy" : "setup";
    }

    const updated: ProviderConnection = {
      ...existing,
      label: input.label ?? existing.label,
      billingSurface,
      billingMode,
      health: nextHealth,
      effectiveCredentialPath: nextPath,
      updatedAt: new Date().toISOString(),
    };
    this.update(updated);
    return updated;
  }

  update(connection: ProviderConnection): void {
    this.connections.set(connection.id, connection);
    this.persist();
    this.emitUpdated(connection);
  }

  setLimitReached(id: string, reached: boolean, reason: string | null): void {
    const existing = this.connections.get(id);
    if (existing === undefined) return;
    if (existing.limitReached === reached && existing.limitReachedReason === reason) {
      return;
    }
    const updated: ProviderConnection = {
      ...existing,
      limitReached: reached,
      limitReachedReason: reason,
      updatedAt: new Date().toISOString(),
    };
    this.update(updated);
  }

  private buildConnection(input: {
    provider: PiProviderId;
    kind: ConnectionKind;
    billingMode?: ClaudeBillingMode | null;
    label?: string;
  }): ProviderConnection {
    const meta = PROVIDER_META[input.provider] ?? {
      label: input.provider,
      family: "other" as const,
      defaultBilling: "api-metered" as const,
    };
    let billingSurface = meta.defaultBilling;
    if (input.billingMode === "subscription-sdk") billingSurface = "sdk-credit-pool";
    if (input.billingMode === "extra-usage-oauth") billingSurface = "extra-usage-per-token";
    if (input.billingMode === "api-key") billingSurface = "api-metered";

    const billingMode = input.billingMode ?? null;
    const now = new Date().toISOString();
    const health =
      billingMode === "subscription-sdk"
        ? hasReadableClaudeCodeCredential()
          ? "healthy"
          : "setup"
        : "setup";
    return {
      id: nextUlid(),
      kind: input.kind,
      provider: input.provider,
      label: input.label ?? meta.label,
      family: meta.family,
      billingSurface,
      billingMode,
      health,
      healthReason: null,
      authStorePresence: null,
      effectiveCredentialPath: resolveCredentialPath(input.kind, billingMode),
      personalUseOnly: true,
      supportedRoles: ["brain", "planner", "builder", "validator", "fusion", "scout", "healthcheck"],
      limitReached: false,
      limitReachedReason: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private emitUpdated(connection: ProviderConnection): void {
    this.sink({
      type: "provider.connection_updated",
      payload: {
        connectionId: connection.id,
        provider: connection.provider,
        kind: connection.kind,
        health: connection.health,
        billingSurface: connection.billingSurface,
        billingMode: connection.billingMode,
        family: connection.family,
        limitReached: connection.limitReached,
      },
    });
  }
}

function presenceUnchanged(
  existing: AuthStorePresence | null,
  next: AuthStorePresence,
): boolean {
  if (existing === null) return false;
  return (
    existing.provider === next.provider &&
    existing.present === next.present &&
    existing.presenceHash === next.presenceHash &&
    existing.mtime === next.mtime &&
    existing.expiresAt === next.expiresAt
  );
}

function resolveCredentialPath(
  kind: ConnectionKind,
  billingMode: ClaudeBillingMode | null | undefined,
): EffectiveCredentialPath {
  if (billingMode === "subscription-sdk") return "claude-code-oauth";
  if (kind === "pi-api-key") return "env-keychain";
  return "auth-json";
}

/**
 * Home whose `secrets/` tree holds API keys. Secondmates set
 * AGENTOS_SECRETS_HOME to the primary home so grants read keys without
 * copying auth material into the audited secondmate home.
 */
export function resolveSecretsHome(agentosHome: string): string {
  const override = process.env.AGENTOS_SECRETS_HOME;
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  return agentosHome;
}

/** API keys are stored under secretsHome/secrets/<provider> as 0600 files for Phase 2 (keychain later). */
export function writeApiKeyFile(home: string, provider: string, apiKey: string): string {
  const secretsHome = resolveSecretsHome(home);
  const dir = join(secretsHome, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${provider}.key`);
  writeFileSync(path, apiKey, { mode: 0o600 });
  return path;
}

export function readApiKeyFile(home: string, provider: string): string | null {
  const secretsHome = resolveSecretsHome(home);
  const path = join(secretsHome, "secrets", `${provider}.key`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Map Pi provider id (model prefix) to the env name Pi expects for API-key auth. */
const PROVIDER_KEY_ENV_BY_ID: Partial<Record<PiProviderId | string, ProviderKeyEnvName>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  google: "GOOGLE_API_KEY",
  "vercel-ai-gateway": "VERCEL_AI_GATEWAY_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
};

export type ProviderKeyGrant = { name: ProviderKeyEnvName; value: string };

/**
 * Resolve at most one cast-matching provider API key for a Pi spawn grant.
 * Only pi-api-key connections yield a grant; OAuth uses PI_CONFIG_DIR / auth.json.
 * Keys are read from resolveSecretsHome(agentosHome) so a secondmate can receive
 * a grant from the primary secrets tree without writing material under its home.
 * Never logs the secret value; never puts it in manifests (envKeys only).
 */
export function resolveProviderKeyGrant(
  agentosHome: string,
  model: string,
  connections:
    | {
        list(): ReadonlyArray<{ provider: string; kind: ConnectionKind | string }>;
      }
    | undefined
    | null,
): ProviderKeyGrant | null {
  const slash = model.indexOf("/");
  const provider = (slash === -1 ? model : model.slice(0, slash)).trim();
  if (provider.length === 0) return null;

  const apiKeyConn = connections
    ?.list()
    .find((c) => c.provider === provider && c.kind === "pi-api-key");
  if (apiKeyConn === undefined) return null;

  const name = PROVIDER_KEY_ENV_BY_ID[provider];
  if (name === undefined) return null;

  const value = readApiKeyFile(agentosHome, provider);
  if (value === null || value.length === 0) return null;

  return { name, value };
}
