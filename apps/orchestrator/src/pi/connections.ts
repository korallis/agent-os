import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import {
  providerConnectionSchema,
  type AuthStorePresence,
  type BillingSurface,
  type ClaudeBillingMode,
  type ModelFamily,
  type OrchestratorEvent,
  type PiProviderId,
  type ProviderConnection,
  type ConnectionKind,
} from "@agent-os/protocol";
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

  /**
   * Sync connections from Pi auth-store presence (detection-driven, §4.9 R5.1).
   * Only persists / emits when presence hash, health, or membership actually changes.
   */
  syncFromAuthStore(): ProviderConnection[] {
    const presence = listDetectedProviders(this.home);
    const now = new Date().toISOString();
    let dirty = false;

    for (const p of presence) {
      const existing = [...this.connections.values()].find((c) => c.provider === p.provider);
      if (existing !== undefined) {
        const nextHealth = p.present ? "healthy" : "unknown";
        if (
          presenceUnchanged(existing.authStorePresence, p) &&
          existing.health === nextHealth
        ) {
          continue;
        }
        const updated: ProviderConnection = {
          ...existing,
          authStorePresence: p,
          health: nextHealth,
          updatedAt: now,
        };
        this.connections.set(updated.id, updated);
        this.emitUpdated(updated);
        dirty = true;
      } else {
        const created = this.createConnection({
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
        dirty = true;
      }
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
    const meta = PROVIDER_META[input.provider] ?? {
      label: input.provider,
      family: "other" as const,
      defaultBilling: "api-metered" as const,
    };
    let billingSurface = meta.defaultBilling;
    if (input.billingMode === "subscription-sdk") billingSurface = "sdk-credit-pool";
    if (input.billingMode === "extra-usage-oauth") billingSurface = "extra-usage-per-token";
    if (input.billingMode === "api-key") billingSurface = "api-metered";

    const now = new Date().toISOString();
    const connection: ProviderConnection = {
      id: nextUlid(),
      kind: input.kind,
      provider: input.provider,
      label: input.label ?? meta.label,
      family: meta.family,
      billingSurface,
      billingMode: input.billingMode ?? null,
      health: "setup",
      healthReason: null,
      authStorePresence: null,
      effectiveCredentialPath: input.kind === "pi-api-key" ? "env-keychain" : "auth-json",
      personalUseOnly: true,
      supportedRoles: ["brain", "planner", "builder", "validator", "fusion", "scout", "healthcheck"],
      limitReached: false,
      limitReachedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.connections.set(connection.id, connection);
    this.persist();
    this.emitUpdated(connection);
    this.probeAutoEnable?.({
      provider: connection.provider,
      billingMode: connection.billingMode,
    });
    return connection;
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

/** API keys are stored under AGENTOS_HOME/secrets/<provider> as 0600 files for Phase 2 (keychain later). */
export function writeApiKeyFile(home: string, provider: string, apiKey: string): string {
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${provider}.key`);
  writeFileSync(path, apiKey, { mode: 0o600 });
  return path;
}

export function readApiKeyFile(home: string, provider: string): string | null {
  const path = join(home, "secrets", `${provider}.key`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
