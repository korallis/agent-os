import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@agent-os/protocol";
import { AnalyticsService, type SessionSpawnFact } from "../src/analytics/service.js";

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
    // Production shape: readEvents returns only the day-window page (no
    // pre-window session.spawned and no out-of-window usage). Session role
    // comes only from the separate non-windowed spawn lookup.
    const windowEvents: EventEnvelope[] = [
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
          phase: "QUEUED",
          idempotencyKey: null,
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

    const sessionSpawns: SessionSpawnFact[] = [
      {
        sessionId,
        role: "builder",
        model: "openai/gpt-4.1",
        taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      },
    ];

    const service = new AnalyticsService(
      () => ({ events: windowEvents, truncated: false }),
      () => [],
      () => ({ facts: sessionSpawns, truncated: false }),
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
    // Pre-window session.spawned must still attribute in-window usage.
    expect(snap.agents[0]?.role).toBe("builder");
    expect(snap.agents[0]?.costUsd).toBe(0.25);
  });

  it("attributes in-window usage to pre-window sessions via side lookup only", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
    // Window page has usage but no session.spawned (spawn was 20 days ago).
    const windowEvents: EventEnvelope[] = [
      envelope(2, dayOffset(0), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "openai",
          model: "gpt-4.1",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01,
        },
      }),
    ];
    const withoutLookup = new AnalyticsService(
      () => ({ events: windowEvents, truncated: false }),
      () => [],
      () => ({ facts: [], truncated: false }),
    );
    expect(withoutLookup.snapshot({ days: 7 }).agents[0]?.role).toBe("unattributed");

    const withLookup = new AnalyticsService(
      () => ({ events: windowEvents, truncated: false }),
      () => [],
      () => ({
        facts: [
          {
            sessionId,
            role: "validator",
            model: "openai/gpt-4.1",
            taskId: null,
          },
        ],
        truncated: false,
      }),
    );
    expect(withLookup.snapshot({ days: 7 }).agents[0]?.role).toBe("validator");
  });

  it("surfaces spawn-lookup truncation on the snapshot truncated flag", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
    const windowEvents: EventEnvelope[] = [
      envelope(1, dayOffset(0), {
        type: "ext.usage",
        payload: {
          sessionId,
          provider: "openai",
          model: "gpt-4.1",
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        },
      }),
    ];
    const service = new AnalyticsService(
      () => ({ events: windowEvents, truncated: false }),
      () => [],
      () => ({ facts: [], truncated: true }),
    );
    expect(service.snapshot({ days: 7 }).truncated).toBe(true);
  });

  it("tracks partial cost coverage without treating null as zero bill", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
    const events: EventEnvelope[] = [
      envelope(1, dayOffset(0), {
        type: "session.spawned",
        payload: {
          sessionId,
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
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
    expect(snap.models[0]?.requests).toBe(2);
  });

  it("reports absent cost and nullable per-row cost when nothing reported", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
    const events: EventEnvelope[] = [
      envelope(1, dayOffset(0), {
        type: "session.spawned",
        payload: {
          sessionId,
          taskId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
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
