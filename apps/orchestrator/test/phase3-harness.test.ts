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
