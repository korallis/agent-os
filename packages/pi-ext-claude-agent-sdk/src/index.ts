import {
  familiesConflict,
  familyOfModelRef,
  type ModelFamily,
} from "@agent-os/protocol";

/**
 * Vendored claude-agent-sdk-pi bridge (master plan §4.10, R6.1).
 *
 * Registers provider id `claude-agent-sdk`. LLM calls route through the
 * official Claude Agent SDK; tools still execute in Pi. This package is
 * the monorepo fork — wizard installs `@agentos/claude-agent-sdk-pi@` pin,
 * never the upstream npm publish blindly.
 *
 * Phase 2 ships the family registry + isolation defaults + catalog surface.
 * Full SDK wire-up lands with live credential smoke (opt-in).
 */

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk" as const;

export const CLAUDE_AGENT_SDK_MODELS = [
  "claude-agent-sdk/claude-opus-4-5",
  "claude-agent-sdk/claude-sonnet-4-5",
  "claude-agent-sdk/claude-haiku-4-5",
] as const;

export interface ClaudeAgentSdkIsolationDefaults {
  settingSources: [] | ["user"];
  strictMcpConfig: true;
}

/** Isolation defaults written by the wizard (§4.10 Step 2a.4). */
export const DEFAULT_ISOLATION: ClaudeAgentSdkIsolationDefaults = {
  settingSources: [],
  strictMcpConfig: true,
};

/** Family classification gate: always anthropic. */
export function familyOfClaudeAgentSdkModel(modelRef: string): ModelFamily {
  return familyOfModelRef(modelRef);
}

export function isClaudeAgentSdkModel(modelRef: string): boolean {
  return modelRef.startsWith("claude-agent-sdk/");
}

/**
 * Catalog listing for healthcheck / model picker.
 */
export function listClaudeAgentSdkCatalog(): readonly string[] {
  return CLAUDE_AGENT_SDK_MODELS;
}

/**
 * Cross-family check: a claude-agent-sdk builder must not pair with an
 * anthropic/* validator (and vice versa) — same family. Also fails closed on
 * unrecognised origins via `familiesConflict`.
 */
export function assertCrossFamilyCast(builderModel: string, validatorModel: string): void {
  if (familiesConflict(builderModel, validatorModel)) {
    throw new CrossFamilyViolationError(
      builderModel,
      validatorModel,
      familyOfModelRef(builderModel),
      familyOfModelRef(validatorModel),
    );
  }
}

export class CrossFamilyViolationError extends Error {
  readonly code = "POLICY_VIOLATION" as const;
  constructor(
    readonly builderModel: string,
    readonly validatorModel: string,
    readonly builderFamily: ModelFamily,
    readonly validatorFamily: ModelFamily,
  ) {
    const unknown =
      builderFamily === "other" || validatorFamily === "other"
        ? builderFamily === "other" && validatorFamily === "other"
          ? " — both seats have unrecognised origin"
          : builderFamily === "other"
            ? " — builder origin is unrecognised"
            : " — validator origin is unrecognised"
        : "";
    super(
      builderFamily === validatorFamily && builderFamily !== "other"
        ? `cross-family violation: builder ${builderModel} and validator ${validatorModel} both family ${builderFamily}`
        : `cross-family violation: builder ${builderModel} (family ${builderFamily}) and validator ${validatorModel} (family ${validatorFamily})${unknown}`,
    );
    this.name = "CrossFamilyViolationError";
  }
}
