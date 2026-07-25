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

/** Metric kinds that describe a plan window the Brain is spending down. */
const WINDOW_KINDS = new Set([
  "session-window-pct",
  "weekly-window-pct",
  "plan-window-pct",
  "model-scoped-weekly-pct",
  "sdk-credit-pool",
]);

export function decideHandoff(input: {
  brainModel: string | null;
  brainConnectionId: string | null;
  config: BrainConfig;
  budgets: BudgetsConfig;
  samples: QuotaSample[];
  /** Candidate replacement models, already filtered to healthy connections. */
  candidates: string[];
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

  const target = pickTarget(input.config.handoff.target, input.brainModel, input.candidates);
  if (target === null) {
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

  return {
    shouldHandoff: true,
    fromModel: from,
    toModel: target,
    metric: worst.kind,
    observedPct: worst.pct,
    thresholdPct: threshold,
    basis: worst.tier,
    reason: `${worst.kind} at ${worst.pct}% crossed the ${threshold}% threshold (${worst.tier})`,
  };
}

function pickTarget(
  strategy: BrainConfig["handoff"]["target"],
  currentModel: string,
  candidates: string[],
): string | null {
  const currentFamily = familyFromModel(currentModel);
  const usable = candidates.filter((c) => c !== currentModel);
  if (usable.length === 0) return null;

  if (strategy === "same-family-api-key") {
    // Prefer the same family so the Brain's behaviour stays comparable; fall
    // back to any other family rather than leaving the fleet without a Brain.
    const sameFamily = usable.find((c) => familyFromModel(c) === currentFamily);
    return sameFamily ?? usable[0] ?? null;
  }
  const otherFamily = usable.find((c) => familyFromModel(c) !== currentFamily);
  return otherFamily ?? usable[0] ?? null;
}
