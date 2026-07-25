import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  headroomOf,
  suggestCast,
  validateRoster,
  type BalancerCandidate,
} from "../src/fleet/balancer.js";
import type { BalancerConfig } from "@agent-os/protocol";

const config = (over: Partial<BalancerConfig> = {}): BalancerConfig => ({
  enabled: true,
  roster: [
    { model: "anthropic/claude-sonnet-4-5", brainCapable: true },
    { model: "openai/gpt-4.1", brainCapable: true },
    { model: "xai/grok-3", brainCapable: false },
  ],
  steerAwayPct: 60,
  useReportedCost: true,
  ...over,
});

const candidate = (over: Partial<BalancerCandidate> & { model: string }): BalancerCandidate => ({
  family: over.model.split("/")[0] === "anthropic" ? "anthropic" : over.model.split("/")[0] ?? "",
  connectionId: `conn-${over.model}`,
  provider: over.model.split("/")[0] ?? "",
  usedPct: 10,
  tier: "live",
  limitReached: false,
  healthy: true,
  ...over,
});

describe("auto-balancer roster validation", () => {
  it("refuses a single-family roster at config-write time", () => {
    const verdict = validateRoster(
      config({
        roster: [
          { model: "anthropic/claude-sonnet-4-5", brainCapable: true },
          { model: "anthropic/claude-haiku-4-5", brainCapable: false },
        ],
      }),
    );
    // Refusing here beats accepting it and failing every SHIP task afterwards.
    expect(verdict.ok).toBe(false);
    expect(verdict.issues[0]?.message).toContain("single model family");
  });

  it("refuses a roster with no Brain-capable model", () => {
    const verdict = validateRoster(
      config({
        roster: [
          { model: "anthropic/claude-sonnet-4-5", brainCapable: false },
          { model: "openai/gpt-4.1", brainCapable: false },
        ],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.message.includes("brainCapable"))).toBe(true);
  });

  it("does not police the roster while the balancer is off", () => {
    // Off means off — a disabled feature must not block an unrelated write.
    expect(validateRoster(config({ enabled: false, roster: [] })).ok).toBe(true);
  });

  it("accepts a genuinely castable roster", () => {
    expect(validateRoster(config()).ok).toBe(true);
  });
});

describe("auto-balancer suggestions", () => {
  it("is inert when disabled — no suggestions, nothing to record", () => {
    const result = suggestCast({
      config: config({ enabled: false }),
      candidates: [candidate({ model: "anthropic/claude-sonnet-4-5" })],
      roles: ["builder", "validator"],
      costUsable: false,
    });
    expect(result.enabled).toBe(false);
    expect(result.suggestions).toHaveLength(0);
  });

  it("picks the builder/validator pair JOINTLY so it is cross-family", () => {
    // Greedy per-role would take the two highest-headroom models — both
    // anthropic here — and the substrate would then refuse the cast at spawn.
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 1 }),
        candidate({ model: "anthropic/claude-haiku-4-5", usedPct: 2 }),
        candidate({ model: "openai/gpt-4.1", usedPct: 40 }),
      ],
      roles: ["builder", "validator"],
      costUsable: false,
    });
    const families = result.suggestions.map((s) => s.family);
    expect(new Set(families).size).toBe(2);
    expect(result.refusal).toBeNull();
  });

  it("refuses rather than suggesting a same-family pair", () => {
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 1 }),
        candidate({ model: "anthropic/claude-haiku-4-5", usedPct: 2 }),
      ],
      roles: ["builder", "validator"],
      costUsable: false,
    });
    expect(result.suggestions).toHaveLength(0);
    // The balancer must never be the reason a safety override gets stamped.
    expect(result.refusal).toContain("cross-family");
    expect(result.refusal).toContain("will not do");
  });

  it("prefers headroom — the model with more window left wins", () => {
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 90 }),
        candidate({ model: "openai/gpt-4.1", usedPct: 5 }),
        candidate({ model: "xai/grok-3", usedPct: 50 }),
      ],
      roles: ["builder"],
      costUsable: false,
    });
    expect(result.suggestions[0]?.model).toBe("openai/gpt-4.1");
  });

  it("never suggests a limit-reached or unhealthy connection", () => {
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 1, limitReached: true }),
        candidate({ model: "openai/gpt-4.1", usedPct: 2, healthy: false }),
        candidate({ model: "xai/grok-3", usedPct: 70 }),
      ],
      roles: ["builder"],
      costUsable: false,
    });
    expect(result.suggestions[0]?.model).toBe("xai/grok-3");
  });

  it("states that cost was not a factor when no provider reported it", () => {
    const result = suggestCast({
      config: config(),
      candidates: [candidate({ model: "openai/gpt-4.1" })],
      roles: ["builder"],
      costUsable: false,
    });
    // Never imply a saving that was not measured.
    expect(result.basis).toContain("headroom only");
    expect(result.basis).toContain("not a factor");
    expect(result.costUsable).toBe(false);
  });

  it("records why each model was chosen, with the deciding numbers", () => {
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "openai/gpt-4.1", usedPct: 25, tier: "live" }),
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 30, tier: "estimate" }),
      ],
      roles: ["builder", "validator"],
      costUsable: false,
    });
    const reason = result.suggestions[0]?.reason ?? "";
    expect(reason).toContain("% window headroom");
    expect(reason).toMatch(/live|estimate/);
  });

  it("treats a missing window metric as full headroom rather than zero", () => {
    // Unknown must not read as "exhausted"; that would silently exclude every
    // provider that reports no window at all.
    expect(headroomOf(candidate({ model: "openai/gpt-4.1", usedPct: null }))).toBe(100);
  });

  it("keeps distinct families across multi-role casts so /opinion stays legal", () => {
    const result = suggestCast({
      config: config(),
      candidates: [
        candidate({ model: "anthropic/claude-sonnet-4-5", usedPct: 1 }),
        candidate({ model: "anthropic/claude-haiku-4-5", usedPct: 2 }),
        candidate({ model: "openai/gpt-4.1", usedPct: 3 }),
      ],
      roles: ["planner", "planner"],
      costUsable: false,
    });
    expect(new Set(result.suggestions.map((s) => s.family)).size).toBe(2);
  });
});

describe("candidate construction from live fleet state", () => {
  it("ranks on the WORST window and carries its honesty tier", () => {
    const candidates = buildCandidates({
      roster: [{ model: "anthropic/claude-sonnet-4-5", brainCapable: true }],
      connections: [
        {
          id: "01JCONN00000000000000000AA",
          kind: "pi-oauth",
          provider: "anthropic",
          label: "Claude",
          family: "anthropic",
          billingSurface: "plan-quota",
          billingMode: "subscription-oauth",
          health: "healthy",
          healthReason: null,
          authStorePresence: null,
          effectiveCredentialPath: "auth-json",
          personalUseOnly: true,
          supportedRoles: ["builder"],
          limitReached: false,
          limitReachedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      samples: [
        {
          id: "01JQUOTA000000000000000000",
          connectionId: "01JCONN00000000000000000AA",
          provider: "anthropic",
          metrics: [
            {
              kind: "session-window-pct",
              value: 20,
              unit: "percent",
              tier: "live",
              source: "OAUTH",
              syncedAt: new Date().toISOString(),
              reason: null,
              resetsAt: null,
              limitReached: false,
            },
            {
              kind: "weekly-window-pct",
              value: 85,
              unit: "percent",
              tier: "estimate",
              source: "OAUTH",
              syncedAt: new Date().toISOString(),
              reason: null,
              resetsAt: null,
              limitReached: false,
            },
          ],
          sampledAt: new Date().toISOString(),
        },
      ],
    });

    // 85 is the constraint that actually stops work, not the 20.
    expect(candidates[0]?.usedPct).toBe(85);
    expect(candidates[0]?.tier).toBe("estimate");
  });
});
