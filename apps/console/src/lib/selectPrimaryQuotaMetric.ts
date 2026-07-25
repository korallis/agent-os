import type { QuotaMetric } from "@agent-os/protocol";

/**
 * Headline metric for quota cards (§7.3 card anatomy).
 *
 * Prefer plan-window / weekly for subscriptions and balance / account-credits
 * for API keys. Probe arrays often put session-window first (Anthropic 5h),
 * which must not become the big numeral when a weekly/plan metric exists.
 */
const PRIMARY_KIND_PREFERENCE: readonly QuotaMetric["kind"][] = [
  "weekly-window-pct",
  "plan-window-pct",
  "balance",
  "account-credits",
];

export function selectPrimaryQuotaMetric(
  metrics: readonly QuotaMetric[],
): { primary: QuotaMetric | undefined; subMetrics: QuotaMetric[] } {
  if (metrics.length === 0) {
    return { primary: undefined, subMetrics: [] };
  }
  for (const kind of PRIMARY_KIND_PREFERENCE) {
    const idx = metrics.findIndex((m) => m.kind === kind);
    if (idx >= 0) {
      const primary = metrics[idx]!;
      return {
        primary,
        subMetrics: metrics.filter((_, i) => i !== idx),
      };
    }
  }
  return {
    primary: metrics[0],
    subMetrics: metrics.slice(1),
  };
}
