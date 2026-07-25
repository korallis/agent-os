import { familyFromModel } from "../substrate/family.js";
/**
 * Usage & cost analytics (master plan §7 Token Usage / §8.2 `GET /v1/analytics`).
 *
 * Every figure is DERIVED from the append-only event log — there are no sampled
 * estimates and no placeholder series. When a number cannot be derived it is
 * reported as null and the Console renders the absence, rather than a
 * plausible-looking invention.
 *
 * All aggregates (totals, models, agents, daily) share the same day window.
 * Cost is tracked as reported-vs-missing per bucket so a Claude Max
 * subscription that contributes null cost never silently reads as $0.00.
 *
 * Role attribution uses a separate (not day-filtered) session.spawned lookup
 * so long-lived sessions spawned before the window still bucket correctly.
 */
export class AnalyticsService {
    readEvents;
    readQuota;
    readSessionSpawns;
    readConnectionBilling;
    /**
     * @param readEvents pulls a time-bounded page of the durable log; the daemon
     *   passes a reader that scans newest-first from the window start and surfaces
     *   truncation when the bound is hit (oldest in-window frames dropped).
     * @param readQuota live quota samples (not windowed — current fleet state).
     * @param readSessionSpawns session.spawned facts outside the day filter, so
     *   in-window usage from pre-window sessions is attributed to the real role.
     *   Must surface truncation when the lookup bound is hit — silent caps would
     *   bucket older sessions as unattributed while the role table looks complete.
     */
    constructor(readEvents, readQuota, readSessionSpawns = () => ({
        facts: [],
        truncated: false,
    }), 
    /**
     * Connection billing facts, used to bucket spend by billing surface. With
     * no reader every request buckets as `unattributed`, which is honest — the
     * surface is genuinely unknown, not `api-metered` by assumption.
     */
    readConnectionBilling = () => []) {
        this.readEvents = readEvents;
        this.readQuota = readQuota;
        this.readSessionSpawns = readSessionSpawns;
        this.readConnectionBilling = readConnectionBilling;
    }
    snapshot(options = {}) {
        const days = options.days ?? 14;
        const limit = options.limit ?? 100_000;
        const { events, truncated } = this.readEvents({ days, limit });
        const windowDays = lastNDays(days);
        const windowSet = new Set(windowDays);
        /** sessionId → its spawn facts, so usage frames can be attributed. */
        const sessions = new Map();
        // Side lookup first: covers sessions spawned before the analytics window.
        const spawnPage = this.readSessionSpawns();
        for (const spawn of spawnPage.facts) {
            sessions.set(spawn.sessionId, spawn);
        }
        // Overlay any in-window spawns (same shape as production dual-read).
        for (const envelope of events) {
            if (envelope.event.type === "session.spawned") {
                sessions.set(envelope.event.payload.sessionId, {
                    sessionId: envelope.event.payload.sessionId,
                    role: envelope.event.payload.role,
                    model: envelope.event.payload.model,
                    taskId: envelope.event.payload.taskId,
                });
            }
        }
        const byDay = new Map();
        const byModel = new Map();
        const byAgent = new Map();
        const bySurface = new Map();
        const byBrain = new Map();
        /**
         * provider → billing surface. A provider with two connections on different
         * surfaces is genuinely ambiguous for a usage frame that only names the
         * provider, so it buckets as unattributed rather than guessing one.
         */
        const surfaceByProvider = new Map();
        for (const fact of this.readConnectionBilling()) {
            const existing = surfaceByProvider.get(fact.provider);
            if (existing === undefined) {
                surfaceByProvider.set(fact.provider, fact.billingSurface);
            }
            else if (existing !== fact.billingSurface) {
                surfaceByProvider.set(fact.provider, "ambiguous");
            }
        }
        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        let costReportedRequests = 0;
        let costMissingRequests = 0;
        for (const envelope of events) {
            if (envelope.event.type !== "ext.usage")
                continue;
            const day = envelope.ts.slice(0, 10);
            if (!windowSet.has(day))
                continue;
            const usage = envelope.event.payload;
            const input = usage.inputTokens ?? 0;
            const output = usage.outputTokens ?? 0;
            const reported = usage.costUsd !== null && usage.costUsd !== undefined;
            const cost = reported ? usage.costUsd : 0;
            totalInput += input;
            totalOutput += output;
            if (reported) {
                totalCost += cost;
                costReportedRequests += 1;
            }
            else {
                costMissingRequests += 1;
            }
            const touch = (bucket) => {
                bucket.inputTokens += input;
                bucket.outputTokens += output;
                bucket.requests += 1;
                if (reported) {
                    bucket.costUsd += cost;
                    bucket.costReportedRequests += 1;
                }
                return bucket;
            };
            const empty = () => ({
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                costReportedRequests: 0,
                requests: 0,
            });
            byDay.set(day, touch(byDay.get(day) ?? empty()));
            const modelKey = `${usage.provider}/${usage.model}`;
            byModel.set(modelKey, touch(byModel.get(modelKey) ?? empty()));
            const role = sessions.get(usage.sessionId)?.role ?? "unattributed";
            byAgent.set(role, touch(byAgent.get(role) ?? empty()));
            const resolved = surfaceByProvider.get(usage.provider);
            const surface = resolved === undefined || resolved === "ambiguous" ? "unattributed" : resolved;
            bySurface.set(surface, touch(bySurface.get(surface) ?? empty()));
            // The Brain orchestrates and never edits; separating its tokens is the
            // only way the Captain can see orchestration overhead as its own line.
            const lane = role === "brain" ? "brain" : "crew";
            byBrain.set(lane, touch(byBrain.get(lane) ?? empty()));
        }
        // Task throughput per day, from real phase transitions inside the window.
        const createdByDay = new Map();
        const completedByDay = new Map();
        const failedByDay = new Map();
        for (const envelope of events) {
            const day = envelope.ts.slice(0, 10);
            if (!windowSet.has(day))
                continue;
            if (envelope.event.type === "task.created") {
                createdByDay.set(day, (createdByDay.get(day) ?? 0) + 1);
            }
            else if (envelope.event.type === "task.phase_changed") {
                if (envelope.event.payload.to === "DONE") {
                    completedByDay.set(day, (completedByDay.get(day) ?? 0) + 1);
                }
                else if (envelope.event.payload.to === "FAILED" ||
                    envelope.event.payload.to === "VALIDATION_EXHAUSTED" ||
                    envelope.event.payload.to === "CANCELLED") {
                    failedByDay.set(day, (failedByDay.get(day) ?? 0) + 1);
                }
            }
        }
        const daily = windowDays.map((day) => {
            const usage = byDay.get(day);
            return {
                day,
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                costUsd: usage === undefined || usage.costReportedRequests === 0 ? null : usage.costUsd,
                tasksCreated: createdByDay.get(day) ?? 0,
                tasksCompleted: completedByDay.get(day) ?? 0,
            };
        });
        const models = [...byModel.entries()]
            .map(([model, v]) => ({
            model,
            family: familyFromModel(model),
            inputTokens: v.inputTokens,
            outputTokens: v.outputTokens,
            costUsd: v.costReportedRequests === 0 ? null : v.costUsd,
            requests: v.requests,
            costReportedRequests: v.costReportedRequests,
        }))
            .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
        const totalTokens = totalInput + totalOutput;
        const agents = [...byAgent.entries()]
            .map(([role, v]) => {
            const tokens = v.inputTokens + v.outputTokens;
            return {
                role,
                inputTokens: v.inputTokens,
                outputTokens: v.outputTokens,
                costUsd: v.costReportedRequests === 0 ? null : v.costUsd,
                requests: v.requests,
                costReportedRequests: v.costReportedRequests,
                sharePct: totalTokens === 0 ? 0 : Number(((tokens / totalTokens) * 100).toFixed(1)),
            };
        })
            .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
        const tasksDone = [...completedByDay.values()].reduce((a, b) => a + b, 0);
        const tasksFailed = [...failedByDay.values()].reduce((a, b) => a + b, 0);
        const tasksTotal = [...createdByDay.values()].reduce((a, b) => a + b, 0);
        const terminal = tasksDone + tasksFailed;
        const totalRequests = costReportedRequests + costMissingRequests;
        const costCoverage = totalRequests === 0 || costReportedRequests === 0
            ? "absent"
            : costMissingRequests === 0
                ? "complete"
                : "partial";
        const billingSurfaces = [...bySurface.entries()]
            .map(([surface, v]) => ({
            surface,
            inputTokens: v.inputTokens,
            outputTokens: v.outputTokens,
            costUsd: v.costReportedRequests === 0 ? null : v.costUsd,
            requests: v.requests,
            costReportedRequests: v.costReportedRequests,
        }))
            .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
        const brainBucket = byBrain.get("brain");
        const crewBucket = byBrain.get("crew");
        const brainTokens = (brainBucket?.inputTokens ?? 0) + (brainBucket?.outputTokens ?? 0);
        const brain = {
            brainInputTokens: brainBucket?.inputTokens ?? 0,
            brainOutputTokens: brainBucket?.outputTokens ?? 0,
            brainCostUsd: brainBucket === undefined || brainBucket.costReportedRequests === 0
                ? null
                : brainBucket.costUsd,
            brainRequests: brainBucket?.requests ?? 0,
            crewInputTokens: crewBucket?.inputTokens ?? 0,
            crewOutputTokens: crewBucket?.outputTokens ?? 0,
            crewCostUsd: crewBucket === undefined || crewBucket.costReportedRequests === 0
                ? null
                : crewBucket.costUsd,
            crewRequests: crewBucket?.requests ?? 0,
            brainSharePct: totalTokens === 0 ? 0 : Number(((brainTokens / totalTokens) * 100).toFixed(1)),
        };
        /**
         * Every breakdown came from the same single pass over the same events, so
         * each must sum back to the totals exactly. Tokens and request counts are
         * integers — an exact comparison is correct and any mismatch is a real bug.
         * Cost is float-summed, so it reconciles within a sub-cent epsilon.
         */
        const sumTokens = (entries) => ({
            input: entries.reduce((a, e) => a + e.inputTokens, 0),
            output: entries.reduce((a, e) => a + e.outputTokens, 0),
        });
        const matches = (entries) => {
            const summed = sumTokens(entries);
            return summed.input === totalInput && summed.output === totalOutput;
        };
        const reconcile = {
            modelsMatchTotals: matches(models),
            agentsMatchTotals: matches(agents),
            dailyMatchTotals: matches(daily),
            billingSurfacesMatchTotals: matches(billingSurfaces),
            brainPlusCrewMatchTotals: brain.brainInputTokens + brain.crewInputTokens === totalInput &&
                brain.brainOutputTokens + brain.crewOutputTokens === totalOutput,
            exact: false,
        };
        reconcile.exact =
            reconcile.modelsMatchTotals &&
                reconcile.agentsMatchTotals &&
                reconcile.dailyMatchTotals &&
                reconcile.billingSurfacesMatchTotals &&
                reconcile.brainPlusCrewMatchTotals;
        return {
            generatedAt: new Date().toISOString(),
            windowDays: days,
            truncated: truncated || spawnPage.truncated,
            totals: {
                inputTokens: totalInput,
                outputTokens: totalOutput,
                costUsd: costReportedRequests === 0 ? null : totalCost,
                costCoverage,
                costReportedRequests,
                costMissingRequests,
                requests: totalRequests,
                tasksTotal,
                tasksDone,
                tasksFailed,
                successRatePct: terminal === 0 ? null : Number(((tasksDone / terminal) * 100).toFixed(1)),
            },
            daily,
            models,
            agents,
            billingSurfaces,
            brain,
            reconcile,
            quota: this.readQuota(),
        };
    }
}
function lastNDays(days) {
    const out = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}
