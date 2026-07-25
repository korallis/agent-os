import { z } from "zod";
import { quotaConfigSchema } from "./quota.js";
import { projectModeSchema, thinkingLevelSchema } from "./tasks.js";

/**
 * Config schemas — the Policy Packs foundation (master plan §2.6, §9).
 *
 * Phase 1: supervision, policies, console.
 * Phase 2: + quota (surface #14).
 * Phase 3: + brain, worktrees, projects, dispatch, validation, budgets.
 */

/** Layer precedence, lowest → highest (§2.6). */
export const configLayerSchema = z.enum(["shipped", "global", "project", "task"]);
export type ConfigLayer = z.infer<typeof configLayerSchema>;

export const CONFIG_LAYER_ORDER: readonly ConfigLayer[] = [
  "shipped",
  "global",
  "project",
  "task",
];

/** Wake classes the watcher may absorb without reaching the Brain (§5.6). */
export const absorbableWakeClassSchema = z.enum([
  "PROGRESS",
  "TURN_SETTLED_MID_STAGE",
  "CONTEXT_PRESSURE_LT_70",
  "STALE",
]);
export type AbsorbableWakeClass = z.infer<typeof absorbableWakeClassSchema>;

/** `supervision.json5` — config surface #5 (§2.6). Hot-reloadable. */
export const supervisionConfigSchema = z.strictObject({
  heartbeatSeconds: z.number().int().min(1).max(3600),
  staleMinutes: z.strictObject({
    api: z.number().int().min(1).max(240),
    build: z.number().int().min(1).max(240),
  }),
  escalationLadderSteps: z.number().int().min(1).max(10),
  respawnPerStage: z.number().int().min(0).max(5),
  absorb: z.array(absorbableWakeClassSchema),
});
export type SupervisionConfig = z.infer<typeof supervisionConfigSchema>;

/** `policies.json5` — safety toggles, config surface #12 (§2.6). Default all ON. */
export const safetyPoliciesConfigSchema = z.strictObject({
  crossFamilyBuilderValidator: z.boolean(),
  distinctPlannerFamilies: z.boolean(),
  redBaselineGateRequired: z.boolean(),
  scoutReadOnly: z.boolean(),
  verbatimFailDelivery: z.boolean(),
  haltCapNotYoloOverridable: z.boolean(),
  destructiveGitDenial: z.boolean(),
});
export type SafetyPoliciesConfig = z.infer<typeof safetyPoliciesConfigSchema>;

/** `console.json5` — config surface #10 (§2.6). Hot-reloadable. */
export const consoleConfigSchema = z.strictObject({
  defaultPage: z.enum([
    "fleet",
    "projects",
    "tasks",
    "runs",
    "providers",
    "analytics",
    "policies",
    "settings",
    "onboarding",
  ]),
  columnDensity: z.enum(["comfortable", "compact"]),
  wakeQueueVisible: z.boolean(),
});
export type ConsoleConfig = z.infer<typeof consoleConfigSchema>;

/** `brain.json5` — config surface #1 (§2.6, §5.11). */
export const brainConfigSchema = z.strictObject({
  cast: z.union([z.literal("auto"), z.string().min(3)]),
  thinking: thinkingLevelSchema,
  preferenceOrder: z.array(z.string().min(1)).min(1),
  handoff: z.strictObject({
    thresholdPct: z.number().int().min(1).max(100),
    target: z.enum(["same-family-api-key", "best-available-other-family"]),
  }),
  /** When true, brain pane respawn is blocked (fixture / degraded-mode tests). */
  respawnBlocked: z.boolean(),
});
export type BrainConfig = z.infer<typeof brainConfigSchema>;

/** `worktrees.json5` — config surface #7. */
export const worktreesConfigSchema = z.strictObject({
  poolSize: z.number().int().min(1).max(64),
  reclaimPolicy: z.enum(["verified-reset", "quarantine-always"]),
  networkPolicy: z.enum(["fetch-allowed", "offline"]),
});
export type WorktreesConfig = z.infer<typeof worktreesConfigSchema>;

/** `projects.json5` — config surface #8 defaults. */
export const projectsConfigSchema = z.strictObject({
  defaultMode: projectModeSchema,
  yoloAllowed: z.boolean(),
});
export type ProjectsConfig = z.infer<typeof projectsConfigSchema>;

/** `dispatch.json5` — config surface #4. */
export const dispatchConfigSchema = z.strictObject({
  rules: z.array(
    z.strictObject({
      when: z.string().min(1),
      hint: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;

/** `validation.json5` — config surface #6. */
export const validationConfigSchema = z.strictObject({
  maxValidations: z.number().int().min(1).max(20),
  triageAt: z.number().int().min(1).max(20),
  gateLanguage: z.enum(["py", "ts"]),
  gateTimeoutSeconds: z.number().int().min(5).max(3600),
});
export type ValidationConfig = z.infer<typeof validationConfigSchema>;

/** `budgets.json5` — config surface #9. */
export const budgetsConfigSchema = z.strictObject({
  perTaskUsd: z.number().min(0),
  claudeExtraUsageDailyUsd: z.number().min(0),
  brainTokensPerDay: z.number().int().min(0),
  gatewayHardUsd: z.number().min(0),
});
export type BudgetsConfig = z.infer<typeof budgetsConfigSchema>;

/**
 * `observability.json5` — config surface #11 (§11 Phase 9, [R7]).
 *
 * The Captain's framing: visibility is the product, and it must be theirs to
 * configure. A profile decides which event classes reach the Console, how much
 * live log to carry, and what is worth waking the Brain for. The shipped
 * default is deliberately quiet — depth is opted into, not opted out of.
 */
export const observabilityConfigSchema = z.strictObject({
  /** Named profile in `profiles`. */
  activeProfile: z.string().min(1),
  profiles: z.record(
    z.string(),
    z.strictObject({
      /**
       * Event type prefixes surfaced live (e.g. "pipeline.", "task."), or the
       * single token "*" meaning every event. An empty-string prefix is
       * deliberately NOT the wildcard — it would match everything by accident
       * whenever a value was left blank.
       */
      surface: z.array(z.string().min(1)),
      /** Carry incremental step-log output, not just structured state. */
      streamPipelineLogs: z.boolean(),
      /** Max log characters retained per step in the Console. */
      pipelineLogChars: z.number().int().min(0).max(200_000),
      /**
       * Event prefixes that additionally raise a Captain wake. Same non-empty
       * rule as `surface` — a blank entry would match every event via startsWith.
       */
      wakeOn: z.array(z.string().min(1)),
    }),
  ),
  /** Watch the local no-mistakes gate. Read-only; never drives it. */
  watchPipeline: z.boolean(),
  /** Structured-read cadence in ms; the WAL watch reacts faster than this. */
  pipelinePollMs: z.number().int().min(250).max(60_000),
});
export type ObservabilityConfig = z.infer<typeof observabilityConfigSchema>;

/** Domain registry — one schema per on-disk config file. */
export const configDomainSchemas = {
  supervision: supervisionConfigSchema,
  policies: safetyPoliciesConfigSchema,
  console: consoleConfigSchema,
  quota: quotaConfigSchema,
  brain: brainConfigSchema,
  worktrees: worktreesConfigSchema,
  projects: projectsConfigSchema,
  dispatch: dispatchConfigSchema,
  validation: validationConfigSchema,
  budgets: budgetsConfigSchema,
  observability: observabilityConfigSchema,
} as const;

export const configDomainSchema = z.enum([
  "supervision",
  "policies",
  "console",
  "quota",
  "brain",
  "worktrees",
  "projects",
  "dispatch",
  "validation",
  "budgets",
  "observability",
]);
export type ConfigDomain = z.infer<typeof configDomainSchema>;

export const CONFIG_DOMAINS: readonly ConfigDomain[] = [
  "supervision",
  "policies",
  "console",
  "quota",
  "brain",
  "worktrees",
  "projects",
  "dispatch",
  "validation",
  "budgets",
  "observability",
];

/** The fully-resolved effective config across all domains. */
export const agentOsConfigSchema = z.strictObject({
  supervision: supervisionConfigSchema,
  policies: safetyPoliciesConfigSchema,
  console: consoleConfigSchema,
  quota: quotaConfigSchema,
  brain: brainConfigSchema,
  worktrees: worktreesConfigSchema,
  projects: projectsConfigSchema,
  dispatch: dispatchConfigSchema,
  validation: validationConfigSchema,
  budgets: budgetsConfigSchema,
  observability: observabilityConfigSchema,
});
export type AgentOsConfig = z.infer<typeof agentOsConfigSchema>;

/** A path-precise validation issue for a single config key. */
export const configValidationIssueSchema = z.strictObject({
  /** Dotted path within the domain file, e.g. "staleMinutes.build". */
  path: z.string(),
  message: z.string(),
});
export type ConfigValidationIssue = z.infer<typeof configValidationIssueSchema>;

/**
 * `/v1/config/effective` response (§8.2): resolved values plus the source
 * layer for every leaf key (dotted `domain.path` form).
 */
export const effectiveConfigResponseSchema = z.strictObject({
  config: agentOsConfigSchema,
  sources: z.record(z.string(), configLayerSchema),
});
export type EffectiveConfigResponse = z.infer<typeof effectiveConfigResponseSchema>;

/** GET `/v1/config/:layer/:domain` response. */
export const configLayerFileResponseSchema = z.strictObject({
  layer: configLayerSchema,
  domain: configDomainSchema,
  /** Parsed JSON5 content of the layer file; null when the layer has no file. */
  value: z.unknown().nullable(),
});
export type ConfigLayerFileResponse = z.infer<typeof configLayerFileResponseSchema>;
