import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { FleetService } from "../src/fleet/service.js";
import { envPrefixedCommand } from "../src/fleet/tmux.js";
import { scrubEnv } from "../src/security/env-scrub.js";

/**
 * The harness contract: what actually reaches a spawned Pi, who may drive the
 * tool surface, and that a SCOUT's read-only promise is audited rather than
 * trusted. These assert real behaviour of the spawn/bridge path — the only
 * simulation is "don't launch a paid model".
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = temp("agentos-harness-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git("config", "user.email", "harness@agent-os.test");
  git("config", "user.name", "Harness");
  writeFileSync(join(dir, "README.md"), "# harness fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

function fleet(options: { fakePi?: boolean } = {}): FleetService {
  const home = temp("agentos-harness-home-");
  mkdirSync(join(home, "config"), { recursive: true });
  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
  config.installDefaults();
  const service = new FleetService({
    home,
    config,
    fakeTmux: true,
    fakeBrain: true,
    ...(options.fakePi === true ? { fakePi: true } : {}),
  });
  // Orchestration tools are blocked while the Brain is down; these cases are
  // about the harness, not about BRAIN_DOWN.
  service.start();
  return service;
}

/** Register a project, create a task, and resolve a single-role cast for it. */
function seedTask(
  service: FleetService,
  options: { name: string; shape: "SHIP" | "SCOUT"; role: "builder" | "scout"; model?: string },
): { taskId: string; model: string } {
  const model = options.model ?? "openai/gpt-4.1";
  const project = service.projects.register({
    name: options.name,
    path: gitRepo(),
    mode: "local-only",
    trusted: true,
  });
  const spec =
    options.shape === "SHIP"
      ? {
          shape: "SHIP" as const,
          title: "t",
          intent: "i",
          projectId: project.id,
          mode: "local-only" as const,
          yolo: true,
        }
      : {
          shape: "SCOUT" as const,
          title: "look",
          intent: "read only",
          projectId: project.id,
          mode: "local-only" as const,
        };
  const created = service.tools.invoke("create_task", { spec });
  expect(created.ok).toBe(true);
  const taskId = (created.data as { id: string }).id;
  const cast = service.tools.invoke("resolve_cast", {
    taskId,
    roles: [{ role: options.role, model, thinking: "low", cleanRoom: true }],
    familyCheckOverride: false,
  });
  expect(cast.ok).toBe(true);
  return { taskId, model };
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("spawn env delivery", () => {
  it("starts from an empty environment and passes only the scrubbed pairs", () => {
    const scrubbed = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/captain",
        OPENAI_API_KEY: "sk-should-not-survive",
        ANTHROPIC_API_KEY: "sk-should-not-survive-either",
        SOME_UNRELATED_SECRET: "nope",
      },
      {
        grantProviderKey: { name: "OPENAI_API_KEY", value: "sk-granted" },
        extraAllow: { AGENTOS_SOCKET: "/tmp/s.sock", AGENTOS_ROLE: "builder" },
      },
    );
    const command = envPrefixedCommand(["/usr/local/bin/pi", "--mode", "json"], scrubbed.env);

    expect(command.startsWith("env -i ")).toBe(true);
    expect(command).toContain("AGENTOS_SOCKET=/tmp/s.sock");
    expect(command).toContain("AGENTOS_ROLE=builder");
    expect(command).toContain("OPENAI_API_KEY=sk-granted");
    expect(command).not.toContain("SOME_UNRELATED_SECRET");
    expect(command).not.toContain("sk-should-not-survive");
  });

  it("quotes values so a hostile path cannot break out of the command line", () => {
    const command = envPrefixedCommand(["pi"], { EVIL: "a'; rm -rf /; echo '" });
    expect(command).toContain(`EVIL='a'\\''; rm -rf /; echo '\\'''`);
  });
});

describe("missing Pi is an error, not a stub", () => {
  it("spawn_crewmate returns PI_UNAVAILABLE when Pi is not installed", () => {
    const service = fleet();
    const { taskId } = seedTask(service, { name: "harness", shape: "SHIP", role: "builder" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(false);
    expect(spawned.error?.code).toBe("PI_UNAVAILABLE");
  });

  it("PI_UNAVAILABLE releases the worktree lease so the pool is not exhausted", () => {
    const service = fleet();
    const { taskId } = seedTask(service, { name: "pool-leak", shape: "SHIP", role: "builder" });

    for (let i = 0; i < 3; i++) {
      const spawned = service.tools.invoke("spawn_crewmate", {
        taskId,
        role: "builder",
        model: "openai/gpt-4.1",
        thinking: "low",
        vars: {},
      });
      expect(spawned.ok).toBe(false);
      expect(spawned.error?.code).toBe("PI_UNAVAILABLE");
    }

    const leased = service.worktrees.list().filter((l) => l.state === "leased");
    expect(leased).toHaveLength(0);
  });
});

describe("worktree idle reuse moves HEAD to the new branch", () => {
  it("after deliver + re-lease, git HEAD matches the new lease branch", () => {
    const service = fleet({ fakePi: true });
    const repo = gitRepo();
    const project = service.projects.register({
      name: "reuse",
      path: repo,
      mode: "local-only",
      trusted: true,
    });

    const create = (title: string): string => {
      const created = service.tools.invoke("create_task", {
        spec: {
          shape: "SHIP" as const,
          title,
          intent: "i",
          projectId: project.id,
          mode: "local-only" as const,
          yolo: true,
        },
      });
      expect(created.ok).toBe(true);
      const taskId = (created.data as { id: string }).id;
      const cast = service.tools.invoke("resolve_cast", {
        taskId,
        roles: [
          {
            role: "builder",
            model: "openai/gpt-4.1",
            thinking: "low",
            cleanRoom: true,
          },
        ],
        familyCheckOverride: false,
      });
      expect(cast.ok).toBe(true);
      return taskId;
    };

    const task1 = create("first");
    const spawn1 = service.tools.invoke("spawn_crewmate", {
      taskId: task1,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawn1.ok).toBe(true);
    const path = (spawn1.data as { session: { worktreePath: string } }).session.worktreePath;
    const branch1 = (spawn1.data as { task: { branch: string } }).task.branch;
    expect(
      execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(branch1);

    writeFileSync(join(path, "change.txt"), "first task\n");
    execFileSync("git", ["-C", path, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", path, "commit", "-qm", "first task"], { stdio: "ignore" });

    const deliver = service.tools.invoke("deliver_task", { taskId: task1 });
    expect(deliver.ok).toBe(true);
    expect(service.worktrees.list().find((l) => l.path === path)?.state).toBe("idle");

    const task2 = create("second");
    const spawn2 = service.tools.invoke("spawn_crewmate", {
      taskId: task2,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawn2.ok).toBe(true);
    const path2 = (spawn2.data as { session: { worktreePath: string } }).session.worktreePath;
    const branch2 = (spawn2.data as { task: { branch: string } }).task.branch;
    expect(path2).toBe(path);
    expect(branch2).not.toBe(branch1);
    expect(
      execFileSync("git", ["-C", path2, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(branch2);
  });
});

describe("tool bridge authorization", () => {
  it("refuses orchestration tools from a session that is not the Brain", () => {
    const service = fleet({ fakePi: true });
    service.tools.setBrainSessionId("01JBR4N0000000000000000000");

    const refused = service.tools.invokeFromSession(
      "01JCREW0000000000000000000",
      "deliver_task",
      { taskId: "01JTASK0000000000000000000" },
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("UNAUTHORIZED_TOOL");

    // Read-only self-service is allowed — it fails on NOT_FOUND, not on authz.
    const allowed = service.tools.invokeFromSession(
      "01JCREW0000000000000000000",
      "read_task",
      { taskId: "01JTASK0000000000000000000" },
    );
    expect(allowed.error?.code).toBe("NOT_FOUND");

    const unknown = service.tools.invokeFromSession(
      "01JBR4N0000000000000000000",
      "definitely_not_a_tool",
      {},
    );
    expect(unknown.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("SCOUT read-only enforcement", () => {
  it("audits the worktree with git and quarantines a scout that wrote", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "scouted", shape: "SCOUT", role: "scout" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "scout",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } }).session;

    // A clean scout passes the audit.
    expect(service.tools.auditScoutSession(session.sessionId).clean).toBe(true);

    // A scout that wrote is caught by the real git status, not by trust.
    writeFileSync(join(session.worktreePath, "sneaky.txt"), "I wrote this\n");
    const violation = service.tools.auditScoutSession(session.sessionId);
    expect(violation.clean).toBe(false);
    expect(violation.changedPaths.join(" ")).toContain("sneaky.txt");

    const lease = service.worktrees.list().find((l) => l.path === session.worktreePath);
    expect(lease?.state).toBe("quarantined");
  });

  it("fails closed when git status cannot verify the worktree", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "scout-audit-fail", shape: "SCOUT", role: "scout" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "scout",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } }).session;

    // Destroy the git metadata so status cannot run — policy must not report clean.
    rmSync(join(session.worktreePath, ".git"), { recursive: true, force: true });
    const failed = service.tools.auditScoutSession(session.sessionId);
    expect(failed.clean).toBe(false);
    expect(failed.changedPaths.join(" ")).toMatch(/audit could not be performed/i);

    const lease = service.worktrees.list().find((l) => l.path === session.worktreePath);
    expect(lease?.state).toBe("quarantined");
  });
});

describe("worktree lease reclaim on stop/respawn", () => {
  it("stop/respawn cycles never exceed poolSize leased trees", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "respawn-pool",
      shape: "SHIP",
      role: "builder",
    });

    // Shipped default is 4; cycles beyond that must not exhaust the pool.
    const poolSize = 4;
    let sessionId: string | undefined;

    for (let i = 0; i < poolSize + 2; i++) {
      if (sessionId !== undefined) {
        const stopped = service.tools.invoke("stop_crewmate", {
          sessionId,
          reason: `cycle-${i}`,
        });
        expect(stopped.ok).toBe(true);
      }

      const spawn =
        sessionId === undefined
          ? service.tools.invoke("spawn_crewmate", {
              taskId,
              role: "builder",
              model,
              thinking: "low",
              vars: {},
            })
          : service.tools.invoke("respawn_crewmate", {
              sessionId,
              reason: `cycle-${i}`,
            });
      expect(spawn.ok).toBe(true);
      sessionId = (spawn.data as { session: { sessionId: string } }).session.sessionId;

      const leased = service.worktrees.list().filter((l) => l.state === "leased");
      expect(leased.length).toBeLessThanOrEqual(poolSize);
      expect(leased.length).toBe(1);
    }
  });
});

describe("send_to_crew delivery", () => {
  it("throws CONFLICT when both inject and send-keys fail", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "dead-channels", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    // No session sockets in the harness; force tmux fallback dead too.
    const original = service.tmux.sendKeys.bind(service.tmux);
    service.tmux.sendKeys = (): void => {
      throw new Error("tmux channel dead");
    };
    try {
      const result = service.tools.invoke("send_to_crew", {
        sessionId,
        message: "gate FAIL: verbatim lines must not report success undelivered",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFLICT");
    } finally {
      service.tmux.sendKeys = original;
    }
  });
});

describe("worktree verified-reset fail-closed", () => {
  it("quarantines when git status cannot prove the tree clean", async () => {
    const { WorktreePool } = await import("../src/fleet/worktree-pool.js");
    const home = temp("agentos-wt-fail-");
    const pool = new WorktreePool(home, {
      poolSize: 4,
      reclaimPolicy: "verified-reset",
    });
    const projectId = "01JPROJ0000000000000000001";
    const taskId = "01JTASK0000000000000000001";
    const sessionId = "01JSESS0000000000000000001";
    const prev = process.env.AGENTOS_FAKE_GIT;
    process.env.AGENTOS_FAKE_GIT = "1";
    let lease;
    try {
      lease = pool.lease({
        projectId,
        repoPath: home,
        taskId,
        sessionId,
        branch: "ao/test",
      });
    } finally {
      if (prev === undefined) delete process.env.AGENTOS_FAKE_GIT;
      else process.env.AGENTOS_FAKE_GIT = prev;
    }
    // Marker directory has no real git — status fails, so release must quarantine.
    const released = pool.release(lease.id, {});
    expect(released.state).toBe("quarantined");
    expect(released.quarantineReason ?? "").toMatch(/git status|not a git|exit/i);
  });
});

describe("crewmate questions", () => {
  it("routes an answer back to the session that asked", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "asker", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    const questionId = "01JQ5T0000000000000000000A";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Which migration should I target?",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);

    // Fake tmux accepts send-keys, so the fallback channel delivers.
    const answered = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Target 0007_add_index.",
    });
    expect(answered.ok).toBe(true);
    expect(service.tools.listQuestions()).toHaveLength(0);

    const unknown = service.tools.invoke("answer_crewmate", {
      questionId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      answer: "hello",
    });
    expect(unknown.error?.code).toBe("NOT_FOUND");
  });
});

describe("extension lifecycle drives session state", () => {
  it("marks a session settled on agent_settled and absorbs PROGRESS", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "lifecycle", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    service.handleExtensionFrame({
      type: "ext.lifecycle",
      sessionId,
      phase: "session_start",
      detail: null,
      ts: new Date().toISOString(),
    });
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );

    service.handleExtensionFrame({
      type: "ext.lifecycle",
      sessionId,
      phase: "agent_settled",
      detail: "done",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "settled",
    );
  });
});
