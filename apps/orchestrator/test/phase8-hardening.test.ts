import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrainConfig,
  BudgetsConfig,
  ProviderConnection,
  QuotaSample,
} from "@agent-os/protocol";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { AfkService } from "../src/fleet/afk.js";
import { decideHandoff } from "../src/fleet/brain-handoff.js";
import { FleetService } from "../src/fleet/service.js";
import type { ConnectionRegistry } from "../src/pi/connections.js";
import { familyFromModel } from "../src/substrate/family.js";
import { SelfUpdater, type ReleaseManifest } from "../src/update/self-update.js";

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("/afk autonomy posture", () => {
  const faq = [
    {
      match: ["bump", "zod"],
      answer: "Yes — patch and minor bumps are pre-approved.",
      rationale: "Captain pre-approved dependency patch/minor bumps",
    },
  ];

  it("answers only what the Captain pre-decided", () => {
    const afk = new AfkService(temp("agentos-p8-afk-"));
    afk.arm({ faq });

    const matched = afk.tryAnswer("OK to bump zod 4.1 to 4.2?");
    expect(matched?.answer).toContain("pre-approved");
    expect(matched?.rationale).toContain("Captain pre-approved");

    // The critical property: anything not pre-decided is NOT auto-answered.
    expect(afk.tryAnswer("Should I delete the production database?")).toBeNull();
  });

  it("does nothing at all while disarmed", () => {
    const afk = new AfkService(temp("agentos-p8-afk-off-"));
    afk.arm({ faq });
    afk.disarm();
    expect(afk.tryAnswer("OK to bump zod 4.1 to 4.2?")).toBeNull();
  });

  it("treats an expired posture as off", () => {
    const afk = new AfkService(temp("agentos-p8-afk-exp-"));
    afk.arm({ faq, untilIso: new Date(Date.now() - 1000).toISOString() });
    expect(afk.isActive()).toBe(false);
    expect(afk.tryAnswer("OK to bump zod 4.1 to 4.2?")).toBeNull();
  });

  it("counts answered and escalated separately", () => {
    const afk = new AfkService(temp("agentos-p8-afk-count-"));
    afk.arm({ faq });
    afk.tryAnswer("bump zod please");
    afk.tryAnswer("something entirely unrelated");
    const state = afk.state();
    expect(state.answered).toBe(1);
    expect(state.escalated).toBe(1);
  });
});

describe("Brain budget handoff", () => {
  const config: BrainConfig = {
    cast: "auto",
    thinking: "high",
    preferenceOrder: ["anthropic via claude-oauth"],
    handoff: { thresholdPct: 80, target: "same-family-api-key" },
    respawnBlocked: false,
  };
  const budgets: BudgetsConfig = {
    perTaskUsd: 5,
    claudeExtraUsageDailyUsd: 10,
    brainTokensPerDay: 1_000_000,
    gatewayHardUsd: 25,
  };

  const sample = (pct: number, tier: "live" | "estimate" = "live"): QuotaSample => ({
    id: "01JQUOTA000000000000000000",
    connectionId: "01JCONN00000000000000000AA",
    provider: "anthropic",
    metrics: [
      {
        kind: "weekly-window-pct",
        value: pct,
        unit: "percent",
        tier,
        source: "OAUTH",
        syncedAt: new Date().toISOString(),
        reason: null,
        resetsAt: null,
        limitReached: pct >= 100,
      },
    ],
    sampledAt: new Date().toISOString(),
  });

  it("does not hand off below the threshold", () => {
    const decision = decideHandoff({
      brainModel: "anthropic/claude-fable-5",
      brainConnectionId: "01JCONN00000000000000000AA",
      config,
      budgets,
      samples: [sample(42)],
      candidates: ["anthropic/claude-sonnet-4-5"],
    });
    expect(decision.shouldHandoff).toBe(false);
    expect(decision.observedPct).toBe(42);
  });

  it("hands off at the threshold, preferring the same family", () => {
    const decision = decideHandoff({
      brainModel: "anthropic/claude-fable-5",
      brainConnectionId: "01JCONN00000000000000000AA",
      config,
      budgets,
      samples: [sample(80)],
      candidates: ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-4-5"],
    });
    expect(decision.shouldHandoff).toBe(true);
    expect(decision.toModel).toBe("anthropic/claude-sonnet-4-5");
    expect(decision.thresholdPct).toBe(80);
  });

  it("hands Anthropic OAuth Brain off to OpenRouter-qualified Sonnet", () => {
    // Default same-family refuge: openrouter/anthropic/… must not collapse to
    // the bare anthropic/… string the OAuth Brain already uses.
    expect(familyFromModel("openrouter/anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(familyFromModel("vercel-ai-gateway/anthropic/claude-sonnet-4-5")).toBe("anthropic");
    const decision = decideHandoff({
      brainModel: "anthropic/claude-sonnet-4-5",
      brainConnectionId: "01JCONN00000000000000000AA",
      config,
      budgets,
      samples: [sample(93)],
      candidates: ["openrouter/anthropic/claude-sonnet-4-5"],
    });
    expect(decision.shouldHandoff).toBe(true);
    expect(decision.toModel).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });

  it("suppresses a second handoff while cooldown is active", () => {
    const home = temp("agentos-p8-handoff-cd-");
    mkdirSync(join(home, "config"), { recursive: true });
    const configService = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    configService.installDefaults();

    const now = new Date().toISOString();
    const conn = (
      id: string,
      provider: ProviderConnection["provider"],
      family: ProviderConnection["family"],
    ): ProviderConnection => ({
      id,
      kind: "pi-api-key",
      provider,
      label: provider,
      family,
      billingSurface: "api-metered",
      billingMode: null,
      health: "healthy",
      healthReason: null,
      authStorePresence: null,
      effectiveCredentialPath: "env-keychain",
      personalUseOnly: true,
      supportedRoles: ["brain"],
      limitReached: false,
      limitReachedReason: null,
      createdAt: now,
      updatedAt: now,
    });

    const anthropicId = "01JCONN0000000000000000ANT";
    const openrouterId = "01JCONN0000000000000000ORR";
    const xaiId = "01JCONN0000000000000000XAI";
    const connections = [
      conn(anthropicId, "anthropic", "anthropic"),
      conn(openrouterId, "openrouter", "other"),
      conn(xaiId, "xai", "xai"),
    ];
    const registry = { list: () => connections } as ConnectionRegistry;

    const windowSample = (connectionId: string, provider: string, pct: number): QuotaSample => ({
      id: `01JQUOTA${connectionId.slice(-8)}0000000000`,
      connectionId,
      provider,
      metrics: [
        {
          kind: "weekly-window-pct",
          value: pct,
          unit: "percent",
          tier: "live",
          source: "OAUTH",
          syncedAt: now,
          reason: null,
          resetsAt: null,
          limitReached: false,
        },
      ],
      sampledAt: now,
    });

    // Both Anthropic and OpenRouter report over threshold so a thrash loop
    // would otherwise bounce the Brain every reconcile tick.
    const samples = [
      windowSample(anthropicId, "anthropic", 93),
      windowSample(openrouterId, "openrouter", 91),
      windowSample(xaiId, "xai", 10),
    ];

    const service = new FleetService({
      home,
      config: configService,
      connections: registry,
      quotaSamples: () => samples,
      fakeTmux: true,
      fakeBrain: true,
    });
    service.start();
    // Force the Brain onto Anthropic OAuth model string.
    service.brain.handoff("anthropic/claude-sonnet-4-5", "test setup");

    const first = service.evaluateBrainHandoff();
    expect(first?.shouldHandoff).toBe(true);
    expect(first?.toModel).toBe("openrouter/anthropic/claude-sonnet-4-5");
    expect(service.lastBrainHandoff()?.toModel).toBe("openrouter/anthropic/claude-sonnet-4-5");

    const second = service.evaluateBrainHandoff();
    expect(second?.shouldHandoff).toBe(false);
    expect(second?.reason).toContain("cooldown");
    expect(service.brain.getSnapshot().model).toBe("openrouter/anthropic/claude-sonnet-4-5");

    service.stop();
  });

  it("says so plainly when the threshold is crossed but nothing is available", () => {
    const decision = decideHandoff({
      brainModel: "anthropic/claude-fable-5",
      brainConnectionId: "01JCONN00000000000000000AA",
      config,
      budgets,
      samples: [sample(95)],
      candidates: [],
    });
    // Not a silent no-op: the reason must name the unmet condition.
    expect(decision.shouldHandoff).toBe(false);
    expect(decision.reason).toContain("no eligible handoff target");
  });

  it("records whether the deciding number was live or an estimate", () => {
    const decision = decideHandoff({
      brainModel: "anthropic/claude-fable-5",
      brainConnectionId: "01JCONN00000000000000000AA",
      config,
      budgets,
      samples: [sample(88, "estimate")],
      candidates: ["anthropic/claude-sonnet-4-5"],
    });
    expect(decision.shouldHandoff).toBe(true);
    expect(decision.basis).toBe("estimate");
  });
});

describe("signed self-update", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function sign(version: string, digestHex: string): string {
    // Ed25519 is a one-shot algorithm: null digest, sign the bytes directly.
    return signPayload(
      null,
      SelfUpdater.signedMessage(version, digestHex),
      privateKey,
    ).toString("base64");
  }

  function manifestFor(version: string, payload: Buffer): ReleaseManifest {
    const sha256 = SelfUpdater.digest(payload);
    return { version, sha256, signature: sign(version, sha256) };
  }

  it("refuses a release whose digest does not match its manifest", () => {
    const updater = new SelfUpdater(temp("agentos-p8-up-"), publicPem);
    const payload = Buffer.from("real release");
    const manifest = manifestFor("1.1.0", payload);

    const tampered = Buffer.from("swapped release");
    const outcome = updater.apply(manifest, tampered);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("DIGEST_MISMATCH");
  });

  it("refuses a release signed by the wrong key", () => {
    const other = generateKeyPairSync("ed25519");
    const updater = new SelfUpdater(
      temp("agentos-p8-up-wrong-"),
      other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const payload = Buffer.from("release");
    const outcome = updater.apply(manifestFor("1.2.0", payload), payload);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("SIGNATURE_INVALID");
  });

  it("refuses to update at all when no public key is compiled in", () => {
    const updater = new SelfUpdater(temp("agentos-p8-up-nokey-"), null);
    const payload = Buffer.from("release");
    const outcome = updater.apply(manifestFor("1.3.0", payload), payload);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NO_PUBLIC_KEY");
  });

  it("refuses a traversal version token even when the signature covers it", () => {
    const root = temp("agentos-p8-up-trav-");
    const updater = new SelfUpdater(root, publicPem);
    const payload = Buffer.from("evil payload");
    const version = "../../evil";
    const sha256 = SelfUpdater.digest(payload);
    // Sign as an attacker who also controls the signing step for this vector —
    // the path check must still refuse before any write escapes versions/.
    const outcome = updater.apply(
      { version, sha256, signature: sign(version, sha256) },
      payload,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("VERSION_UNSAFE");
    expect(updater.currentVersion()).toBeNull();
  });

  it("refuses a version-swapped manifest that keeps a valid payload digest", () => {
    const updater = new SelfUpdater(temp("agentos-p8-up-vswap-"), publicPem);
    const payload = Buffer.from("legit release");
    const sha256 = SelfUpdater.digest(payload);
    // Signature was made for version 1.0.0; attacker rewrites the label only.
    const outcome = updater.apply(
      { version: "9.9.9", sha256, signature: sign("1.0.0", sha256) },
      payload,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("SIGNATURE_INVALID");
  });

  it("applies a verified release and can roll back without the network", () => {
    const root = temp("agentos-p8-up-ok-");
    const updater = new SelfUpdater(root, publicPem);
    updater.seedCurrent("1.0.0", Buffer.from("v1"));

    const payload = Buffer.from("v2 release");
    const outcome = updater.apply(manifestFor("2.0.0", payload), payload);
    expect(outcome.ok).toBe(true);
    expect(updater.currentVersion()).toBe("2.0.0");
    expect(updater.previousVersion()).toBe("1.0.0");

    const rolled = updater.rollback();
    expect(rolled.ok).toBe(true);
    expect(updater.currentVersion()).toBe("1.0.0");
    // Bouncing back is possible without another download.
    expect(updater.previousVersion()).toBe("2.0.0");
  });

  it("fails loudly when asked to roll back with nothing retained", () => {
    const updater = new SelfUpdater(temp("agentos-p8-up-noroll-"), publicPem);
    const rolled = updater.rollback();
    expect(rolled.ok).toBe(false);
    expect(rolled.reason).toContain("no retained previous version");
  });
});

describe("analytics breakdowns reconcile with the totals", () => {
  const spawnedAt = new Date().toISOString();

  function usageEvent(sessionId: string, provider: string, input: number, output: number) {
    return {
      id: `01JEVT${sessionId}${input}`,
      seq: 1,
      ts: spawnedAt,
      event: {
        type: "ext.usage" as const,
        payload: {
          sessionId,
          provider,
          model: "m1",
          inputTokens: input,
          outputTokens: output,
          costUsd: null,
          requestId: null,
        },
      },
    };
  }

  it("splits by billing surface and Brain lane without losing a single token", async () => {
    const { AnalyticsService } = await import("../src/analytics/service.js");
    const service = new AnalyticsService(
      () => ({
        events: [
          usageEvent("SBRAIN", "anthropic", 100, 50),
          usageEvent("SCREW1", "anthropic", 200, 30),
          usageEvent("SCREW2", "openai", 40, 10),
        ] as never,
        truncated: false,
      }),
      () => [],
      () => ({
        facts: [
          { sessionId: "SBRAIN", role: "brain", model: "anthropic/x", taskId: null },
          { sessionId: "SCREW1", role: "builder", model: "anthropic/x", taskId: "t1" },
          { sessionId: "SCREW2", role: "validator", model: "openai/y", taskId: "t1" },
        ],
        truncated: false,
      }),
      () => [
        { provider: "anthropic", billingSurface: "plan-quota" },
        { provider: "openai", billingSurface: "api-metered" },
      ],
    );

    const snapshot = service.snapshot({ days: 1 });
    expect(snapshot.totals.inputTokens).toBe(340);
    expect(snapshot.totals.outputTokens).toBe(90);

    // The whole point of the reconcile: every breakdown sums back exactly.
    expect(snapshot.reconcile.exact).toBe(true);
    expect(snapshot.reconcile.billingSurfacesMatchTotals).toBe(true);
    expect(snapshot.reconcile.brainPlusCrewMatchTotals).toBe(true);

    expect(snapshot.brain.brainInputTokens).toBe(100);
    expect(snapshot.brain.crewInputTokens).toBe(240);

    const surfaces = Object.fromEntries(
      snapshot.billingSurfaces.map((s) => [s.surface, s.inputTokens]),
    );
    expect(surfaces["plan-quota"]).toBe(300);
    expect(surfaces["api-metered"]).toBe(40);
  });

  it("buckets a provider with conflicting billing surfaces as unattributed, not a guess", async () => {
    const { AnalyticsService } = await import("../src/analytics/service.js");
    const service = new AnalyticsService(
      () => ({ events: [usageEvent("S1", "anthropic", 10, 5)] as never, truncated: false }),
      () => [],
      () => ({ facts: [], truncated: false }),
      // Two connections on the same provider billing differently: a usage frame
      // naming only the provider genuinely cannot be attributed to either.
      () => [
        { provider: "anthropic", billingSurface: "plan-quota" },
        { provider: "anthropic", billingSurface: "api-metered" },
      ],
    );

    const snapshot = service.snapshot({ days: 1 });
    expect(snapshot.billingSurfaces).toHaveLength(1);
    expect(snapshot.billingSurfaces[0]?.surface).toBe("unattributed");
    expect(snapshot.reconcile.exact).toBe(true);
  });
});
