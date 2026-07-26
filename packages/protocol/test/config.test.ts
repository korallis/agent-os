import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  CONFIG_DOMAINS,
  CONFIG_LAYER_ORDER,
  agentOsConfigSchema,
  brainConfigSchema,
  budgetsConfigSchema,
  configDomainSchema,
  configDomainSchemas,
  configLayerFileResponseSchema,
  configLayerSchema,
  consoleConfigSchema,
  dispatchConfigSchema,
  effectiveConfigResponseSchema,
  safetyPoliciesConfigSchema,
  supervisionConfigSchema,
  validationConfigSchema,
  worktreesConfigSchema,
  type AgentOsConfig,
  type ConfigDomain,
} from "../src/config.js";
import { piProviderIdSchema } from "../src/providers.js";
import {
  quotaConfigSchema,
  quotaMetricSchema,
  quotaProviderProbeConfigSchema,
  quotaSampleSchema,
  type QuotaMetric,
  type QuotaSample,
} from "../src/quota.js";

/* ------------------------------------------------------------------ *
 * Helpers — no `any`, and every rejection assertion reports where the
 * schema said no, so a schema that rejects for the *wrong* reason
 * (e.g. an unrelated missing key) still fails the test.
 * ------------------------------------------------------------------ */

interface Rejection {
  readonly paths: readonly string[];
  readonly codes: readonly string[];
}

function rejects(schema: ZodType, value: unknown): Rejection {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error(`expected rejection, but the schema accepted: ${JSON.stringify(value)}`);
  }
  return {
    paths: result.error.issues.map((issue) => issue.path.map(String).join(".")),
    codes: result.error.issues.map((issue) => issue.code),
  };
}

function accepts(schema: ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `expected acceptance, but the schema rejected: ${JSON.stringify(result.error.issues)}`,
    );
  }
}

function omitKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k !== key) rest[k] = v;
  }
  return rest;
}

/** The wire is JSON. Anything that only survives in memory is a lie on the wire. */
function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/* ------------------------------------------------------------------ *
 * Fixtures — a full, valid effective config. Typed, so a schema change
 * that renames or retypes a key breaks compilation here first.
 * ------------------------------------------------------------------ */

const validConfig: AgentOsConfig = {
  supervision: {
    heartbeatSeconds: 30,
    staleMinutes: { api: 8, build: 20 },
    escalationLadderSteps: 3,
    respawnPerStage: 1,
    absorb: ["PROGRESS", "STALE"],
  },
  policies: {
    crossFamilyBuilderValidator: true,
    distinctPlannerFamilies: true,
    redBaselineGateRequired: true,
    scoutReadOnly: true,
    verbatimFailDelivery: true,
    haltCapNotYoloOverridable: true,
    destructiveGitDenial: true,
  },
  console: {
    defaultPage: "fleet",
    columnDensity: "comfortable",
    wakeQueueVisible: true,
  },
  quota: {
    pollIntervalSeconds: 300,
    minIntervalSeconds: 60,
    jitterSeconds: 15,
    backoffBaseSeconds: 30,
    backoffMaxSeconds: 900,
    thresholds: {
      windowPctWarn: 70,
      windowPctCritical: 90,
      lowBalanceUsd: 5,
    },
    providers: {
      anthropic: { enabled: true, bestEffortAllowed: false },
      openai: { enabled: true, bestEffortAllowed: false },
      xai: { enabled: true, bestEffortAllowed: true },
      openrouter: { enabled: true, bestEffortAllowed: false },
      "kimi-coding": { enabled: false, bestEffortAllowed: false },
      "vercel-ai-gateway": { enabled: true, bestEffortAllowed: false },
      "claude-agent-sdk": { enabled: true, bestEffortAllowed: false },
    },
  },
  brain: {
    cast: "auto",
    thinking: "high",
    preferenceOrder: ["anthropic", "openai"],
    handoff: { thresholdPct: 85, target: "same-family-api-key" },
    respawnBlocked: false,
  },
  worktrees: {
    poolSize: 8,
    reclaimPolicy: "verified-reset",
    networkPolicy: "fetch-allowed",
  },
  projects: {
    defaultMode: "pipeline",
    yoloAllowed: false,
  },
  dispatch: {
    rules: [{ when: "task.kind == 'build'", hint: { role: "builder" } }],
  },
  validation: {
    maxValidations: 5,
    triageAt: 3,
    gateLanguage: "ts",
    gateTimeoutSeconds: 900,
  },
  budgets: {
    perTaskUsd: 10,
    claudeExtraUsageDailyUsd: 25,
    brainTokensPerDay: 2_000_000,
    gatewayHardUsd: 100,
  },
  observability: {
    activeProfile: "quiet",
    profiles: {
      quiet: {
        surface: ["task.", "captain.", "pipeline.run_updated"],
        streamPipelineLogs: false,
        pipelineLogChars: 0,
        wakeOn: ["captain.escalation"],
      },
      working: {
        surface: ["task.", "captain.", "brain.", "pipeline."],
        streamPipelineLogs: true,
        pipelineLogChars: 20_000,
        wakeOn: ["captain.escalation", "pipeline.unavailable"],
      },
      firehose: {
        surface: ["*"],
        streamPipelineLogs: true,
        pipelineLogChars: 200_000,
        wakeOn: ["captain.escalation", "pipeline.unavailable"],
      },
    },
    watchPipeline: true,
    pipelinePollMs: 1000,
  },
  balancer: {
    enabled: false,
    // Two families on purpose: a single-family roster is refused at WRITE time,
    // because cross-family builder/validator and /opinion could never be cast
    // legally from it. A fixture that could not be saved is not a valid fixture.
    roster: [
      { model: "anthropic/claude-opus-4-5", brainCapable: true },
      { model: "openai/gpt-5", brainCapable: false },
    ],
    // Below the Brain handoff threshold, so crew work steers away first and the
    // Brain only moves when steering was not enough.
    steerAwayPct: 60,
    useReportedCost: false,
  },
};

const validMetric: QuotaMetric = {
  kind: "session-window-pct",
  value: 42,
  unit: "percent",
  tier: "live",
  source: "OAUTH · SYNCED 10:27",
  syncedAt: "2026-07-24T10:27:00.000Z",
  reason: null,
  resetsAt: "2026-07-24T15:00:00.000Z",
  limitReached: false,
};

const validSample: QuotaSample = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  provider: "anthropic",
  metrics: [validMetric],
  sampledAt: "2026-07-24T10:27:00.000Z",
};

/* ================================================================== *
 * config.ts — registry coherence
 * ================================================================== */

describe("config domain registry", () => {
  it("keeps the domain enum, the schema registry, and the effective-config shape in lockstep", () => {
    // A domain added to the enum but not the registry has no schema, so the
    // loader would validate that file against nothing and accept garbage.
    const enumDomains = [...configDomainSchema.options].sort();
    expect(Object.keys(configDomainSchemas).sort()).toEqual(enumDomains);
    expect(Object.keys(agentOsConfigSchema.shape).sort()).toEqual(enumDomains);
    expect([...CONFIG_DOMAINS].sort()).toEqual(enumDomains);
  });

  it("exposes the same schema object per domain in the registry and the effective config", () => {
    // Drift here means `/v1/config/:layer/:domain` validates a file against a
    // different (looser) schema than the resolved config it feeds.
    for (const domain of CONFIG_DOMAINS) {
      expect(configDomainSchemas[domain]).toBe(agentOsConfigSchema.shape[domain]);
    }
  });

  it("lists every domain exactly once in CONFIG_DOMAINS", () => {
    expect(new Set(CONFIG_DOMAINS).size).toBe(CONFIG_DOMAINS.length);
  });

  it("orders layers lowest-to-highest precedence with task winning and shipped losing", () => {
    // Reordering this array silently inverts config precedence: a project
    // file would start overriding an explicit per-task override.
    expect([...CONFIG_LAYER_ORDER]).toEqual(["shipped", "global", "project", "task"]);
    expect([...CONFIG_LAYER_ORDER].sort()).toEqual([...configLayerSchema.options].sort());
    expect(CONFIG_LAYER_ORDER.indexOf("task")).toBe(CONFIG_LAYER_ORDER.length - 1);
    expect(CONFIG_LAYER_ORDER.indexOf("shipped")).toBe(0);
  });

  it("rejects layer and domain names that are not in the enums", () => {
    expect(rejects(configLayerSchema, "user").codes).toContain("invalid_value");
    expect(rejects(configLayerSchema, "runtime").codes).toContain("invalid_value");
    expect(rejects(configDomainSchema, "prompts").codes).toContain("invalid_value");
    // Casing is not normalised — "Task" must not slip through as "task".
    expect(rejects(configLayerSchema, "Task").codes).toContain("invalid_value");
  });
});

/* ================================================================== *
 * config.ts — no hidden defaults
 * ================================================================== */

describe("config domains supply no implicit defaults", () => {
  it("rejects an empty object for every domain rather than materialising defaults", () => {
    // If a schema ever grows `.default()`, a config file missing a key would
    // start the daemon on a value nobody wrote down. That must never happen
    // silently: absence is an error the Captain can see.
    for (const domain of CONFIG_DOMAINS) {
      const result = configDomainSchemas[domain].safeParse({});
      expect(result.success, `${domain} accepted {}`).toBe(false);
    }
  });

  it("returns exactly the keys it was given — no injected keys", () => {
    for (const domain of CONFIG_DOMAINS) {
      const input: Record<string, unknown> = { ...validConfig[domain] };
      const parsed = configDomainSchemas[domain].parse(input);
      expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual(
        Object.keys(input).sort(),
      );
    }
  });

  it("rejects each individually missing supervision key", () => {
    for (const key of Object.keys(validConfig.supervision)) {
      const result = supervisionConfigSchema.safeParse(omitKey({ ...validConfig.supervision }, key));
      expect(result.success, `supervision accepted without ${key}`).toBe(false);
    }
  });

  it("rejects a policy pack with a missing safety toggle instead of defaulting it on", () => {
    for (const key of Object.keys(validConfig.policies)) {
      const rejection = rejects(
        safetyPoliciesConfigSchema,
        omitKey({ ...validConfig.policies }, key),
      );
      expect(rejection.paths).toContain(key);
    }
  });
});

/* ================================================================== *
 * config.ts — supervision boundaries
 * ================================================================== */

describe("supervisionConfigSchema", () => {
  it("accepts the inclusive heartbeat bounds and rejects one step outside", () => {
    accepts(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: 1 });
    accepts(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: 3600 });
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: 0 }).paths).toEqual([
      "heartbeatSeconds",
    ]);
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: 3601 }).paths).toEqual([
      "heartbeatSeconds",
    ]);
  });

  it("rejects a fractional heartbeat (setTimeout would silently truncate it)", () => {
    expect(
      rejects(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: 30.5 }).paths,
    ).toEqual(["heartbeatSeconds"]);
  });

  it("rejects a quoted number — a JSON5 typo must not become a NaN timer", () => {
    const quoted: Record<string, unknown> = { ...validConfig.supervision, heartbeatSeconds: "30" };
    expect(rejects(supervisionConfigSchema, quoted).paths).toEqual(["heartbeatSeconds"]);
  });

  it("rejects NaN and Infinity heartbeats", () => {
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, heartbeatSeconds: Number.NaN }).paths).toEqual(
      ["heartbeatSeconds"],
    );
    expect(
      rejects(supervisionConfigSchema, {
        ...validConfig.supervision,
        heartbeatSeconds: Number.POSITIVE_INFINITY,
      }).paths,
    ).toEqual(["heartbeatSeconds"]);
  });

  it("bounds stale minutes per lane with a path-precise error", () => {
    accepts(supervisionConfigSchema, {
      ...validConfig.supervision,
      staleMinutes: { api: 1, build: 240 },
    });
    expect(
      rejects(supervisionConfigSchema, {
        ...validConfig.supervision,
        staleMinutes: { api: 0, build: 20 },
      }).paths,
    ).toEqual(["staleMinutes.api"]);
    expect(
      rejects(supervisionConfigSchema, {
        ...validConfig.supervision,
        staleMinutes: { api: 8, build: 241 },
      }).paths,
    ).toEqual(["staleMinutes.build"]);
  });

  it("rejects an extra key inside the nested staleMinutes object", () => {
    const rejection = rejects(supervisionConfigSchema, {
      ...validConfig.supervision,
      staleMinutes: { api: 8, build: 20, plan: 15 },
    });
    expect(rejection.codes).toContain("unrecognized_keys");
  });

  it("allows respawnPerStage 0 (respawn disabled) but not a negative respawn budget", () => {
    accepts(supervisionConfigSchema, { ...validConfig.supervision, respawnPerStage: 0 });
    accepts(supervisionConfigSchema, { ...validConfig.supervision, respawnPerStage: 5 });
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, respawnPerStage: -1 }).paths).toEqual([
      "respawnPerStage",
    ]);
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, respawnPerStage: 6 }).paths).toEqual([
      "respawnPerStage",
    ]);
  });

  it("requires at least one escalation ladder step", () => {
    expect(rejects(supervisionConfigSchema, { ...validConfig.supervision, escalationLadderSteps: 0 }).paths).toEqual([
      "escalationLadderSteps",
    ]);
  });

  it("allows an empty absorb list but rejects a wake class that is not absorbable", () => {
    accepts(supervisionConfigSchema, { ...validConfig.supervision, absorb: [] });
    // A near-miss threshold name must not be silently ignored — the watcher
    // would swallow wakes the Brain is supposed to see.
    expect(
      rejects(supervisionConfigSchema, {
        ...validConfig.supervision,
        absorb: ["CONTEXT_PRESSURE_LT_90"],
      }).paths,
    ).toEqual(["absorb.0"]);
    expect(
      rejects(supervisionConfigSchema, {
        ...validConfig.supervision,
        absorb: ["PROGRESS", "HALT"],
      }).paths,
    ).toEqual(["absorb.1"]);
  });

  it("rejects an unknown top-level key so a misspelt setting is never ignored", () => {
    const rejection = rejects(supervisionConfigSchema, {
      ...validConfig.supervision,
      hearbeatSeconds: 5,
    });
    expect(rejection.codes).toContain("unrecognized_keys");
  });
});

/* ================================================================== *
 * config.ts — policies / console / brain / worktrees / projects
 * ================================================================== */

describe("safetyPoliciesConfigSchema", () => {
  it("rejects truthy strings — 'false' must not disable a safety gate by being non-empty", () => {
    const stringy: Record<string, unknown> = { ...validConfig.policies, scoutReadOnly: "false" };
    expect(rejects(safetyPoliciesConfigSchema, stringy).paths).toEqual(["scoutReadOnly"]);
  });

  it("rejects 0/1 in place of booleans", () => {
    const numeric: Record<string, unknown> = { ...validConfig.policies, destructiveGitDenial: 0 };
    expect(rejects(safetyPoliciesConfigSchema, numeric).paths).toEqual(["destructiveGitDenial"]);
  });

  it("rejects an unknown policy key so a renamed gate fails loudly", () => {
    expect(
      rejects(safetyPoliciesConfigSchema, { ...validConfig.policies, yoloAllowed: true }).codes,
    ).toContain("unrecognized_keys");
  });
});

describe("consoleConfigSchema", () => {
  it("pins the exact set of landable pages", () => {
    // Iterating `shape.defaultPage.options` and asserting each one parses is a
    // tautology — the enum would accept anything it happens to list, including
    // a route the console does not serve. The list itself is the contract, so
    // it is spelled out here independently: adding a page the console cannot
    // render, or dropping one it can, has to be a deliberate two-file change.
    const pages = [...consoleConfigSchema.shape.defaultPage.options];
    expect(pages).toEqual([
      "fleet",
      "projects",
      "tasks",
      "runs",
      "providers",
      "analytics",
      "policies",
      "settings",
      "onboarding",
    ]);
    for (const page of pages) {
      accepts(consoleConfigSchema, { ...validConfig.console, defaultPage: page });
    }
  });

  it("rejects a page name outside the closed set", () => {
    // `alerts`, `network` and `notifications` are shipped console routes that
    // this enum does not list — see the note in the summary. Until the enum
    // grows, they must fail loudly rather than land the Captain on a 404.
    expect(rejects(consoleConfigSchema, { ...validConfig.console, defaultPage: "alerts" }).paths).toEqual([
      "defaultPage",
    ]);
    expect(rejects(consoleConfigSchema, { ...validConfig.console, defaultPage: "/fleet" }).paths).toEqual([
      "defaultPage",
    ]);
  });

  it("rejects a density value outside comfortable/compact", () => {
    expect(rejects(consoleConfigSchema, { ...validConfig.console, columnDensity: "dense" }).paths).toEqual([
      "columnDensity",
    ]);
  });
});

describe("brainConfigSchema", () => {
  it("accepts the auto literal and an explicit cast id, but not a stub id", () => {
    accepts(brainConfigSchema, { ...validConfig.brain, cast: "auto" });
    accepts(brainConfigSchema, { ...validConfig.brain, cast: "anthropic/claude-opus" });
    expect(rejects(brainConfigSchema, { ...validConfig.brain, cast: "ab" }).paths).toEqual(["cast"]);
    expect(rejects(brainConfigSchema, { ...validConfig.brain, cast: "" }).paths).toEqual(["cast"]);
  });

  it("rejects a non-string cast", () => {
    const numeric: Record<string, unknown> = { ...validConfig.brain, cast: 5 };
    expect(rejects(brainConfigSchema, numeric).paths).toEqual(["cast"]);
  });

  it("requires a non-empty preference order with non-empty entries", () => {
    // An empty preference order means "no provider preference at all", which
    // would make brain selection non-deterministic.
    expect(rejects(brainConfigSchema, { ...validConfig.brain, preferenceOrder: [] }).paths).toEqual([
      "preferenceOrder",
    ]);
    expect(rejects(brainConfigSchema, { ...validConfig.brain, preferenceOrder: [""] }).paths).toEqual([
      "preferenceOrder.0",
    ]);
    expect(
      rejects(brainConfigSchema, { ...validConfig.brain, preferenceOrder: ["anthropic", ""] }).paths,
    ).toEqual(["preferenceOrder.1"]);
  });

  it("bounds the handoff threshold to 1..100 as an integer percent", () => {
    accepts(brainConfigSchema, {
      ...validConfig.brain,
      handoff: { thresholdPct: 1, target: "same-family-api-key" },
    });
    accepts(brainConfigSchema, {
      ...validConfig.brain,
      handoff: { thresholdPct: 100, target: "same-family-api-key" },
    });
    // 0 would hand off before the pane has done any work at all.
    expect(
      rejects(brainConfigSchema, {
        ...validConfig.brain,
        handoff: { thresholdPct: 0, target: "same-family-api-key" },
      }).paths,
    ).toEqual(["handoff.thresholdPct"]);
    expect(
      rejects(brainConfigSchema, {
        ...validConfig.brain,
        handoff: { thresholdPct: 101, target: "same-family-api-key" },
      }).paths,
    ).toEqual(["handoff.thresholdPct"]);
    // A fraction of a percent would be truncated by any integer comparison.
    expect(
      rejects(brainConfigSchema, {
        ...validConfig.brain,
        handoff: { thresholdPct: 85.5, target: "same-family-api-key" },
      }).paths,
    ).toEqual(["handoff.thresholdPct"]);
  });

  it("rejects an unknown handoff target", () => {
    expect(
      rejects(brainConfigSchema, {
        ...validConfig.brain,
        handoff: { thresholdPct: 85, target: "any-available" },
      }).paths,
    ).toEqual(["handoff.target"]);
  });

  it("rejects an unknown thinking level", () => {
    expect(rejects(brainConfigSchema, { ...validConfig.brain, thinking: "ultra" }).paths).toEqual([
      "thinking",
    ]);
  });
});

describe("worktreesConfigSchema", () => {
  it("bounds the pool size to 1..64", () => {
    accepts(worktreesConfigSchema, { ...validConfig.worktrees, poolSize: 1 });
    accepts(worktreesConfigSchema, { ...validConfig.worktrees, poolSize: 64 });
    // A pool of 0 would deadlock every dispatch waiting for a worktree.
    expect(rejects(worktreesConfigSchema, { ...validConfig.worktrees, poolSize: 0 }).paths).toEqual([
      "poolSize",
    ]);
    expect(rejects(worktreesConfigSchema, { ...validConfig.worktrees, poolSize: 65 }).paths).toEqual([
      "poolSize",
    ]);
  });

  it("rejects a network policy that is not one of the two sanctioned modes", () => {
    // "none" reads like offline but is not the sanctioned token; accepting it
    // would leave the policy resolver to fall through to its own default.
    expect(rejects(worktreesConfigSchema, { ...validConfig.worktrees, networkPolicy: "none" }).paths).toEqual([
      "networkPolicy",
    ]);
    expect(
      rejects(worktreesConfigSchema, { ...validConfig.worktrees, reclaimPolicy: "reset" }).paths,
    ).toEqual(["reclaimPolicy"]);
  });
});

describe("dispatchConfigSchema", () => {
  it("accepts zero rules but rejects an empty predicate", () => {
    accepts(dispatchConfigSchema, { rules: [] });
    expect(rejects(dispatchConfigSchema, { rules: [{ when: "", hint: {} }] }).paths).toEqual([
      "rules.0.when",
    ]);
  });

  it("rejects a hint that is not an object of keyed values", () => {
    const stringHint: Record<string, unknown> = { rules: [{ when: "always", hint: "builder" }] };
    expect(rejects(dispatchConfigSchema, stringHint).paths).toEqual(["rules.0.hint"]);
    // An array is the shape a JSON5 author reaches for when they mean "a list
    // of hints"; it must be refused at the hint itself, not blamed on the rule.
    const arrayHint: Record<string, unknown> = { rules: [{ when: "always", hint: ["builder"] }] };
    expect(rejects(dispatchConfigSchema, arrayHint).paths).toEqual(["rules.0.hint"]);
    const nullHint: Record<string, unknown> = { rules: [{ when: "always", hint: null }] };
    expect(rejects(dispatchConfigSchema, nullHint).paths).toEqual(["rules.0.hint"]);
  });

  it("rejects an unknown key on a dispatch rule", () => {
    expect(
      rejects(dispatchConfigSchema, {
        rules: [{ when: "always", hint: {}, priority: 1 }],
      }).codes,
    ).toContain("unrecognized_keys");
  });
});

describe("validationConfigSchema", () => {
  it("bounds validation counts and the gate timeout", () => {
    accepts(validationConfigSchema, { ...validConfig.validation, maxValidations: 1 });
    accepts(validationConfigSchema, { ...validConfig.validation, maxValidations: 20 });
    expect(rejects(validationConfigSchema, { ...validConfig.validation, maxValidations: 0 }).paths).toEqual([
      "maxValidations",
    ]);
    expect(rejects(validationConfigSchema, { ...validConfig.validation, maxValidations: 21 }).paths).toEqual([
      "maxValidations",
    ]);
    // A sub-5s gate timeout would fail every real test command.
    expect(rejects(validationConfigSchema, { ...validConfig.validation, gateTimeoutSeconds: 4 }).paths).toEqual([
      "gateTimeoutSeconds",
    ]);
    accepts(validationConfigSchema, { ...validConfig.validation, gateTimeoutSeconds: 5 });
    accepts(validationConfigSchema, { ...validConfig.validation, gateTimeoutSeconds: 3600 });
    expect(
      rejects(validationConfigSchema, { ...validConfig.validation, gateTimeoutSeconds: 3601 }).paths,
    ).toEqual(["gateTimeoutSeconds"]);
  });

  it("rejects a gate language outside py/ts", () => {
    expect(rejects(validationConfigSchema, { ...validConfig.validation, gateLanguage: "js" }).paths).toEqual([
      "gateLanguage",
    ]);
  });
});

describe("budgetsConfigSchema", () => {
  it("allows a zero budget but rejects a negative one", () => {
    accepts(budgetsConfigSchema, { ...validConfig.budgets, perTaskUsd: 0 });
    expect(rejects(budgetsConfigSchema, { ...validConfig.budgets, perTaskUsd: -0.01 }).paths).toEqual([
      "perTaskUsd",
    ]);
    expect(rejects(budgetsConfigSchema, { ...validConfig.budgets, gatewayHardUsd: -1 }).paths).toEqual([
      "gatewayHardUsd",
    ]);
  });

  it("keeps USD budgets fractional but the brain token budget integral", () => {
    accepts(budgetsConfigSchema, { ...validConfig.budgets, perTaskUsd: 12.5 });
    expect(rejects(budgetsConfigSchema, { ...validConfig.budgets, brainTokensPerDay: 1.5 }).paths).toEqual([
      "brainTokensPerDay",
    ]);
  });

  it("rejects NaN and Infinity budgets — an unbounded spend cap must be written explicitly", () => {
    expect(rejects(budgetsConfigSchema, { ...validConfig.budgets, perTaskUsd: Number.NaN }).paths).toEqual([
      "perTaskUsd",
    ]);
    expect(
      rejects(budgetsConfigSchema, {
        ...validConfig.budgets,
        claudeExtraUsageDailyUsd: Number.POSITIVE_INFINITY,
      }).paths,
    ).toEqual(["claudeExtraUsageDailyUsd"]);
  });
});

/* ================================================================== *
 * config.ts — REST response shapes
 * ================================================================== */

describe("effectiveConfigResponseSchema", () => {
  it("accepts a fully-resolved config with per-leaf source layers", () => {
    accepts(effectiveConfigResponseSchema, {
      config: validConfig,
      sources: { "supervision.heartbeatSeconds": "global", "quota.pollIntervalSeconds": "shipped" },
    });
  });

  it("rejects a source layer that is not a real layer", () => {
    const rejection = rejects(effectiveConfigResponseSchema, {
      config: validConfig,
      sources: { "supervision.heartbeatSeconds": "user" },
    });
    expect(rejection.paths).toEqual(["sources.supervision.heartbeatSeconds"]);
  });

  it("rejects a response that is missing a whole config domain", () => {
    const partial = omitKey({ ...validConfig }, "quota");
    expect(rejects(effectiveConfigResponseSchema, { config: partial, sources: {} }).paths).toEqual([
      "config.quota",
    ]);
  });

  it("rejects an unknown domain smuggled into the effective config", () => {
    expect(
      rejects(effectiveConfigResponseSchema, {
        config: { ...validConfig, prompts: {} },
        sources: {},
      }).codes,
    ).toContain("unrecognized_keys");
  });

  it("survives a JSON round-trip unchanged", () => {
    const response = { config: validConfig, sources: { "brain.cast": "task" } };
    expect(effectiveConfigResponseSchema.parse(jsonRoundTrip(response))).toEqual(response);
  });
});

describe("configLayerFileResponseSchema", () => {
  it("requires an explicit null when the layer has no file — absence is not a valid answer", () => {
    // The daemon must say "this layer has no file" out loud. A dropped key
    // would let a client render "no override" and "unknown" identically.
    accepts(configLayerFileResponseSchema, { layer: "project", domain: "quota", value: null });
    expect(rejects(configLayerFileResponseSchema, { layer: "project", domain: "quota" }).paths).toEqual([
      "value",
    ]);
  });

  it("accepts an in-memory undefined value but that shape dies on the wire", () => {
    // JSON.stringify drops undefined, so a handler that returns `value:
    // undefined` type-checks, parses locally, and then produces a body the
    // very same schema rejects. Pin the asymmetry so it stays visible.
    const withUndefined = { layer: "project", domain: "quota", value: undefined };
    accepts(configLayerFileResponseSchema, withUndefined);
    expect(rejects(configLayerFileResponseSchema, jsonRoundTrip(withUndefined)).paths).toEqual([
      "value",
    ]);
    // Explicit null is the shape that actually survives.
    const withNull = { layer: "project", domain: "quota", value: null };
    expect(configLayerFileResponseSchema.parse(jsonRoundTrip(withNull))).toEqual(withNull);
  });

  it("hands back the parsed JSON5 body intact, not a stripped shell of it", () => {
    // Merely asserting this parses proves nothing: `z.object({})` would also
    // accept it and hand back `{}`, and the console's layer editor would show
    // the Captain an empty file over a file full of overrides. Assert the body
    // comes back out, nested arrays and all.
    const body = { heartbeatSeconds: 30, nested: { deep: [1, 2, 3] } };
    const parsed = configLayerFileResponseSchema.parse({
      layer: "global",
      domain: "supervision",
      value: body,
    });
    expect(parsed.value).toEqual(body);

    // "Arbitrary" means arbitrary: a JSON5 file whose top level is not an
    // object is still a file the daemon has to be able to report back.
    expect(
      configLayerFileResponseSchema.parse({ layer: "task", domain: "brain", value: [1, "two"] })
        .value,
    ).toEqual([1, "two"]);
    expect(
      configLayerFileResponseSchema.parse({ layer: "task", domain: "brain", value: 7 }).value,
    ).toBe(7);
  });

  it("rejects an unknown layer or domain in the path echo", () => {
    expect(rejects(configLayerFileResponseSchema, { layer: "user", domain: "quota", value: null }).paths).toEqual([
      "layer",
    ]);
    expect(
      rejects(configLayerFileResponseSchema, { layer: "task", domain: "sessions", value: null }).paths,
    ).toEqual(["domain"]);
  });
});

/* ================================================================== *
 * quota.ts — probe scheduling config
 * ================================================================== */

describe("quotaConfigSchema", () => {
  const quota = validConfig.quota;

  it("holds the poll interval to the 30..3600s floor that keeps probes off rate limits", () => {
    accepts(quotaConfigSchema, { ...quota, pollIntervalSeconds: 30 });
    accepts(quotaConfigSchema, { ...quota, pollIntervalSeconds: 3600 });
    // 29s would hammer provider endpoints below the sanctioned floor.
    expect(rejects(quotaConfigSchema, { ...quota, pollIntervalSeconds: 29 }).paths).toEqual([
      "pollIntervalSeconds",
    ]);
    expect(rejects(quotaConfigSchema, { ...quota, pollIntervalSeconds: 3601 }).paths).toEqual([
      "pollIntervalSeconds",
    ]);
    expect(rejects(quotaConfigSchema, { ...quota, pollIntervalSeconds: 0 }).paths).toEqual([
      "pollIntervalSeconds",
    ]);
  });

  it("holds the manual-refresh floor at 10s", () => {
    accepts(quotaConfigSchema, { ...quota, minIntervalSeconds: 10 });
    expect(rejects(quotaConfigSchema, { ...quota, minIntervalSeconds: 9 }).paths).toEqual([
      "minIntervalSeconds",
    ]);
  });

  it("allows zero jitter but caps it at 120s and forbids negative jitter", () => {
    accepts(quotaConfigSchema, { ...quota, jitterSeconds: 0 });
    accepts(quotaConfigSchema, { ...quota, jitterSeconds: 120 });
    // Negative jitter would schedule the next probe in the past.
    expect(rejects(quotaConfigSchema, { ...quota, jitterSeconds: -1 }).paths).toEqual(["jitterSeconds"]);
    expect(rejects(quotaConfigSchema, { ...quota, jitterSeconds: 121 }).paths).toEqual(["jitterSeconds"]);
  });

  it("keeps backoff bounds integral and inside range", () => {
    accepts(quotaConfigSchema, { ...quota, backoffBaseSeconds: 1, backoffMaxSeconds: 30 });
    expect(rejects(quotaConfigSchema, { ...quota, backoffBaseSeconds: 0 }).paths).toEqual([
      "backoffBaseSeconds",
    ]);
    expect(rejects(quotaConfigSchema, { ...quota, backoffMaxSeconds: 29 }).paths).toEqual([
      "backoffMaxSeconds",
    ]);
    expect(rejects(quotaConfigSchema, { ...quota, backoffBaseSeconds: 1.5 }).paths).toEqual([
      "backoffBaseSeconds",
    ]);
  });

  it("keeps threshold percentages inside 0..100", () => {
    accepts(quotaConfigSchema, {
      ...quota,
      thresholds: { windowPctWarn: 0, windowPctCritical: 100, lowBalanceUsd: 0 },
    });
    // A 101% "critical" threshold can never fire — the alert would be dead.
    expect(
      rejects(quotaConfigSchema, {
        ...quota,
        thresholds: { ...quota.thresholds, windowPctCritical: 100.1 },
      }).paths,
    ).toEqual(["thresholds.windowPctCritical"]);
    expect(
      rejects(quotaConfigSchema, {
        ...quota,
        thresholds: { ...quota.thresholds, windowPctWarn: -0.1 },
      }).paths,
    ).toEqual(["thresholds.windowPctWarn"]);
    expect(
      rejects(quotaConfigSchema, {
        ...quota,
        thresholds: { ...quota.thresholds, lowBalanceUsd: -1 },
      }).paths,
    ).toEqual(["thresholds.lowBalanceUsd"]);
  });

  it("allows fractional warn thresholds (percent is not an integer field)", () => {
    accepts(quotaConfigSchema, {
      ...quota,
      thresholds: { ...quota.thresholds, windowPctWarn: 72.5 },
    });
  });

  it("names every probe-config provider with a real Pi provider id", () => {
    // A typo like "kimi_coding" would create a probe flag no provider can
    // ever read, silently disabling that provider's quota probe.
    const providerKeys = Object.keys(quotaConfigSchema.shape.providers.shape);
    // Guard the loop: an empty `providers` shape would make the assertions
    // below run zero times and the test pass while probing nothing at all.
    expect(providerKeys).toEqual([
      "anthropic",
      "openai",
      "xai",
      "openrouter",
      "kimi-coding",
      "vercel-ai-gateway",
      "claude-agent-sdk",
    ]);
    for (const providerKey of providerKeys) {
      const parsed = piProviderIdSchema.safeParse(providerKey);
      expect(parsed.success, `${providerKey} is not a Pi provider id`).toBe(true);
    }
  });

  it("requires a probe flag for every provider it declares", () => {
    const missing = omitKey({ ...quota.providers }, "claude-agent-sdk");
    expect(rejects(quotaConfigSchema, { ...quota, providers: missing }).paths).toEqual([
      "providers.claude-agent-sdk",
    ]);
  });

  it("rejects a probe flag for a provider the probe set does not cover", () => {
    // "google" is a valid Pi provider but has no quota probe; adding it here
    // must be a deliberate schema change, not a config-file surprise.
    expect(
      rejects(quotaConfigSchema, {
        ...quota,
        providers: { ...quota.providers, google: { enabled: true, bestEffortAllowed: false } },
      }).codes,
    ).toContain("unrecognized_keys");
  });

  it("requires bestEffortAllowed to be stated, never inferred from enabled", () => {
    // Defaulting this on would let best-effort scrapes render beside live
    // numbers with no one having opted in.
    expect(rejects(quotaProviderProbeConfigSchema, { enabled: true }).paths).toEqual([
      "bestEffortAllowed",
    ]);
    expect(rejects(quotaProviderProbeConfigSchema, { bestEffortAllowed: true }).paths).toEqual([
      "enabled",
    ]);
    expect(
      rejects(quotaProviderProbeConfigSchema, { enabled: true, bestEffortAllowed: true, url: "x" })
        .codes,
    ).toContain("unrecognized_keys");
  });

  it("rejects probe endpoint URLs — those are config-locked in code", () => {
    expect(
      rejects(quotaConfigSchema, { ...quota, probeUrl: "https://api.anthropic.com" }).codes,
    ).toContain("unrecognized_keys");
  });
});

/* ================================================================== *
 * quota.ts — honesty discipline on metrics
 * ================================================================== */

describe("quotaMetricSchema honesty invariants", () => {
  it("requires the honesty tier — an estimate can never be published as untagged", () => {
    // Dropping `tier` must fail validation rather than let the console render
    // a scraped guess with the same weight as a live OAuth reading.
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "tier")).paths).toEqual(["tier"]);
    expect(rejects(quotaMetricSchema, { ...validMetric, tier: "guess" }).paths).toEqual(["tier"]);
    expect(rejects(quotaMetricSchema, { ...validMetric, tier: "unknown" }).paths).toEqual(["tier"]);
  });

  it("requires an explicit null reason — a missing reason is not the same as 'no reason'", () => {
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "reason")).paths).toEqual([
      "reason",
    ]);
    accepts(quotaMetricSchema, { ...validMetric, reason: null });
    accepts(quotaMetricSchema, { ...validMetric, reason: "probe returned no balance row" });
  });

  it("requires an explicit null resetsAt — an unknown window reset must be stated, not omitted", () => {
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "resetsAt")).paths).toEqual([
      "resetsAt",
    ]);
    accepts(quotaMetricSchema, { ...validMetric, resetsAt: null });
  });

  it("treats undefined as no answer at all — null is the only wire-safe 'unknown'", () => {
    // Unlike `configLayerFileResponseSchema.value` (a nullable `unknown`,
    // which does accept an in-memory undefined), a nullable string rejects
    // undefined outright, before and after serialisation. So a probe that
    // forgets to set `reason` fails at the boundary instead of shipping a
    // metric whose honesty note silently vanished in JSON.stringify.
    const withUndefined = { ...validMetric, reason: undefined };
    expect(rejects(quotaMetricSchema, withUndefined).paths).toEqual(["reason"]);
    expect(rejects(quotaMetricSchema, jsonRoundTrip(withUndefined)).paths).toEqual(["reason"]);
    expect(quotaMetricSchema.parse(jsonRoundTrip({ ...validMetric, reason: null })).reason).toBeNull();
  });

  it("keeps a zero reading and an unknown reading distinguishable across a JSON round-trip", () => {
    const liveZero: QuotaMetric = {
      ...validMetric,
      kind: "balance",
      value: 0,
      unit: "usd",
      tier: "live",
      reason: null,
      resetsAt: null,
    };
    const unknownBalance: QuotaMetric = {
      ...liveZero,
      unit: "unknown",
      tier: "estimate",
      reason: "provider returned no balance field",
    };

    const parsedLive = quotaMetricSchema.parse(jsonRoundTrip(liveZero));
    const parsedUnknown = quotaMetricSchema.parse(jsonRoundTrip(unknownBalance));

    // Both carry value 0 — the honesty markers are the only thing separating
    // "the account is empty" from "we could not read the account".
    expect(parsedLive.value).toBe(0);
    expect(parsedUnknown.value).toBe(0);
    expect(parsedUnknown).not.toEqual(parsedLive);
    expect(parsedUnknown.tier).toBe("estimate");
    expect(parsedUnknown.unit).toBe("unknown");
    expect(parsedUnknown.reason).toBe("provider returned no balance field");
    expect(parsedLive.tier).toBe("live");
    expect(parsedLive.reason).toBeNull();
  });

  it("rejects a null value, so 'unknown' can never be smuggled in as a numeric hole", () => {
    // Callers must degrade via unit/tier/reason, not by nulling the number —
    // a null here would be coerced to 0 by any arithmetic downstream.
    const nulled: Record<string, unknown> = { ...validMetric, value: null };
    expect(rejects(quotaMetricSchema, nulled).paths).toEqual(["value"]);
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "value")).paths).toEqual(["value"]);
  });

  it("rejects NaN as a metric value", () => {
    expect(rejects(quotaMetricSchema, { ...validMetric, value: Number.NaN }).paths).toEqual(["value"]);
  });

  it("requires limitReached as a real boolean", () => {
    const stringy: Record<string, unknown> = { ...validMetric, limitReached: "true" };
    expect(rejects(quotaMetricSchema, stringy).paths).toEqual(["limitReached"]);
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "limitReached")).paths).toEqual([
      "limitReached",
    ]);
  });

  it("requires the verbatim source row — an empty attribution is still a string, so pin the key", () => {
    expect(rejects(quotaMetricSchema, omitKey({ ...validMetric }, "source")).paths).toEqual([
      "source",
    ]);
  });

  it("rejects a near-miss metric kind", () => {
    // "session-window" without the -pct suffix would render a percent bar
    // from a value that is not a percent.
    expect(rejects(quotaMetricSchema, { ...validMetric, kind: "session-window" }).paths).toEqual([
      "kind",
    ]);
    expect(rejects(quotaMetricSchema, { ...validMetric, kind: "cost" }).paths).toEqual(["kind"]);
  });

  it("rejects a unit outside the closed set", () => {
    expect(rejects(quotaMetricSchema, { ...validMetric, unit: "%" }).paths).toEqual(["unit"]);
    expect(rejects(quotaMetricSchema, { ...validMetric, unit: "USD" }).paths).toEqual(["unit"]);
    accepts(quotaMetricSchema, { ...validMetric, unit: "unknown" });
  });

  it("requires UTC ISO timestamps with a zone designator", () => {
    accepts(quotaMetricSchema, { ...validMetric, syncedAt: "2026-07-24T10:27:00Z" });
    // A local-offset or date-only stamp would be plotted at the wrong instant.
    expect(rejects(quotaMetricSchema, { ...validMetric, syncedAt: "2026-07-24T10:27:00+01:00" }).paths).toEqual([
      "syncedAt",
    ]);
    expect(rejects(quotaMetricSchema, { ...validMetric, syncedAt: "2026-07-24T10:27:00" }).paths).toEqual([
      "syncedAt",
    ]);
    expect(rejects(quotaMetricSchema, { ...validMetric, syncedAt: "2026-07-24" }).paths).toEqual([
      "syncedAt",
    ]);
    expect(rejects(quotaMetricSchema, { ...validMetric, syncedAt: "10:27" }).paths).toEqual([
      "syncedAt",
    ]);
    expect(rejects(quotaMetricSchema, { ...validMetric, resetsAt: "in 4 hours" }).paths).toEqual([
      "resetsAt",
    ]);
  });

  it("rejects an unknown metric key so a stray field never rides along untyped", () => {
    expect(rejects(quotaMetricSchema, { ...validMetric, confidence: 0.5 }).codes).toContain(
      "unrecognized_keys",
    );
  });
});

/* ================================================================== *
 * quota.ts — samples
 * ================================================================== */

describe("quotaSampleSchema", () => {
  it("accepts a sample with no metrics — 'we read nothing' is a legal answer", () => {
    // Requiring at least one metric would push probes into fabricating a
    // zero row when a provider returns nothing.
    accepts(quotaSampleSchema, { ...validSample, metrics: [] });
  });

  it("rejects ids that are not ULIDs", () => {
    expect(rejects(quotaSampleSchema, { ...validSample, id: "01ARZ3NDEKTSV4RRFFQ69G5FA" }).paths).toEqual([
      "id",
    ]);
    expect(
      rejects(quotaSampleSchema, {
        ...validSample,
        connectionId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
      }).paths,
    ).toEqual(["connectionId"]);
    expect(rejects(quotaSampleSchema, { ...validSample, connectionId: "" }).paths).toEqual([
      "connectionId",
    ]);
  });

  it("surfaces a bad nested metric with a path that points at the offending metric", () => {
    const badNested = {
      ...validSample,
      metrics: [validMetric, { ...validMetric, tier: "vibes" }],
    };
    expect(rejects(quotaSampleSchema, badNested).paths).toEqual(["metrics.1.tier"]);
  });

  it("rejects an unknown provider id", () => {
    expect(rejects(quotaSampleSchema, { ...validSample, provider: "grok" }).paths).toEqual([
      "provider",
    ]);
  });

  it("requires sampledAt and rejects an unknown key", () => {
    expect(rejects(quotaSampleSchema, omitKey({ ...validSample }, "sampledAt")).paths).toEqual([
      "sampledAt",
    ]);
    expect(rejects(quotaSampleSchema, { ...validSample, stale: true }).codes).toContain(
      "unrecognized_keys",
    );
  });

  it("round-trips through JSON with every honesty marker intact", () => {
    const sample: QuotaSample = {
      ...validSample,
      metrics: [
        { ...validMetric, tier: "best-effort", reason: "consumer endpoint", resetsAt: null },
      ],
    };
    const parsed = quotaSampleSchema.parse(jsonRoundTrip(sample));
    expect(parsed).toEqual(sample);
    expect(parsed.metrics[0]?.tier).toBe("best-effort");
    expect(parsed.metrics[0]?.resetsAt).toBeNull();
  });
});

/* ================================================================== *
 * Cross-surface: the quota domain the config registry exposes is the
 * same schema the quota module defines.
 * ================================================================== */

describe("quota is wired into the config registry", () => {
  it("registers the quota config under the quota domain", () => {
    const domain: ConfigDomain = "quota";
    expect(configDomainSchemas[domain]).toBe(quotaConfigSchema);
    expect(agentOsConfigSchema.shape.quota).toBe(quotaConfigSchema);
  });

  it("rejects an out-of-range quota value through the effective-config response", () => {
    // The nested path proves the quota bounds are enforced at the API edge,
    // not only when the quota file is read standalone.
    const rejection = rejects(effectiveConfigResponseSchema, {
      config: { ...validConfig, quota: { ...validConfig.quota, pollIntervalSeconds: 5 } },
      sources: {},
    });
    expect(rejection.paths).toEqual(["config.quota.pollIntervalSeconds"]);
  });
});
