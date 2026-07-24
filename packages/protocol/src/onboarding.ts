import { z } from "zod";
import { isoTimestampSchema } from "./ids.js";
import { claudeBillingModeSchema, piProviderIdSchema } from "./providers.js";

/**
 * Guided onboarding wizard state (master plan §4.10).
 * Persisted to `~/.agentos/onboarding.json5` + projected events.
 */

export const onboardingStepSchema = z.enum([
  "doctor",
  "providers",
  "auth",
  "claude-billing",
  "probes",
  "complete",
]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const doctorCheckIdSchema = z.enum(["node", "pi", "tmux", "git", "uv", "gh"]);
export type DoctorCheckId = z.infer<typeof doctorCheckIdSchema>;

export const doctorCheckSchema = z.strictObject({
  id: doctorCheckIdSchema,
  ok: z.boolean(),
  version: z.string().nullable(),
  required: z.string().nullable(),
  detail: z.string().nullable(),
  installHint: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const onboardingProviderChoiceSchema = z.strictObject({
  provider: piProviderIdSchema,
  selected: z.boolean(),
  detected: z.boolean(),
  authVerified: z.boolean(),
  /** Claude-only billing branch selection. */
  claudeBillingMode: claudeBillingModeSchema.nullable(),
  /** Subscription-sdk path sub-step verification flags. */
  claudeSdk: z
    .strictObject({
      claudeCodeLogin: z.boolean(),
      sdkInstalled: z.boolean(),
      noAmbientApiKey: z.boolean(),
      isolationDefaults: z.boolean(),
      catalogHealthcheck: z.boolean(),
    })
    .nullable(),
});
export type OnboardingProviderChoice = z.infer<typeof onboardingProviderChoiceSchema>;

export const onboardingStateSchema = z.strictObject({
  version: z.literal(1),
  step: onboardingStepSchema,
  doctor: z.array(doctorCheckSchema),
  providers: z.array(onboardingProviderChoiceSchema),
  /** True when wizard finished at least once. */
  completedAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema,
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;
