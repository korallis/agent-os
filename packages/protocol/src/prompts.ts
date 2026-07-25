import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import { modelFamilySchema } from "./providers.js";

/**
 * Prompt packs and fusion runs (master plan §2.6, §6.3).
 * Every instruction a fusion role receives is a rendered layered template, and
 * the rendered bytes are recorded so a run can be audited after the fact.
 */

export const promptLayerSchema = z.enum(["shipped", "global", "project"]);
export type PromptLayer = z.infer<typeof promptLayerSchema>;

export const promptTemplateInfoSchema = z.strictObject({
  /** Pack-relative ref, e.g. `fusion/fusion.md`. */
  ref: z.string().min(1).max(200),
  layer: promptLayerSchema,
  path: z.string(),
  contentHash: z.string(),
  /** Differs from the shipped bytes it was installed from. */
  customized: z.boolean(),
  /** The shipped template moved since this copy was installed. */
  upstreamChanged: z.boolean(),
});
export type PromptTemplateInfo = z.infer<typeof promptTemplateInfoSchema>;

export const promptListResponseSchema = z.strictObject({
  templates: z.array(promptTemplateInfoSchema),
});
export type PromptListResponse = z.infer<typeof promptListResponseSchema>;

export const promptDiffResponseSchema = z.strictObject({
  ref: z.string(),
  /** Hash of the shipped bytes this copy was installed from (text not retained). */
  shippedAtInstall: z.string().nullable(),
  shippedNow: z.string().nullable(),
  yours: z.string().nullable(),
  customized: z.boolean(),
  upstreamChanged: z.boolean(),
});
export type PromptDiffResponse = z.infer<typeof promptDiffResponseSchema>;

// ── Fusion runs ────────────────────────────────────────────────────────────

export const fusionSideSchema = z.strictObject({
  role: z.string(),
  model: z.string(),
  family: modelFamilySchema,
  sessionId: ulidSchema.nullable(),
  /**
   * Hash of the rendered instruction this side received. Clean-room requires
   * every side of an `/opinion` to see byte-identical bytes.
   */
  promptHash: z.string(),
  artifactPath: z.string().nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  costUsd: z.number().min(0).nullable(),
});
export type FusionSide = z.infer<typeof fusionSideSchema>;

export const fusionRunSchema = z.strictObject({
  runId: ulidSchema,
  taskId: ulidSchema,
  kind: z.enum(["opinion", "fusion", "plan-fusion"]),
  /** Template the instruction was rendered from, with its resolved layer. */
  templateRef: z.string().nullable(),
  templateLayer: promptLayerSchema.nullable(),
  templateHash: z.string().nullable(),
  renderedHash: z.string().nullable(),
  /** Byte-identical across sides — the clean-room proof for `/opinion`. */
  promptsIdentical: z.boolean(),
  sides: z.array(fusionSideSchema),
  /** Family the aggregator ran on; retained from the architect cast. */
  aggregatorFamily: modelFamilySchema.nullable(),
  contractOk: z.boolean().nullable(),
  createdAt: isoTimestampSchema,
});
export type FusionRun = z.infer<typeof fusionRunSchema>;

export const fusionRunListResponseSchema = z.strictObject({
  runs: z.array(fusionRunSchema),
});
export type FusionRunListResponse = z.infer<typeof fusionRunListResponseSchema>;

export const fusionRunDetailResponseSchema = z.strictObject({
  run: fusionRunSchema,
  instruction: z.string().nullable(),
  fused: z.string().nullable(),
  /** Parsed attribution spans of the fused artifact, for the Console columns. */
  spans: z.array(
    z.strictObject({
      tag: z.string(),
      body: z.string(),
    }),
  ),
  sideArtifacts: z.array(
    z.strictObject({
      role: z.string(),
      model: z.string(),
      content: z.string(),
    }),
  ),
});
export type FusionRunDetailResponse = z.infer<typeof fusionRunDetailResponseSchema>;

/** Per-model session keys: one transcript is never replayed as another's. */
export const sessionKeySchema = z.strictObject({
  key: z.string(),
  projectId: ulidSchema,
  role: z.string(),
  model: z.string(),
  dir: z.string(),
  createdAt: isoTimestampSchema,
});
export type SessionKey = z.infer<typeof sessionKeySchema>;
