import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@agent-os/protocol";
import { AnalyticsService } from "../src/analytics/service.js";

function envelope(
  seq: number,
  ts: string,
  event: EventEnvelope["event"],
): EventEnvelope {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, "0")}`,
    seq,
    ts,
    event,
  };
}

function dayOffset(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

describe("AnalyticsService window + cost honesty", () => {
  it("scopes totals/models/agents to the same day window as daily", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const events: EventEnvelope[] = [
      envelope(1, dayOffset(20), {
        type: "session.spawned",
        payload: {
          sessionId,
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          role: "builder",
          model: "openai/gpt-4.1",
          family: "openai",
          tmuxWindow: "w1",
          worktreePath: null,
        },
      }),
      // Outside the 7-day window
      envelope(2, dayOffset(20), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "openai",
          model: "gpt-4.1",
          inputTokens: 9_000,
          outputTokens: 1_000,
          costUsd: 1.5,
        },
      }),
      // Inside the window
      envelope(3, dayOffset(1), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "openai",
          model: "gpt-4.1",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.25,
        },
      }),
      envelope(4, dayOffset(1), {
        type: "task.created",
        payload: {
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
          shape: "SHIP",
          title: "in-window",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
          mode: "local-only",
        },
      }),
      envelope(5, dayOffset(1), {
        type: "task.phase_changed",
        payload: {
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
          from: "BUILDING",
          to: "DONE",
          reason: "delivered",
        },
      }),
    ];

    const service = new AnalyticsService(
      () => ({ events, truncated: false }),
      () => [],
    );
    const snap = service.snapshot({ days: 7 });

    expect(snap.windowDays).toBe(7);
    expect(snap.truncated).toBe(false);
    expect(snap.totals.inputTokens).toBe(100);
    expect(snap.totals.outputTokens).toBe(50);
    expect(snap.totals.costUsd).toBe(0.25);
    expect(snap.totals.costCoverage).toBe("complete");
    expect(snap.totals.requests).toBe(1);
    expect(snap.totals.tasksDone).toBe(1);
    expect(snap.totals.tasksTotal).toBe(1);
    expect(snap.models).toHaveLength(1);
    expect(snap.models[0]?.costUsd).toBe(0.25);
    expect(snap.agents[0]?.role).toBe("builder");
    expect(snap.agents[0]?.costUsd).toBe(0.25);
  });

  it("tracks partial cost coverage without treating null as zero bill", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
    const events: EventEnvelope[] = [
      envelope(1, dayOffset(0), {
        type: "session.spawned",
        payload: {
          sessionId,
          taskId: null,
          role: "builder",
          model: "anthropic/claude-opus",
          family: "anthropic",
          tmuxWindow: "w1",
          worktreePath: null,
        },
      }),
      envelope(2, dayOffset(0), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "anthropic",
          model: "claude-opus",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.1,
        },
      }),
      envelope(3, dayOffset(0), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "anthropic",
          model: "claude-opus",
          inputTokens: 20,
          outputTokens: 5,
          costUsd: null,
        },
      }),
    ];

    const service = new AnalyticsService(
      () => ({ events, truncated: true }),
      () => [],
    );
    const snap = service.snapshot({ days: 3 });

    expect(snap.truncated).toBe(true);
    expect(snap.totals.costCoverage).toBe("partial");
    expect(snap.totals.costReportedRequests).toBe(1);
    expect(snap.totals.costMissingRequests).toBe(1);
    expect(snap.totals.costUsd).toBe(0.1);
    expect(snap.totals.requests).toBe(2);
    expect(snap.models[0]?.costUsd).toBe(0.1);
    expect(snap.models[0]?.costReportedRequests).toBe(1);
  });

  it("reports absent cost and nullable per-row cost when nothing reported", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
    const events: EventEnvelope[] = [
      envelope(1, dayOffset(0), {
        type: "session.spawned",
        payload: {
          sessionId,
          taskId: null,
          role: "validator",
          model: "anthropic/claude-max",
          family: "anthropic",
          tmuxWindow: "w1",
          worktreePath: null,
        },
      }),
      envelope(2, dayOffset(0), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "anthropic",
          model: "claude-max",
          inputTokens: 40,
          outputTokens: 10,
          costUsd: null,
        },
      }),
    ];

    const service = new AnalyticsService(
      () => ({ events, truncated: false }),
      () => [],
    );
    const snap = service.snapshot({ days: 1 });
    expect(snap.totals.costCoverage).toBe("absent");
    expect(snap.totals.costUsd).toBeNull();
    expect(snap.models[0]?.costUsd).toBeNull();
    expect(snap.agents[0]?.costUsd).toBeNull();
  });
});
