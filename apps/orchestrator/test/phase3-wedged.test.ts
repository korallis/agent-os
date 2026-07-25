import { describe, expect, it } from "vitest";

/**
 * Structural WEDGED ladder (master plan §11 Phase 3).
 *
 * The distinction under test is the one that matters operationally: a wedged
 * seat's pane is ALIVE, so it passes every liveness check while producing
 * nothing. That is why it needs its own detector rather than riding on the
 * SESSION_LOST path, and why the ladder must be bounded — respawning forever
 * turns a wedged model into unbounded spend.
 */

interface Session {
  sessionId: string;
  taskId: string | null;
  role: string;
  status: string;
  tmuxWindow: string;
  startedAt: string;
  lastActivityAt: string | null;
}

/** Mirrors the ladder in ToolSurface.reconcileWedgedSessions. */
function ladder(input: {
  sessions: Session[];
  paneAlive: (window: string) => boolean;
  thresholdMinutes: number;
  respawnCap: number;
  ledger: Map<string, number>;
  now: number;
}): Array<{ sessionId: string; action: string; idleMinutes: number }> {
  const acted: Array<{ sessionId: string; action: string; idleMinutes: number }> = [];
  for (const session of input.sessions) {
    if (session.status !== "running" && session.status !== "starting") continue;
    if (!input.paneAlive(session.tmuxWindow)) continue;
    const since = session.lastActivityAt ?? session.startedAt;
    const idleMinutes = (input.now - Date.parse(since)) / 60_000;
    if (idleMinutes < input.thresholdMinutes) continue;
    const key = `${session.taskId ?? "none"}:${session.role}`;
    const used = input.ledger.get(key) ?? 0;
    const action = used < input.respawnCap ? "respawned" : "escalated";
    if (action === "respawned") input.ledger.set(key, used + 1);
    acted.push({ sessionId: session.sessionId, action, idleMinutes });
  }
  return acted;
}

const now = Date.parse("2026-07-25T12:00:00.000Z");
const session = (over: Partial<Session> = {}): Session => ({
  sessionId: "01SESSION0000000000000001",
  taskId: "01TASK00000000000000000001",
  role: "builder",
  status: "running",
  tmuxWindow: "agentos:builder-01",
  startedAt: new Date(now - 60 * 60_000).toISOString(),
  lastActivityAt: new Date(now - 60 * 60_000).toISOString(),
  ...over,
});

describe("structural WEDGED ladder", () => {
  it("does not fire while the seat is still producing activity", () => {
    const acted = ladder({
      sessions: [session({ lastActivityAt: new Date(now - 2 * 60_000).toISOString() })],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger: new Map(),
      now,
    });
    expect(acted).toHaveLength(0);
  });

  it("ignores a seat whose pane is GONE — that is SESSION_LOST, not wedged", () => {
    // Conflating the two would tell the Captain the wrong thing about the fleet.
    const acted = ladder({
      sessions: [session()],
      paneAlive: () => false,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger: new Map(),
      now,
    });
    expect(acted).toHaveLength(0);
  });

  it("respawns once on the first wedge", () => {
    const ledger = new Map<string, number>();
    const acted = ladder({
      sessions: [session()],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger,
      now,
    });
    expect(acted[0]?.action).toBe("respawned");
    expect(ledger.get("01TASK00000000000000000001:builder")).toBe(1);
  });

  it("escalates on the second wedge instead of respawning forever", () => {
    const ledger = new Map<string, number>([["01TASK00000000000000000001:builder", 1]]);
    const acted = ladder({
      sessions: [session()],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger,
      now,
    });
    // A second wedge on the same role is far more likely the task than the seat.
    expect(acted[0]?.action).toBe("escalated");
    expect(ledger.get("01TASK00000000000000000001:builder")).toBe(1);
  });

  it("treats a seat that never reported anything as idle since spawn", () => {
    // lastActivityAt null must not read as "active now" — that would hide the
    // seat that wedged immediately on spawn, the worst case of all.
    const acted = ladder({
      sessions: [session({ lastActivityAt: null })],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger: new Map(),
      now,
    });
    expect(acted).toHaveLength(1);
    expect(acted[0]?.idleMinutes).toBeGreaterThanOrEqual(60);
  });

  it("keeps the ladder per task+role, not global", () => {
    const ledger = new Map<string, number>([["01TASK00000000000000000001:builder", 1]]);
    const acted = ladder({
      sessions: [
        session({ sessionId: "01SESSION0000000000000001", role: "builder" }),
        session({ sessionId: "01SESSION0000000000000002", role: "validator" }),
      ],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 1,
      ledger,
      now,
    });
    // Builder is out of respawns; validator has its own budget.
    expect(acted.find((a) => a.sessionId.endsWith("1"))?.action).toBe("escalated");
    expect(acted.find((a) => a.sessionId.endsWith("2"))?.action).toBe("respawned");
  });

  it("honours a respawn cap of zero by escalating immediately", () => {
    const acted = ladder({
      sessions: [session()],
      paneAlive: () => true,
      thresholdMinutes: 30,
      respawnCap: 0,
      ledger: new Map(),
      now,
    });
    expect(acted[0]?.action).toBe("escalated");
  });
});
