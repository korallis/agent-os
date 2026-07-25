import { describe, expect, it } from "vitest";
import { probeConnection } from "../src/quota-probes/probes.js";
const baseConfig = {
    pollIntervalSeconds: 300,
    minIntervalSeconds: 60,
    jitterSeconds: 0,
    backoffBaseSeconds: 30,
    backoffMaxSeconds: 900,
    thresholds: { windowPctWarn: 80, windowPctCritical: 95, lowBalanceUsd: 5 },
    providers: {
        anthropic: { enabled: true, bestEffortAllowed: false },
        openai: { enabled: true, bestEffortAllowed: false },
        xai: { enabled: true, bestEffortAllowed: true },
        openrouter: { enabled: true, bestEffortAllowed: false },
        "kimi-coding": { enabled: false, bestEffortAllowed: false },
        "vercel-ai-gateway": { enabled: false, bestEffortAllowed: false },
        "claude-agent-sdk": { enabled: true, bestEffortAllowed: false },
    },
};
function conn(partial) {
    const now = new Date().toISOString();
    return {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "pi-oauth",
        label: partial.provider,
        family: "anthropic",
        billingSurface: "extra-usage-per-token",
        billingMode: null,
        health: "healthy",
        healthReason: null,
        authStorePresence: null,
        effectiveCredentialPath: "auth-json",
        personalUseOnly: true,
        supportedRoles: ["brain"],
        limitReached: false,
        limitReachedReason: null,
        createdAt: now,
        updatedAt: now,
        ...partial,
    };
}
describe("quota probes", () => {
    it("parses Claude live metrics from fixture response", async () => {
        const { sample, events } = await probeConnection({
            connection: conn({ provider: "anthropic", billingMode: "extra-usage-oauth" }),
            config: baseConfig,
            authJsonPath: "/nonexistent",
            fixtureToken: "fixture-token",
            fetchImpl: async () => new Response(JSON.stringify({
                five_hour: 24,
                seven_day: 40,
                extra_usage: 1.25,
                five_hour_resets_at: "2026-07-24T15:00:00.000Z",
            }), { status: 200 }),
        });
        expect(sample.metrics.some((m) => m.tier === "live" && m.kind === "session-window-pct")).toBe(true);
        expect(sample.metrics.find((m) => m.kind === "session-window-pct")?.value).toBe(24);
        expect(events.some((e) => e.type === "quota.updated")).toBe(true);
    });
    it("LIMIT REACHED fixture emits threshold event", async () => {
        const { sample, events } = await probeConnection({
            connection: conn({ provider: "openai", family: "openai", billingSurface: "plan-quota" }),
            config: baseConfig,
            authJsonPath: "/nonexistent",
            fixtureToken: "fixture-token",
            fetchImpl: async () => new Response(JSON.stringify({ used_percent: 100 }), { status: 200 }),
        });
        expect(sample.metrics.some((m) => m.limitReached)).toBe(true);
        expect(events.some((e) => e.type === "quota.threshold")).toBe(true);
    });
    it("HTTP failures degrade to estimate without throwing", async () => {
        const { sample } = await probeConnection({
            connection: conn({ provider: "anthropic" }),
            config: baseConfig,
            authJsonPath: "/nonexistent",
            fixtureToken: "fixture-token",
            fetchImpl: async () => new Response("nope", { status: 500 }),
        });
        expect(sample.metrics.every((m) => m.tier === "estimate")).toBe(true);
    });
    it("disabled probe yields estimate reason", async () => {
        const cfg = {
            ...baseConfig,
            providers: {
                ...baseConfig.providers,
                anthropic: { enabled: false, bestEffortAllowed: false },
            },
        };
        const { sample } = await probeConnection({
            connection: conn({ provider: "anthropic" }),
            config: cfg,
            authJsonPath: "/nonexistent",
        });
        expect(sample.metrics[0]?.reason).toContain("disabled");
    });
});
