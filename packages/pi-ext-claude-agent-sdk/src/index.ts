import { familyOfModelRef, type ModelFamily } from "@agent-os/protocol";

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
 * anthropic/* validator (and vice versa) — same family.
 */
export function assertCrossFamilyCast(builderModel: string, validatorModel: string): void {
  const bf = familyOfModelRef(builderModel);
  const vf = familyOfModelRef(validatorModel);
  // `"other"` means "origin not recognised", not "a family of its own". Letting
  // it compare unequal to a known family made this fail open: an Anthropic
  // model behind an unrecognised origin would pair with an `anthropic/*`
  // validator and be accepted. See familiesConflict() in @agent-os/protocol.
  if (bf === vf || bf === "other" || vf === "other") {
    throw new CrossFamilyViolationError(builderModel, validatorModel, bf);
  }
}

export class CrossFamilyViolationError extends Error {
  readonly code = "POLICY_VIOLATION" as const;
  constructor(
    readonly builderModel: string,
    readonly validatorModel: string,
    readonly family: ModelFamily,
  ) {
    super(
      `cross-family violation: builder ${builderModel} and validator ${validatorModel} both family ${family}`,
    );
    this.name = "CrossFamilyViolationError";
  }
}
