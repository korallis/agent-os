import type {
  AnalyticsSnapshot,
  DailyUsagePoint,
  EventEnvelope,
  ModelUsage,
  AgentUsage,
  QuotaSample,
  TaskSnapshot,
} from "@agent-os/protocol";
import { familyFromModel } from "../substrate/family.js";

/**
 * Usage & cost analytics (master plan §7.6 "Analytics").
 *
 * Every figure is DERIVED from the append-only event log and the live task
 * store — there are no sampled estimates and no placeholder series. When a
 * number cannot be derived it is reported as null and the Console renders the
 * absence, rather than a plausible-looking invention.
 *
 * `ext.usage` frames carry per-request tokens and (where the provider reports
 * it) cost, keyed by session; `session.spawned` maps a session to its role,
 * model and task. Joining the two gives per-model and per-agent attribution
 * without asking any model to self-report.
 */
export class AnalyticsService {
  /**
   * @param readEvents pulls the durable log (bounded); the daemon passes a
   * reader over the event store so this module stays I/O-free and testable.
   */
  constructor(
    private readonly readEvents: (limit: number) => EventEnvelope[],
    private readonly readTasks: () => TaskSnapshot[],
    private readonly readQuota: () => QuotaSample[],
  ) {}

  snapshot(options: { days?: number; limit?: number } = {}): AnalyticsSnapshot {
    const days = options.days ?? 14;
    const events = this.readEvents(options.limit ?? 100_000);
    const tasks = this.readTasks();

    /** sessionId → its spawn facts, so usage frames can be attributed. */
    const sessions = new Map<
      string,
      { role: string; model: string; taskId: string | null }
    >();
    for (const envelope of events) {
      if (envelope.event.type === "session.spawned") {
        sessions.set(envelope.event.payload.sessionId, {
          role: envelope.event.payload.role,
          model: envelope.event.payload.model,
          taskId: envelope.event.payload.taskId,
        });
      }
    }

    const byDay = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>();
    const byModel = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; requests: number }>();
    const byAgent = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; requests: number }>();

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let costReported = false;

    for (const envelope of events) {
      if (envelope.event.type !== "ext.usage") continue;
      const usage = envelope.event.payload;
      const day = envelope.ts.slice(0, 10);
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      // Providers differ on whether they report cost; track whether ANY did so
      // the Console can distinguish "zero spend" from "cost not reported".
      const cost = usage.costUsd ?? 0;
      if (usage.costUsd !== null) costReported = true;

      totalInput += input;
      totalOutput += output;
      totalCost += cost;

      const dayBucket = byDay.get(day) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      dayBucket.inputTokens += input;
      dayBucket.outputTokens += output;
      dayBucket.costUsd += cost;
      byDay.set(day, dayBucket);

      const modelKey = `${usage.provider}/${usage.model}`;
      const modelBucket = byModel.get(modelKey) ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        requests: 0,
      };
      modelBucket.inputTokens += input;
      modelBucket.outputTokens += output;
      modelBucket.costUsd += cost;
      modelBucket.requests += 1;
      byModel.set(modelKey, modelBucket);

      const role = sessions.get(usage.sessionId)?.role ?? "unattributed";
      const agentBucket = byAgent.get(role) ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        requests: 0,
      };
      agentBucket.inputTokens += input;
      agentBucket.outputTokens += output;
      agentBucket.costUsd += cost;
      agentBucket.requests += 1;
      byAgent.set(role, agentBucket);
    }

    // Task throughput per day, from real phase transitions.
    const createdByDay = new Map<string, number>();
    const completedByDay = new Map<string, number>();
    for (const envelope of events) {
      if (envelope.event.type === "task.created") {
        const day = envelope.ts.slice(0, 10);
        createdByDay.set(day, (createdByDay.get(day) ?? 0) + 1);
      } else if (
        envelope.event.type === "task.phase_changed" &&
        envelope.event.payload.to === "DONE"
      ) {
        const day = envelope.ts.slice(0, 10);
        completedByDay.set(day, (completedByDay.get(day) ?? 0) + 1);
      }
    }

    const daily: DailyUsagePoint[] = lastNDays(days).map((day) => {
      const usage = byDay.get(day);
      return {
        day,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage?.costUsd ?? 0,
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
        costUsd: v.costUsd,
        requests: v.requests,
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
          costUsd: v.costUsd,
          requests: v.requests,
          sharePct: totalTokens === 0 ? 0 : Number(((tokens / totalTokens) * 100).toFixed(1)),
        };
      })
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    const done = tasks.filter((t) => t.phase === "DONE").length;
    const failed = tasks.filter((t) => t.phase === "FAILED").length;
    const terminal = done + failed;

    return {
      generatedAt: new Date().toISOString(),
      windowDays: days,
      totals: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        // Distinguish "no provider reported cost" from "spend was zero".
        costUsd: costReported ? totalCost : null,
        requests: models.reduce((sum, m) => sum + m.requests, 0),
        tasksTotal: tasks.length,
        tasksDone: done,
        tasksFailed: failed,
        successRatePct: terminal === 0 ? null : Number(((done / terminal) * 100).toFixed(1)),
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
