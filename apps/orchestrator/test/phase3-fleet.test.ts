import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.js";
import { familyFromModel } from "../src/substrate/family.js";
import { canTransition, assertTransition, IllegalTransitionError } from "../src/substrate/task-machine.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentos-repo-"));
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  return dir;
}

describe("family classification [R6]", () => {
  it("maps claude-agent-sdk/* to anthropic", () => {
    expect(familyFromModel("claude-agent-sdk/claude-sonnet-4-5")).toBe("anthropic");
    expect(familyFromModel("anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(familyFromModel("openai/gpt-4.1")).toBe("openai");
  });
});

describe("task state machine", () => {
  it("allows QUEUED → DISPATCH_RESOLVED", () => {
    expect(canTransition("QUEUED", "DISPATCH_RESOLVED")).toBe(true);
  });

  it("rejects run_gate-style illegal BUILDING ← GATE_AUTHORING skip when asserted wrong", () => {
    expect(() => assertTransition("t1", "QUEUED", "VALIDATING")).toThrow(IllegalTransitionError);
  });
});

describe("phase 3 fleet integration", () => {
  it("create_task, resolve_cast policy, scripted local-only SHIP", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentos-p3-"));
    homes.push(home);
    const repo = fixtureRepo();
    homes.push(repo);

    process.env.AGENTOS_FAKE_TMUX = "1";
    process.env.AGENTOS_FAKE_PI = "1";
    process.env.AGENTOS_FAKE_BRAIN = "1";
    process.env.AGENTOS_FAKE_GIT = "1";
    process.env.AGENTOS_FAKE_GATE = "1";

    const daemon = await startDaemon({ home, port: 0, stdout: false });
    try {
      const token = daemon.token;
      const base = `http://127.0.0.1:${daemon.port}`;

      const projectRes = await fetch(`${base}/v1/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "fixture", path: repo, mode: "local-only", trusted: true }),
      });
      expect(projectRes.ok).toBe(true);
      const projectBody = (await projectRes.json()) as { project: { id: string } };
      const projectId = projectBody.project.id;

      const taskRes = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          spec: {
            shape: "SHIP",
            title: "Local ship",
            intent: "make a tiny change",
            projectId,
            mode: "local-only",
            yolo: true,
          },
          idempotencyKey: "ship-1",
        }),
      });
      expect(taskRes.ok).toBe(true);
      const taskBody = (await taskRes.json()) as { task: { id: string; phase: string } };
      expect(taskBody.task.phase).toBe("QUEUED");

      // Illegal: run_gate before GATE_AUTHORING
      const illegal = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "run_gate",
          input: { taskId: taskBody.task.id, target: "baseline" },
        }),
      });
      const illegalBody = (await illegal.json()) as {
        ok: boolean;
        error?: { code: string };
      };
      expect(illegalBody.ok).toBe(false);
      expect(illegalBody.error?.code).toBe("ILLEGAL_TRANSITION");

      // Same-family builder/validator → POLICY_VIOLATION
      const policy = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "resolve_cast",
          input: {
            taskId: taskBody.task.id,
            roles: [
              {
                role: "builder",
                model: "claude-agent-sdk/claude-sonnet-4-5",
                thinking: "medium",
                cleanRoom: true,
              },
              {
                role: "validator",
                model: "anthropic/claude-sonnet-4-5",
                thinking: "medium",
                cleanRoom: true,
              },
            ],
            familyCheckOverride: false,
          },
        }),
      });
      const policyBody = (await policy.json()) as { ok: boolean; error?: { code: string } };
      expect(policyBody.ok).toBe(false);
      expect(policyBody.error?.code).toBe("POLICY_VIOLATION");

      // Scripted local-only path via tool surface
      const cast = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "resolve_cast",
          input: {
            taskId: taskBody.task.id,
            roles: [
              {
                role: "builder",
                model: "openai/gpt-4.1",
                thinking: "medium",
                cleanRoom: true,
              },
            ],
            familyCheckOverride: false,
          },
        }),
      });
      expect(((await cast.json()) as { ok: boolean }).ok).toBe(true);

      const spawn = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "spawn_crewmate",
          input: {
            taskId: taskBody.task.id,
            role: "builder",
            model: "openai/gpt-4.1",
            thinking: "medium",
            cleanRoom: true,
            vars: {},
          },
        }),
      });
      expect(((await spawn.json()) as { ok: boolean }).ok).toBe(true);

      const deliver = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "deliver_task",
          input: { taskId: taskBody.task.id },
        }),
      });
      const deliverBody = (await deliver.json()) as {
        ok: boolean;
        data?: { phase: string; branch: string | null };
      };
      expect(deliverBody.ok).toBe(true);
      expect(deliverBody.data?.phase).toBe("DONE");
      expect(deliverBody.data?.branch?.startsWith("ao/")).toBe(true);

      // tool.invoked events persisted
      const { events } = daemon.store.eventsAfterId(null, 10_000);
      const toolEvents = events.filter((e) => e.event.type === "tool.invoked");
      expect(toolEvents.length).toBeGreaterThan(0);

      // fleet summary
      const fleet = await fetch(`${base}/v1/fleet`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(fleet.ok).toBe(true);
      const fleetBody = (await fleet.json()) as {
        summary: { brain: { status: string }; doneToday: number };
      };
      expect(fleetBody.summary.brain.status).toBe("running");
      expect(fleetBody.summary.doneToday).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.close();
      delete process.env.AGENTOS_FAKE_TMUX;
      delete process.env.AGENTOS_FAKE_PI;
      delete process.env.AGENTOS_FAKE_BRAIN;
      delete process.env.AGENTOS_FAKE_GIT;
      delete process.env.AGENTOS_FAKE_GATE;
    }
  }, 30_000);

  it("BRAIN_DOWN queues wakes and blocks orchestration tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentos-p3-bd-"));
    homes.push(home);
    // Pre-write brain config with respawnBlocked before daemon starts
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "brain.json5"),
      `{ cast: "auto", thinking: "high", preferenceOrder: ["best-available via any api-key"], handoff: { thresholdPct: 80, target: "same-family-api-key" }, respawnBlocked: true }\n`,
    );

    process.env.AGENTOS_FAKE_TMUX = "1";
    process.env.AGENTOS_FAKE_PI = "1";
    process.env.AGENTOS_FAKE_BRAIN = "1";

    const daemon = await startDaemon({ home, port: 0, stdout: false });
    try {
      const token = daemon.token;
      const base = `http://127.0.0.1:${daemon.port}`;

      const brain = await fetch(`${base}/v1/brain`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const brainBody = (await brain.json()) as { brain: { status: string } };
      expect(brainBody.brain.status).toBe("down");

      // spawn_crewmate should fail with BRAIN_DOWN (needs a task first — create is allowed for captain)
      const repo = fixtureRepo();
      homes.push(repo);
      const projectRes = await fetch(`${base}/v1/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "p", path: repo, mode: "local-only" }),
      });
      const projectId = ((await projectRes.json()) as { project: { id: string } }).project.id;
      const taskRes = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          spec: {
            shape: "SHIP",
            title: "t",
            intent: "i",
            projectId,
            mode: "local-only",
            yolo: false,
          },
        }),
      });
      const taskId = ((await taskRes.json()) as { task: { id: string } }).task.id;

      const spawn = await fetch(`${base}/v1/tools/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "spawn_crewmate",
          input: {
            taskId,
            role: "builder",
            model: "openai/gpt-4.1",
            thinking: "low",
            vars: {},
          },
        }),
      });
      const spawnBody = (await spawn.json()) as { ok: boolean; error?: { code: string } };
      expect(spawnBody.ok).toBe(false);
      expect(spawnBody.error?.code).toBe("BRAIN_DOWN");
    } finally {
      await daemon.close();
      delete process.env.AGENTOS_FAKE_TMUX;
      delete process.env.AGENTOS_FAKE_PI;
      delete process.env.AGENTOS_FAKE_BRAIN;
    }
  }, 30_000);

  it("zero-token absorb: PROGRESS wakes do not deliver to brain", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentos-p3-wake-"));
    homes.push(home);
    process.env.AGENTOS_FAKE_TMUX = "1";
    process.env.AGENTOS_FAKE_PI = "1";
    process.env.AGENTOS_FAKE_BRAIN = "1";

    const daemon = await startDaemon({ home, port: 0, stdout: false });
    try {
      // Access fleet through a tool call that creates nothing — use internal via events
      // Direct classify via reading wake history after injecting through tools isn't exposed;
      // unit-test watcher via fleet state by posting a synthetic path:
      const { FleetService } = await import("../src/fleet/service.js");
      const fleet = new FleetService({
        home: mkdtempSync(join(tmpdir(), "agentos-wake-unit-")),
        config: daemon.config,
        fakeTmux: true,
        fakePi: true,
        fakeBrain: true,
      });
      const absorbed = fleet.watcher.classify({
        class: "PROGRESS",
        summary: "still working",
        taskId: null,
      });
      expect(absorbed.absorbed).toBe(true);
      expect(absorbed.deliveredToBrain).toBe(false);

      const actionable = fleet.watcher.classify({
        class: "NEEDS_INPUT",
        summary: "ask captain",
      });
      expect(actionable.absorbed).toBe(false);
    } finally {
      await daemon.close();
      delete process.env.AGENTOS_FAKE_TMUX;
      delete process.env.AGENTOS_FAKE_PI;
      delete process.env.AGENTOS_FAKE_BRAIN;
    }
  }, 30_000);
});
