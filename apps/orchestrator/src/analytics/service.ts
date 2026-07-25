import type {
  AnalyticsSnapshot,
  CostCoverage,
  DailyUsagePoint,
  EventEnvelope,
  ModelUsage,
  AgentUsage,
  QuotaSample,
} from "@agent-os/protocol";
import { familyFromModel } from "../substrate/family.js";

export type AnalyticsEventPage = {
  events: EventEnvelope[];
  truncated: boolean;
};

export type SessionSpawnFact = {
  sessionId: string;
  role: string;
  model: string;
  taskId: string | null;
};

export type SessionSpawnPage = {
  facts: SessionSpawnFact[];
  /** True when the spawn lookup hit its bound — older sessions may be unattributed. */
  truncated: boolean;
};

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
  constructor(
    private readonly readEvents: (options: {
      days: number;
      limit: number;
    }) => AnalyticsEventPage,
    private readonly readQuota: () => QuotaSample[],
    private readonly readSessionSpawns: () => SessionSpawnPage = () => ({
      facts: [],
      truncated: false,
    }),
  ) {}

  snapshot(options: { days?: number; limit?: number } = {}): AnalyticsSnapshot {
    const days = options.days ?? 14;
    const limit = options.limit ?? 100_000;
    const { events, truncated } = this.readEvents({ days, limit });
    const windowDays = lastNDays(days);
    const windowSet = new Set(windowDays);

    /** sessionId → its spawn facts, so usage frames can be attributed. */
    const sessions = new Map<string, SessionSpawnFact>();
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

    type CostBucket = {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      costReportedRequests: number;
      requests: number;
    };

    const byDay = new Map<string, CostBucket>();
    const byModel = new Map<string, CostBucket>();
    const byAgent = new Map<string, CostBucket>();

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let costReportedRequests = 0;
    let costMissingRequests = 0;

    for (const envelope of events) {
      if (envelope.event.type !== "ext.usage") continue;
      const day = envelope.ts.slice(0, 10);
      if (!windowSet.has(day)) continue;

      const usage = envelope.event.payload;
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const reported = usage.costUsd !== null && usage.costUsd !== undefined;
      const cost = reported ? (usage.costUsd as number) : 0;

      totalInput += input;
      totalOutput += output;
      if (reported) {
        totalCost += cost;
        costReportedRequests += 1;
      } else {
        costMissingRequests += 1;
      }

      const touch = (bucket: CostBucket): CostBucket => {
        bucket.inputTokens += input;
        bucket.outputTokens += output;
        bucket.requests += 1;
        if (reported) {
          bucket.costUsd += cost;
          bucket.costReportedRequests += 1;
        }
        return bucket;
      };

      const empty = (): CostBucket => ({
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
    }

    // Task throughput per day, from real phase transitions inside the window.
    const createdByDay = new Map<string, number>();
    const completedByDay = new Map<string, number>();
    const failedByDay = new Map<string, number>();
    for (const envelope of events) {
      const day = envelope.ts.slice(0, 10);
      if (!windowSet.has(day)) continue;
      if (envelope.event.type === "task.created") {
        createdByDay.set(day, (createdByDay.get(day) ?? 0) + 1);
      } else if (envelope.event.type === "task.phase_changed") {
        if (envelope.event.payload.to === "DONE") {
          completedByDay.set(day, (completedByDay.get(day) ?? 0) + 1);
        } else if (
          envelope.event.payload.to === "FAILED" ||
          envelope.event.payload.to === "VALIDATION_EXHAUSTED" ||
          envelope.event.payload.to === "CANCELLED"
        ) {
          failedByDay.set(day, (failedByDay.get(day) ?? 0) + 1);
        }
      }
    }

    const daily: DailyUsagePoint[] = windowDays.map((day) => {
      const usage = byDay.get(day);
      return {
        day,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd:
          usage === undefined || usage.costReportedRequests === 0 ? null : usage.costUsd,
        tasksCreated: createdByDay.get(day) ?? 0,
        tasksCompleted: completedByDay.get(day) ?? 0,
      };
    });

    const models: ModelUsage[] = [...byModel.entries()]
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
    const agents: AgentUsage[] = [...byAgent.entries()]
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
    const costCoverage: CostCoverage =
      totalRequests === 0 || costReportedRequests === 0
        ? "absent"
        : costMissingRequests === 0
          ? "complete"
          : "partial";

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
      quota: this.readQuota(),
    };
  }
}

function lastNDays(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
