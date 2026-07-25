import { familyFromModel } from "../substrate/family.js";
/** Metric kinds that describe a plan window the Brain is spending down. */
const WINDOW_KINDS = new Set([
    "session-window-pct",
    "weekly-window-pct",
    "plan-window-pct",
    "model-scoped-weekly-pct",
    "sdk-credit-pool",
]);
/** Worst percent window metric on a sample, or null when none apply. */
export function worstWindowPctFromSample(sample) {
    if (sample === undefined)
        return null;
    let worst = null;
    for (const metric of sample.metrics) {
        if (!WINDOW_KINDS.has(metric.kind))
            continue;
        if (metric.unit !== "percent")
            continue;
        if (worst === null || metric.value > worst)
            worst = metric.value;
    }
    return worst;
}
export function decideHandoff(input) {
    const threshold = input.config.handoff.thresholdPct;
    const from = input.brainModel ?? "unknown";
    const none = {
        shouldHandoff: false,
        fromModel: from,
        toModel: null,
        metric: "none",
        observedPct: 0,
        thresholdPct: threshold,
        basis: "none",
        reason: "no window metric for the Brain connection",
    };
    if (input.brainModel === null || input.brainConnectionId === null)
        return none;
    const sample = input.samples.find((s) => s.connectionId === input.brainConnectionId);
    if (sample === undefined)
        return none;
    // Take the WORST window the Brain is spending down: crossing any one of them
    // is what actually stops the Brain, not the average across them.
    let worst = null;
    for (const metric of sample.metrics) {
        if (!WINDOW_KINDS.has(metric.kind))
            continue;
        if (metric.unit !== "percent")
            continue;
        if (worst === null || metric.value > worst.pct) {
            worst = { pct: metric.value, kind: metric.kind, tier: metric.tier };
        }
    }
    if (worst === null)
        return none;
    if (worst.pct < threshold) {
        return {
            ...none,
            metric: worst.kind,
            observedPct: worst.pct,
            basis: worst.tier,
            reason: `${worst.kind} at ${worst.pct}% is below the ${threshold}% handoff threshold`,
        };
    }
    const picked = pickTarget(input.config.handoff.target, input.brainModel, input.candidates, threshold);
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
function pickTarget(strategy, currentModel, candidates, threshold) {
    const usable = candidates.filter((c) => c.model !== currentModel);
    if (usable.length === 0)
        return null;
    // Prefer refuges not already past the threshold. Unknown samples count as
    // eligible — only a measured over-threshold connection is demoted.
    const underOrUnknown = usable.filter((c) => c.worstWindowPct === null || c.worstWindowPct < threshold);
    const overThreshold = usable.filter((c) => c.worstWindowPct !== null && c.worstWindowPct >= threshold);
    const fromPool = (pool) => {
        if (pool.length === 0)
            return null;
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
function pickByFamily(strategy, currentModel, models) {
    if (models.length === 0)
        return null;
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
