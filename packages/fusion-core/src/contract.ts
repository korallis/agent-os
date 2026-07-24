/**
 * `/fusion` output contract (master plan §6.3).
 * Requires [ARCHITECT]/[BUILDER]/[FUSION] spans + Consensus & Divergence.
 */

export interface FusionContractResult {
  ok: boolean;
  errors: string[];
  hasArchitect: boolean;
  hasBuilder: boolean;
  hasFusion: boolean;
  hasConsensusDivergence: boolean;
  hasDecisionLedger: boolean;
}

const TAGS = {
  architect: /\[ARCHITECT\]/i,
  builder: /\[BUILDER\]/i,
  fusion: /\[FUSION\]/i,
  consensus: /consensus\s*&\s*divergence/i,
  ledger: /decision\s+ledger/i,
} as const;

/**
 * Enforce fusion artifact contract. Returns structured errors (FUSION_CONTRACT).
 */
export function enforceFusionContract(markdown: string): FusionContractResult {
  const hasArchitect = TAGS.architect.test(markdown);
  const hasBuilder = TAGS.builder.test(markdown);
  const hasFusion = TAGS.fusion.test(markdown);
  const hasConsensusDivergence = TAGS.consensus.test(markdown);
  const hasDecisionLedger = TAGS.ledger.test(markdown);

  const errors: string[] = [];
  if (!hasArchitect) errors.push("missing [ARCHITECT] span");
  if (!hasBuilder) errors.push("missing [BUILDER] span");
  if (!hasFusion) errors.push("missing [FUSION] span");
  if (!hasConsensusDivergence) errors.push("missing Consensus & Divergence section");
  if (!hasDecisionLedger) errors.push("missing Decision ledger section");

  return {
    ok: errors.length === 0,
    errors,
    hasArchitect,
    hasBuilder,
    hasFusion,
    hasConsensusDivergence,
    hasDecisionLedger,
  };
}
