import type { BrainConfig, BudgetsConfig, QuotaSample } from "@agent-os/protocol";
import { familyFromModel } from "../substrate/family.js";

/**
 * Brain budget handoff (master plan §11 Phase 8, Captain decision R4).
 *
 * When the Brain's own connection crosses the configured share of its budget
 * window, the substrate moves the Brain to another model rather than letting it
 * run the Captain's plan window to zero — because the Brain is the one seat that
 * cannot be allowed to stop.
 *
 * Two rules the plan is explicit about:
 *   - the replacement runs in a NEW session. One model's transcript is never
 *     replayed as another model's context, for the same reason session keys are
 *     per-model: a Claude transcript is not valid input to GPT.
 *   - the decision is made from PROBED windows where they are live, not from an
 *     estimate. An estimate may trigger a handoff, but it is labelled as such
 *     so the Captain can see why the Brain moved.
 *
 * A refuge that is itself past the threshold is not preferred: when samples are
 * available, under-threshold candidates win; over-threshold ones are last resort.
 */

export interface HandoffDecision {
  shouldHandoff: boolean;
  fromModel: string;
  toModel: string | null;
  metric: string;
  observedPct: number;
  thresholdPct: number;
  /** Whether the deciding number was a live probe or a derived estimate. */
  basis: "live" | "best-effort" | "estimate" | "none";
  reason: string;
}

/** A replacement model plus its connection's worst window, when known. */
export interface HandoffCandidate {
  model: string;
  /**
   * Worst window percent for the candidate connection, or null when no sample
   * is available (not proven over-threshold — still eligible as a refuge).
   */
  worstWindowPct: number | null;
}

/** Metric kinds that describe a plan window the Brain is spending down. */
const WINDOW_KINDS = new Set([
  "session-window-pct",
  "weekly-window-pct",
  "plan-window-pct",
  "model-scoped-weekly-pct",
  "sdk-credit-pool",
]);

/** Worst percent window metric on a sample, or null when none apply. */
export function worstWindowPctFromSample(sample: QuotaSample | undefined): number | null {
  if (sample === undefined) return null;
  let worst: number | null = null;
  for (const metric of sample.metrics) {
    if (!WINDOW_KINDS.has(metric.kind)) continue;
    if (metric.unit !== "percent") continue;
    if (worst === null || metric.value > worst) worst = metric.value;
  }
  return worst;
}

export function decideHandoff(input: {
  brainModel: string | null;
  brainConnectionId: string | null;
  config: BrainConfig;
  budgets: BudgetsConfig;
  samples: QuotaSample[];
  /** Candidate replacements, already filtered to healthy connections. */
  candidates: HandoffCandidate[];
}): HandoffDecision {
  const threshold = input.config.handoff.thresholdPct;
  const from = input.brainModel ?? "unknown";
  const none: HandoffDecision = {
    shouldHandoff: false,
    fromModel: from,
    toModel: null,
    metric: "none",
    observedPct: 0,
    thresholdPct: threshold,
    basis: "none",
    reason: "no window metric for the Brain connection",
  };
  if (input.brainModel === null || input.brainConnectionId === null) return none;

  const sample = input.samples.find((s) => s.connectionId === input.brainConnectionId);
  if (sample === undefined) return none;

  // Take the WORST window the Brain is spending down: crossing any one of them
  // is what actually stops the Brain, not the average across them.
  let worst: { pct: number; kind: string; tier: QuotaSample["metrics"][number]["tier"] } | null =
    null;
  for (const metric of sample.metrics) {
    if (!WINDOW_KINDS.has(metric.kind)) continue;
    if (metric.unit !== "percent") continue;
    if (worst === null || metric.value > worst.pct) {
      worst = { pct: metric.value, kind: metric.kind, tier: metric.tier };
    }
  }
  if (worst === null) return none;

  if (worst.pct < threshold) {
    return {
      ...none,
      metric: worst.kind,
      observedPct: worst.pct,
      basis: worst.tier,
      reason: `${worst.kind} at ${worst.pct}% is below the ${threshold}% handoff threshold`,
    };
  }

  const picked = pickTarget(
    input.config.handoff.target,
    input.brainModel,
    input.candidates,
    threshold,
  );
  if (picked === null) {
    return {
      shouldHandoff: false,
      fromModel: from,
      toModel: null,
      metric: worst.kind,
      observedPct: worst.pct,
      thresholdPct: threshold,
      basis: worst.tier,
      // Say this plainly: the threshold was crossed and nothing could be done.
      reason: `${worst.kind} at ${worst.pct}% crossed ${threshold}% but no eligible handoff target is connected`,
    };
  }

  const baseReason = `${worst.kind} at ${worst.pct}% crossed the ${threshold}% threshold (${worst.tier})`;
  return {
    shouldHandoff: true,
    fromModel: from,
    toModel: picked.model,
    metric: worst.kind,
    observedPct: worst.pct,
    thresholdPct: threshold,
    basis: worst.tier,
    reason: picked.usedOverThresholdRefuge
      ? `${baseReason}; only over-threshold refuge available`
      : baseReason,
  };
}

function pickTarget(
  strategy: BrainConfig["handoff"]["target"],
  currentModel: string,
  candidates: HandoffCandidate[],
  threshold: number,
): { model: string; usedOverThresholdRefuge: boolean } | null {
  const usable = candidates.filter((c) => c.model !== currentModel);
  if (usable.length === 0) return null;

  // Prefer refuges not already past the threshold. Unknown samples count as
  // eligible — only a measured over-threshold connection is demoted.
  const underOrUnknown = usable.filter(
    (c) => c.worstWindowPct === null || c.worstWindowPct < threshold,
  );
  const overThreshold = usable.filter(
    (c) => c.worstWindowPct !== null && c.worstWindowPct >= threshold,
  );

  const fromPool = (pool: HandoffCandidate[]): string | null => {
    if (pool.length === 0) return null;
    const models = pool.map((c) => c.model);
    return pickByFamily(strategy, currentModel, models);
  };

  const healthy = fromPool(underOrUnknown);
  if (healthy !== null) {
    return { model: healthy, usedOverThresholdRefuge: false };
  }
  const exhausted = fromPool(overThreshold);
  if (exhausted !== null) {
    return { model: exhausted, usedOverThresholdRefuge: true };
  }
  return null;
}

function pickByFamily(
  strategy: BrainConfig["handoff"]["target"],
  currentModel: string,
  models: string[],
): string | null {
  if (models.length === 0) return null;
  const currentFamily = familyFromModel(currentModel);

  if (strategy === "same-family-api-key") {
    // Prefer the same family so the Brain's behaviour stays comparable; fall
    // back to any other family rather than leaving the fleet without a Brain.
    const sameFamily = models.find((c) => familyFromModel(c) === currentFamily);
    return sameFamily ?? models[0] ?? null;
  }
  const otherFamily = models.find((c) => familyFromModel(c) !== currentFamily);
  return otherFamily ?? models[0] ?? null;
}
