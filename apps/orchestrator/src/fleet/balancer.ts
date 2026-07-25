import type {
  BalancerConfig,
  ProviderConnection,
  QuotaSample,
} from "@agent-os/protocol";
import { familyFromModel } from "../substrate/family.js";

/**
 * Auto-balancer (master plan §11 Phase 10, [R7]).
 *
 * Spreads work across the Captain's configured models so no single connection
 * carries the fleet. Three findings from the design study shape this, and each
 * one rules out the obvious naive implementation:
 *
 *  1. THERE IS NO COST MODEL. This product has no price table and no capability
 *     tiers, and `costUsd` is null precisely on subscription connections — the
 *     setups where balancing matters most. Ranking on observed dollars would
 *     rate every Claude Max leg as free and shovel load onto plan quota until
 *     LIMIT REACHED stopped the fleet. So the balancer ranks on QUOTA-WINDOW
 *     HEADROOM, and treats dollars as an optional refinement only when cost
 *     coverage is not absent.
 *
 *  2. THE BRAIN IS THE ALLOCATOR; THE SUBSTRATE ONLY VETOES. `resolve_cast`
 *     validates and records a cast the Brain supplied — it never selects one,
 *     and every existing mechanism refuses rather than substitutes. So this
 *     produces a SUGGESTION the Brain consumes, plus a validator. It never
 *     rewrites a cast server-side, which would hide the decision inside the
 *     substrate.
 *
 *  3. A SINGLE-FAMILY ROSTER MAKES THE PRODUCT ILLEGAL TO CAST. builder ≠
 *     validator is enforced at cast and re-derived at spawn; `/opinion` needs
 *     ≥2 families with no override. So the picker optimises builder and
 *     validator JOINTLY, never greedily per role, and never sets
 *     familyCheckOverride to make its own suggestion legal.
 */

export interface BalancerCandidate {
  model: string;
  family: string;
  connectionId: string;
  provider: string;
  /** Worst observed window usage, 0–100. null when no window metric exists. */
  usedPct: number | null;
  /** Honesty tier of the deciding metric. */
  tier: "live" | "best-effort" | "estimate" | null;
  limitReached: boolean;
  healthy: boolean;
}

export interface BalancedRoleSuggestion {
  role: string;
  model: string;
  family: string;
  /** Why this model — inspectable rather than inferred. */
  reason: string;
}

export interface BalancerSuggestion {
  enabled: boolean;
  suggestions: BalancedRoleSuggestion[];
  /** Ranked candidates with the inputs the decision used. */
  considered: BalancerCandidate[];
  /** True when dollar cost was usable at all; false means headroom-only. */
  costUsable: boolean;
  /** Stated plainly so the Console never implies a saving we did not measure. */
  basis: string;
  /** Populated when no legal suggestion could be made. */
  refusal: string | null;
}

/** Headroom = how much of the window is left. Unknown sorts as "assume full". */
export function headroomOf(candidate: BalancerCandidate): number {
  if (candidate.usedPct === null) return 100;
  return Math.max(0, 100 - candidate.usedPct);
}

/**
 * Build the candidate set from live connections and quota samples.
 * A connection at its limit, or unhealthy, is never a candidate — and one that
 * is merely NEAR its threshold is de-preferred by headroom, before it trips.
 */
export function buildCandidates(input: {
  roster: BalancerConfig["roster"];
  connections: readonly ProviderConnection[];
  samples: readonly QuotaSample[];
}): BalancerCandidate[] {
  const out: BalancerCandidate[] = [];
  for (const entry of input.roster) {
    const provider = entry.model.split("/")[0] ?? "";
    const connection = input.connections.find(
      (c) => c.provider === provider || entry.model.startsWith(c.provider),
    );
    if (connection === undefined) continue;

    const sample = input.samples.find((s) => s.connectionId === connection.id);
    let worst: number | null = null;
    let tier: BalancerCandidate["tier"] = null;
    for (const metric of sample?.metrics ?? []) {
      if (metric.unit !== "percent") continue;
      if (worst === null || metric.value > worst) {
        worst = metric.value;
        tier = metric.tier;
      }
    }

    out.push({
      model: entry.model,
      family: familyFromModel(entry.model),
      connectionId: connection.id,
      provider: connection.provider,
      usedPct: worst,
      tier,
      limitReached: connection.limitReached,
      healthy: connection.health !== "unhealthy",
    });
  }
  return out;
}

/**
 * Suggest a builder/validator pair, optimised JOINTLY.
 *
 * A greedy per-role pick would take the two highest-headroom models, which can
 * easily be the same family — and the substrate would then refuse the cast at
 * spawn. Picking the pair together means the cross-family rule shapes the
 * choice instead of invalidating it afterwards.
 */
export function suggestCast(input: {
  config: BalancerConfig;
  candidates: BalancerCandidate[];
  roles: readonly string[];
  costUsable: boolean;
}): BalancerSuggestion {
  const basis = input.costUsable
    ? "quota-window headroom, refined by reported cost"
    : "quota-window headroom only — no provider reported per-request cost, so spend was not a factor";

  if (!input.config.enabled) {
    return {
      enabled: false,
      suggestions: [],
      considered: [],
      costUsable: input.costUsable,
      basis,
      refusal: null,
    };
  }

  // Eligible = in the roster, connected, healthy, and not already excluded.
  const eligible = input.candidates
    .filter((c) => c.healthy && !c.limitReached)
    .sort((a, b) => headroomOf(b) - headroomOf(a));

  if (eligible.length === 0) {
    return {
      enabled: true,
      suggestions: [],
      considered: input.candidates,
      costUsable: input.costUsable,
      basis,
      refusal: "no roster model has a healthy, non-limit-reached connection",
    };
  }

  const wantsPair = input.roles.includes("builder") && input.roles.includes("validator");
  if (wantsPair) {
    // Joint optimisation: the best-headroom PAIR that is cross-family.
    let best: { builder: BalancerCandidate; validator: BalancerCandidate } | null = null;
    for (const builder of eligible) {
      for (const validator of eligible) {
        if (validator.model === builder.model) continue;
        if (validator.family === builder.family) continue;
        if (
          best === null ||
          headroomOf(builder) + headroomOf(validator) >
            headroomOf(best.builder) + headroomOf(best.validator)
        ) {
          best = { builder, validator };
        }
      }
    }
    if (best === null) {
      // Refuse rather than suggest an illegal pair. The balancer must never be
      // the reason a familyCheckOverride gets stamped onto a task.
      return {
        enabled: true,
        suggestions: [],
        considered: eligible,
        costUsable: input.costUsable,
        basis,
        refusal:
          "no cross-family builder/validator pair is available from the roster — balancing would require weakening the cross-family rule, which it will not do",
      };
    }
    return {
      enabled: true,
      suggestions: [
        {
          role: "builder",
          model: best.builder.model,
          family: best.builder.family,
          reason: reasonFor(best.builder),
        },
        {
          role: "validator",
          model: best.validator.model,
          family: best.validator.family,
          reason: `${reasonFor(best.validator)}; cross-family with the builder (${best.builder.family})`,
        },
      ],
      considered: eligible,
      costUsable: input.costUsable,
      basis,
      refusal: null,
    };
  }

  // Single-role (or planner-only) casts: spread by headroom, distinct families
  // where more than one role is asked for, so /opinion stays legal.
  const suggestions: BalancedRoleSuggestion[] = [];
  const usedFamilies = new Set<string>();
  for (const role of input.roles) {
    const pick =
      eligible.find((c) => !usedFamilies.has(c.family)) ??
      eligible.find((c) => !suggestions.some((s) => s.model === c.model));
    if (pick === undefined) break;
    usedFamilies.add(pick.family);
    suggestions.push({ role, model: pick.model, family: pick.family, reason: reasonFor(pick) });
  }

  return {
    enabled: true,
    suggestions,
    considered: eligible,
    costUsable: input.costUsable,
    basis,
    refusal:
      suggestions.length < input.roles.length
        ? "not enough distinct eligible models in the roster for every requested role"
        : null,
  };
}

function reasonFor(candidate: BalancerCandidate): string {
  if (candidate.usedPct === null) {
    return `${candidate.model}: no window metric reported, treated as full headroom`;
  }
  return `${candidate.model}: ${Math.round(100 - candidate.usedPct)}% window headroom (${
    candidate.tier ?? "unknown"
  } reading of ${candidate.usedPct}% used)`;
}

/**
 * Validate a roster at CONFIG-WRITE time.
 *
 * A roster that collapses to one family makes SHIP tasks and `/opinion`
 * impossible to cast legally. Refusing at write time, with a path-precise
 * reason, is far kinder than accepting it and failing every task afterwards.
 */
export function validateRoster(config: BalancerConfig): {
  ok: boolean;
  issues: Array<{ path: string; message: string }>;
} {
  const issues: Array<{ path: string; message: string }> = [];
  if (!config.enabled) return { ok: true, issues };

  if (config.roster.length === 0) {
    issues.push({ path: "roster", message: "balancer is enabled but the roster is empty" });
    return { ok: false, issues };
  }

  const families = new Set(config.roster.map((entry) => familyFromModel(entry.model)));
  if (families.size < 2) {
    issues.push({
      path: "roster",
      message: `roster collapses to a single model family (${[...families].join(", ")}) — cross-family builder/validator and /opinion could never be cast legally. Add a model from another family, or disable the balancer.`,
    });
  }

  const brainCapable = config.roster.filter((entry) => entry.brainCapable);
  if (brainCapable.length === 0) {
    issues.push({
      path: "roster",
      message: "no roster entry is marked brainCapable — the Brain would have no refuge to balance toward",
    });
  }

  return { ok: issues.length === 0, issues };
}
