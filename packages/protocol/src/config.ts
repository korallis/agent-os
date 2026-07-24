import { z } from "zod";

/**
 * Config schemas — the Policy Packs foundation (master plan §2.6, §9).
 *
 * Phase 1 ships three domains: `supervision` (carries the hot-reload gate
 * value), `policies` (safety toggles, default ON), and `console` (layout
 * preferences). Every domain file is validated as a whole — invalid config
 * is rejected with path-precise issues and nothing partially applies.
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
  ]),
  columnDensity: z.enum(["comfortable", "compact"]),
  wakeQueueVisible: z.boolean(),
});
export type ConsoleConfig = z.infer<typeof consoleConfigSchema>;

/** Domain registry — one schema per on-disk config file. */
export const configDomainSchemas = {
  supervision: supervisionConfigSchema,
  policies: safetyPoliciesConfigSchema,
  console: consoleConfigSchema,
} as const;

export const configDomainSchema = z.enum(["supervision", "policies", "console"]);
export type ConfigDomain = z.infer<typeof configDomainSchema>;

export const CONFIG_DOMAINS: readonly ConfigDomain[] = [
  "supervision",
  "policies",
  "console",
];

/** The fully-resolved effective config across all domains. */
export const agentOsConfigSchema = z.strictObject({
  supervision: supervisionConfigSchema,
  policies: safetyPoliciesConfigSchema,
  console: consoleConfigSchema,
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
