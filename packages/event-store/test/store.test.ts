import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@agent-os/protocol";
import { EventStore, readLog } from "../src/index.js";

function configChanged(i: number): OrchestratorEvent {
  return {
    type: "config.changed",
    payload: {
      domain: "supervision",
      layer: "global",
      hotReloaded: true,
      contentHash: `hash-${i}`,
    },
  };
}

describe("EventStore", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentos-store-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appends fsync'd NDJSON envelopes with monotonic seq and ULID ids", () => {
    const { store } = EventStore.open(home);
    const first = store.append(configChanged(1));
    const second = store.append(configChanged(2));
    store.close();

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.id > first.id).toBe(true);

    const lines = readFileSync(join(home, "events", "events.ndjson"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "").seq).toBe(1);
  });

  it("replays the log into the projection on reopen (exactly-once)", () => {
    const opened = EventStore.open(home);
    for (let i = 0; i < 25; i += 1) opened.store.append(configChanged(i));
    opened.store.close();

    const reopened = EventStore.open(home);
    expect(reopened.replayed).toBe(0); // projection already up to date
    expect(reopened.store.count()).toBe(25);
    expect(reopened.store.lastSeq()).toBe(25);
    // Seq continues after restart, no duplicates.
    const next = reopened.store.append(configChanged(99));
    expect(next.seq).toBe(26);
    expect(reopened.store.count()).toBe(26);
    reopened.store.close();
  });

  it("rebuilds the projection from the log when the DB is missing", () => {
    const opened = EventStore.open(home);
    for (let i = 0; i < 10; i += 1) opened.store.append(configChanged(i));
    opened.store.close();

    rmSync(join(home, "agentos.db"));
    rmSync(join(home, "agentos.db-wal"), { force: true });
    rmSync(join(home, "agentos.db-shm"), { force: true });

    const rebuilt = EventStore.open(home);
    expect(rebuilt.replayed).toBe(10);
    expect(rebuilt.store.count()).toBe(10);
    expect(rebuilt.store.configRevisionCount()).toBe(10);
    rebuilt.store.close();
  });

  it("quarantines a corrupt tail instead of failing or dropping bytes", () => {
    const opened = EventStore.open(home);
    for (let i = 0; i < 5; i += 1) opened.store.append(configChanged(i));
    opened.store.close();

    const logPath = join(home, "events", "events.ndjson");
    appendFileSync(logPath, '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","seq":6,"ts":"tr');

    const reopened = EventStore.open(home);
    expect(reopened.quarantinedTail).not.toBeNull();
    expect(reopened.store.count()).toBe(5);
    const quarantineFiles = readdirSync(join(home, "events")).filter((f) =>
      f.startsWith("quarantine-"),
    );
    expect(quarantineFiles).toHaveLength(1);
    // The quarantined bytes are preserved verbatim.
    const quarantined = readFileSync(join(home, "events", quarantineFiles[0] ?? ""), "utf8");
    expect(quarantined).toContain('"seq":6');
    // The log itself is clean again.
    expect(readLog(logPath).corruptTailOffset).toBeNull();
    // And appends continue from the clean seq.
    expect(reopened.store.append(configChanged(6)).seq).toBe(6);
    reopened.store.close();
  });

  it("supports Last-Event-ID style replay by ULID cursor", () => {
    const { store } = EventStore.open(home);
    const envelopes = Array.from({ length: 10 }, (_, i) => store.append(configChanged(i)));
    const cursor = envelopes[4]?.id ?? null;
    const { events, truncated } = store.eventsAfterId(cursor, 100);
    expect(events).toHaveLength(5);
    expect(events[0]?.seq).toBe(6);
    expect(truncated).toBe(false);

    const limited = store.eventsAfterId(null, 3);
    expect(limited.events).toHaveLength(3);
    expect(limited.truncated).toBe(true);

    // Unknown cursor replays from the beginning (safe default).
    const unknown = store.eventsAfterId("01ARZ3NDEKTSV4RRFFQ69G5FAV", 100);
    expect(unknown.events).toHaveLength(10);
    store.close();
  });

  it("supports newest-first reverse scan with truncation", () => {
    const { store } = EventStore.open(home);
    const envelopes = Array.from({ length: 10 }, (_, i) => store.append(configChanged(i)));
    const newest = store.eventsBeforeId(null, 3);
    expect(newest.events).toHaveLength(3);
    expect(newest.truncated).toBe(true);
    expect(newest.events.map((e) => e.seq)).toEqual([10, 9, 8]);

    const page2 = store.eventsBeforeId(newest.events[2]?.id ?? null, 3);
    expect(page2.events.map((e) => e.seq)).toEqual([7, 6, 5]);

    const since = envelopes[0]?.ts ?? new Date(0).toISOString();
    const windowed = store.eventsSince(since, 4);
    expect(windowed.events).toHaveLength(4);
    expect(windowed.truncated).toBe(true);
    // Newest-first: truncation drops the oldest in-window frames.
    expect(windowed.events.map((e) => e.seq)).toEqual([10, 9, 8, 7]);
    expect(store.countSince(since)).toBe(10);
    store.close();
  });

  it("fans out appended events to subscribers", () => {
    const { store } = EventStore.open(home);
    const seen: number[] = [];
    const unsubscribe = store.subscribe((envelope) => seen.push(envelope.seq));
    store.append(configChanged(1));
    store.append(configChanged(2));
    unsubscribe();
    store.append(configChanged(3));
    expect(seen).toEqual([1, 2]);
    store.close();
  });

  it("returns task-scoped events with truncation meaningful for that task", () => {
    const { store } = EventStore.open(home);
    const taskA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const taskB = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const toolInvoked = (taskId: string, i: number): OrchestratorEvent => ({
      type: "tool.invoked",
      payload: {
        invocationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        tool: "create_task",
        taskId,
        ok: true,
        errorCode: null,
        durationMs: i,
      },
    });
    // Noise without taskId + frames for another task must not pollute task A.
    for (let i = 0; i < 5; i++) store.append(configChanged(i));
    for (let i = 0; i < 3; i++) store.append(toolInvoked(taskB, i));
    for (let i = 0; i < 4; i++) store.append(toolInvoked(taskA, i));

    const all = store.eventsForTask(taskA, ["tool.invoked"], 10);
    expect(all.events).toHaveLength(4);
    expect(all.truncated).toBe(false);
    expect(all.events.every((e) => e.event.type === "tool.invoked")).toBe(true);
    expect(
      all.events.every((e) => {
        if (e.event.type !== "tool.invoked") return false;
        return e.event.payload.taskId === taskA;
      }),
    ).toBe(true);
    // Chronological order (oldest first).
    expect(
      all.events.map((e) =>
        e.event.type === "tool.invoked" ? e.event.payload.durationMs : -1,
      ),
    ).toEqual([0, 1, 2, 3]);

    const limited = store.eventsForTask(taskA, ["tool.invoked"], 2);
    expect(limited.events).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    // Truncation keeps newest frames for this task.
    expect(
      limited.events.map((e) =>
        e.event.type === "tool.invoked" ? e.event.payload.durationMs : -1,
      ),
    ).toEqual([2, 3]);

    const empty = store.eventsForTask("01ARZ3NDEKTSV4RRFFQ69G5FC1", null, 10);
    expect(empty.events).toHaveLength(0);
    expect(empty.truncated).toBe(false);
    store.close();
  });

  it("aggregateRunHistory counts gate/fusion per task and ignores chatty noise", () => {
    const { store } = EventStore.open(home);
    const taskA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const taskB = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    store.append({
      type: "task.created",
      payload: {
        taskId: taskA,
        shape: "SHIP",
        title: "A",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        mode: "local-only",
        phase: "QUEUED",
        idempotencyKey: null,
      },
    });
    // Chatty usage frames must not enter run-history aggregates.
    store.append({
      type: "ext.usage",
      payload: {
        sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        provider: "anthropic",
        model: "claude",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      },
    });
    store.append({
      type: "gate.result",
      payload: {
        taskId: taskA,
        target: "candidate",
        outcome: "FAIL",
        attempt: 1,
        outputHash: null,
      },
    });
    store.append({
      type: "gate.result",
      payload: {
        taskId: taskA,
        target: "candidate",
        outcome: "GATE_ERROR",
        attempt: 2,
        outputHash: null,
      },
    });
    store.append({
      type: "fusion.dispatched",
      payload: {
        taskId: taskA,
        kind: "fusion",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      },
    });
    store.append({
      type: "gate.result",
      payload: {
        taskId: taskB,
        target: "baseline",
        outcome: "PASS",
        attempt: 0,
        outputHash: "abc",
      },
    });

    const rows = store.aggregateRunHistory();
    const a = rows.find((r) => r.taskId === taskA);
    const b = rows.find((r) => r.taskId === taskB);
    expect(a).toMatchObject({
      gateRuns: 2,
      gateFailures: 1,
      gateErrors: 1,
      fusionRuns: 1,
    });
    expect(a?.firstSeen).not.toBeNull();
    expect(a?.lastSeen).not.toBeNull();
    expect(a!.firstSeen! <= a!.lastSeen!).toBe(true);
    expect(b).toMatchObject({
      gateRuns: 1,
      gateFailures: 0,
      gateErrors: 0,
      fusionRuns: 0,
    });
    // Usage frames are not attributed to any task in this aggregate.
    expect(rows).toHaveLength(2);
    store.close();
  });
});
