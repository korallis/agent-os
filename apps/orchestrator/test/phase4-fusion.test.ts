import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_PINNED_VERSION } from "@agent-os/protocol";
import { SHIPPED_DEFAULTS_DIR, SHIPPED_PROMPTS_DIR } from "../src/daemon.js";
import { ConfigService } from "../src/config/service.js";
import { BRAIN_SESSION_PROJECT_ID } from "../src/fleet/brain.js";
import { FleetService } from "../src/fleet/service.js";
import { FusionRunStore } from "../src/fleet/fusion-runs.js";
import { SessionKeyStore } from "../src/fleet/sessions.js";
import { PromptService, PromptResolutionError } from "../src/prompts/service.js";
import { buildPiSpawnSpec, type PiDetection } from "../src/pi/manager.js";
import type { OrchestratorEvent } from "@agent-os/protocol";

/**
 * Phase 4 units + live-path gates: layered prompt packs, session-key gate (G6),
 * /opinion clean-room dispatch with side artifacts and settle-time events.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function prompts(): { service: PromptService; globalDir: string } {
  const home = temp("agentos-p4-prompts-");
  const globalDir = join(home, "prompts");
  mkdirSync(globalDir, { recursive: true });
  const service = new PromptService(SHIPPED_PROMPTS_DIR, globalDir);
  service.installDefaults();
  return { service, globalDir };
}

function gitRepo(): string {
  const dir = temp("agentos-p4-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git("config", "user.email", "p4@agent-os.test");
  git("config", "user.name", "Phase4");
  writeFileSync(join(dir, "README.md"), "# p4 fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

function fleet(): { service: FleetService; events: OrchestratorEvent[] } {
  const home = temp("agentos-p4-home-");
  mkdirSync(join(home, "config"), { recursive: true });
  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
  config.installDefaults();
  config.writeGlobal("policies", "{ redBaselineGateRequired: false }\n");
  const promptService = new PromptService(SHIPPED_PROMPTS_DIR, join(home, "prompts"));
  promptService.installDefaults();
  const events: OrchestratorEvent[] = [];
  const service = new FleetService({
    home,
    config,
    prompts: promptService,
    fakeTmux: true,
    fakeBrain: true,
    fakePi: true,
  });
  service.onEvent((e) => events.push(e));
  service.start();
  return { service, events };
}

function seedShipTask(service: FleetService): { taskId: string; projectId: string } {
  const project = service.projects.register({
    name: "p4",
    path: gitRepo(),
    mode: "local-only",
    trusted: true,
  });
  const created = service.tools.invoke("create_task", {
    spec: {
      shape: "SHIP",
      title: "Should we ship?",
      intent: "Compare two plans.",
      projectId: project.id,
      mode: "local-only",
      yolo: true,
    },
  });
  expect(created.ok).toBe(true);
  const taskId = (created.data as { id: string }).id;
  const cast = service.tools.invoke("resolve_cast", {
    taskId,
    roles: [
      {
        role: "planner",
        model: "anthropic/claude-fable-5",
        thinking: "high",
        cleanRoom: true,
      },
      {
        role: "planner",
        model: "openai/gpt-5.6-sol",
        thinking: "low",
        cleanRoom: true,
      },
    ],
    familyCheckOverride: false,
  });
  expect(cast.ok).toBe(true);
  return { taskId, projectId: project.id };
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

describe("prompt packs", () => {
  it("installs shipped templates into the editable global layer", () => {
    const { service, globalDir } = prompts();
    const info = service.resolve("fusion/fusion.md");
    expect(info.layer).toBe("global");
    expect(info.customized).toBe(false);
    expect(readFileSync(join(globalDir, "fusion", "fusion.md"), "utf8")).toContain("[ARCHITECT]");
  });

  it("renders {{VAR}} and refuses an undefined variable rather than half-rendering", () => {
    const { service } = prompts();
    const rendered = service.render("fusion/opinion.md", {
      QUESTION: "Ship it?",
      CONTEXT: "Small diff.",
    });
    expect(rendered.rendered).toContain("Ship it?");
    expect(rendered.renderedHash).toHaveLength(64);

    expect(() => service.render("fusion/opinion.md", { QUESTION: "only one" })).toThrow(
      /CONTEXT/,
    );
  });

  it("lets a project layer override global", () => {
    const { service } = prompts();
    const projectDir = temp("agentos-p4-project-");
    mkdirSync(join(projectDir, "fusion"), { recursive: true });
    writeFileSync(join(projectDir, "fusion", "opinion.md"), "project {{QUESTION}}\n");

    const info = service.resolve("fusion/opinion.md", projectDir);
    expect(info.layer).toBe("project");
    expect(service.render("fusion/opinion.md", { QUESTION: "x" }, projectDir).rendered).toBe(
      "project x\n",
    );
  });

  it("detects customization and serves three-way diff data", () => {
    const { service, globalDir } = prompts();
    expect(service.resolve("fusion/fusion.md").customized).toBe(false);

    const path = join(globalDir, "fusion", "fusion.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n\nMY EDIT\n`);

    expect(service.resolve("fusion/fusion.md").customized).toBe(true);
    const diff = service.threeWayDiff("fusion/fusion.md");
    expect(diff.customized).toBe(true);
    expect(diff.shippedAtInstall).toHaveLength(64);
    expect(diff.yours).toContain("MY EDIT");
  });

  it("rejects traversal and non-markdown refs", () => {
    const { service } = prompts();
    for (const ref of ["../../etc/passwd.md", "fusion/../../x.md", "fusion/notes.txt", ""]) {
      expect(() => service.resolve(ref)).toThrow(PromptResolutionError);
    }
  });
});

describe("session keys (G6)", () => {
  it("gives a different directory per model so transcripts never cross families", () => {
    const store = new SessionKeyStore(temp("agentos-p4-sessions-"));
    const anthropic = store.ensure({
      projectId: "P",
      role: "planner",
      model: "anthropic/claude-fable-5",
    });
    const openai = store.ensure({
      projectId: "P",
      role: "planner",
      model: "openai/gpt-5.6-sol",
    });
    expect(anthropic.dir).not.toBe(openai.dir);

    // Same triple resumes the same directory rather than forking a new one.
    expect(
      store.ensure({ projectId: "P", role: "planner", model: "anthropic/claude-fable-5" }).dir,
    ).toBe(anthropic.dir);
    expect(store.list()).toHaveLength(2);
  });

  it("reports only the roles a restart must respawn", () => {
    const store = new SessionKeyStore(temp("agentos-p4-missing-"));
    store.ensure({ projectId: "P", role: "planner", model: "anthropic/claude-fable-5" });

    const missing = store.missingRoles("P", [
      { role: "planner", model: "anthropic/claude-fable-5" },
      { role: "planner", model: "openai/gpt-5.6-sol" },
    ]);
    expect(missing).toEqual([{ role: "planner", model: "openai/gpt-5.6-sol" }]);
  });

  it("wires session dirs into live spawns and hands native Pi session isolation", () => {
    const { service } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    // End-to-end G6: spawn the full cross-family cast live, then wipe one side.
    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    expect(spawnB.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session.sessionId;
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session.sessionId;

    const keyA = SessionKeyStore.computeKey({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    });
    const keyB = SessionKeyStore.computeKey({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    });
    expect(keyA).not.toBe(keyB);

    const dirA = service.tools.ensureSessionKey({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    });
    const dirB = service.tools.ensureSessionKey({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    });
    expect(dirA).not.toBe(dirB);
    expect(existsSync(join(dirA, "session.json"))).toBe(true);
    expect(existsSync(join(dirB, "session.json"))).toBe(true);

    // buildPiSpawnSpec must point Pi's own session store at the per-model dir
    // (--session-dir + PI_CODING_AGENT_SESSION_DIR), not only AGENTOS_SESSION_DIR
    // (extension output capture).
    const detection: PiDetection = {
      binary: "/usr/bin/true",
      version: "0.0.0-test",
      pinnedVersion: "0.82.0" as PiDetection["pinnedVersion"],
      versionMatchesPin: false,
      managedHome: temp("agentos-p4-pi-home-"),
      configDirEnv: "PI_CONFIG_DIR",
      isolationMode: "managed",
    };
    const specA = buildPiSpawnSpec({
      agentosHome: temp("agentos-p4-spec-home-a-"),
      detection,
      args: ["-p", "hi", "--model", "anthropic/claude-fable-5"],
      cwd: temp("agentos-p4-spec-cwd-a-"),
      sessionId: "01JSESSION000000000000000A",
      role: "planner",
      socketPath: "/tmp/agentos-test-a.sock",
      extensionPath: join(temp("agentos-p4-ext-a-"), "ext.js"),
      sessionDir: dirA,
      cleanRoom: true,
    });
    const specB = buildPiSpawnSpec({
      agentosHome: temp("agentos-p4-spec-home-b-"),
      detection,
      args: ["-p", "hi", "--model", "openai/gpt-4.1"],
      cwd: temp("agentos-p4-spec-cwd-b-"),
      sessionId: "01JSESSION000000000000000B",
      role: "planner",
      socketPath: "/tmp/agentos-test-b.sock",
      extensionPath: join(temp("agentos-p4-ext-b-"), "ext.js"),
      sessionDir: dirB,
      cleanRoom: true,
    });
    expect(specA.args).toContain("--session-dir");
    expect(specA.args[specA.args.indexOf("--session-dir") + 1]).toBe(dirA);
    expect(specA.env.PI_CODING_AGENT_SESSION_DIR).toBe(dirA);
    expect(specA.env.AGENTOS_SESSION_DIR).toBe(dirA);
    expect(specA.envKeys).toContain("PI_CODING_AGENT_SESSION_DIR");
    expect(specA.envKeys).toContain("AGENTOS_SESSION_DIR");
    expect(specB.args).toContain("--session-dir");
    expect(specB.args[specB.args.indexOf("--session-dir") + 1]).toBe(dirB);
    expect(specB.env.PI_CODING_AGENT_SESSION_DIR).toBe(dirB);
    expect(specB.env.AGENTOS_SESSION_DIR).toBe(dirB);
    // Two models ⇒ two distinct Pi session directories on the spawn argv/env.
    expect(specA.args[specA.args.indexOf("--session-dir") + 1]).not.toBe(
      specB.args[specB.args.indexOf("--session-dir") + 1],
    );
    expect(specA.env.PI_CODING_AGENT_SESSION_DIR).not.toBe(
      specB.env.PI_CODING_AGENT_SESSION_DIR,
    );

    // Cast thinking must reach Pi argv — not metadata-only.
    const withThinking = buildPiSpawnSpec({
      agentosHome: temp("agentos-p4-spec-home-t-"),
      detection,
      args: ["-p", "hi", "--model", "anthropic/claude-fable-5"],
      cwd: temp("agentos-p4-spec-cwd-t-"),
      sessionId: "01JSESSION000000000000000T",
      role: "planner",
      socketPath: "/tmp/agentos-test-t.sock",
      extensionPath: join(temp("agentos-p4-ext-t-"), "ext.js"),
      sessionDir: dirA,
      thinking: "high",
      cleanRoom: true,
    });
    expect(withThinking.args).toContain("--thinking");
    expect(withThinking.args[withThinking.args.indexOf("--thinking") + 1]).toBe(
      "high",
    );
    const withLow = buildPiSpawnSpec({
      agentosHome: temp("agentos-p4-spec-home-tl-"),
      detection,
      args: ["-p", "hi", "--model", "openai/gpt-4.1"],
      cwd: temp("agentos-p4-spec-cwd-tl-"),
      sessionId: "01JSESSION00000000000000TL",
      role: "planner",
      socketPath: "/tmp/agentos-test-tl.sock",
      extensionPath: join(temp("agentos-p4-ext-tl-"), "ext.js"),
      sessionDir: dirB,
      thinking: "low",
      cleanRoom: true,
    });
    expect(withLow.args[withLow.args.indexOf("--thinking") + 1]).toBe("low");

    // Wipe exactly the openai session dir; anthropic survives.
    rmSync(dirB, { recursive: true, force: true });
    expect(
      service.sessionKeys.missingRoles(projectId, [
        { role: "planner", model: "anthropic/claude-fable-5" },
        { role: "planner", model: "openai/gpt-5.6-sol" },
      ]),
    ).toEqual([{ role: "planner", model: "openai/gpt-5.6-sol" }]);

    const phaseBefore = service.tools.getTask(taskId)?.phase;
    const respawned = service.tools.reconcileMissingCastRoles();
    expect(respawned).toEqual([
      {
        taskId,
        role: "planner",
        model: "openai/gpt-5.6-sol",
      },
    ]);

    // Surviving anthropic session id is untouched; wiped openai was marked lost
    // and a fresh openai session is running. Task must NOT promote to SESSION_LOST
    // while a healthy sibling remains.
    const anthropicLive = service.tools
      .listSessions()
      .filter(
        (s) =>
          s.model === "anthropic/claude-fable-5" &&
          (s.status === "running" || s.status === "starting" || s.status === "settled"),
      )
      .map((s) => s.sessionId);
    expect(anthropicLive).toEqual([sessionA]);
    expect(
      service.tools.listSessions().some(
        (s) => s.sessionId === sessionB && s.status === "lost",
      ),
    ).toBe(true);
    expect(
      service.tools.listSessions().some(
        (s) =>
          s.model === "openai/gpt-5.6-sol" &&
          s.sessionId !== sessionB &&
          (s.status === "running" || s.status === "starting"),
      ),
    ).toBe(true);
    expect(service.tools.getTask(taskId)?.phase).not.toBe("SESSION_LOST");
    expect(service.tools.getTask(taskId)?.phase).toBe(phaseBefore);
    expect(
      service.sessionKeys.missingRoles(projectId, [
        { role: "planner", model: "anthropic/claude-fable-5" },
        { role: "planner", model: "openai/gpt-5.6-sol" },
      ]),
    ).toEqual([]);
  });

  it("never inherits ambient session-dir sentinels into crewmate or Brain spawn env", async () => {
    const sentinel = "/tmp/ambient-session-dir-CANARY";
    const prevAgentos = process.env.AGENTOS_SESSION_DIR;
    const prevPi = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.AGENTOS_SESSION_DIR = sentinel;
    process.env.PI_CODING_AGENT_SESSION_DIR = sentinel;

    try {
      const home = temp("agentos-p4-session-canary-");
      mkdirSync(join(home, "config"), { recursive: true });
      const extensionPath = join(home, "extension.js");
      writeFileSync(extensionPath, "export default {};\n");
      const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
      config.installDefaults();
      const promptService = new PromptService(SHIPPED_PROMPTS_DIR, join(home, "prompts"));
      promptService.installDefaults();

      const capturedEnvs: Array<Record<string, string> | undefined> = [];
      const service = new FleetService({
        home,
        config,
        prompts: promptService,
        fakeTmux: true,
        fakeBrain: false,
        fakePi: false,
        pi: {
          binary: "/usr/bin/true",
          version: PI_PINNED_VERSION,
          pinnedVersion: PI_PINNED_VERSION,
          versionMatchesPin: true,
          managedHome: join(home, "pi"),
          configDirEnv: "PI_CONFIG_DIR",
          isolationMode: "managed",
        },
        extensionPath,
        sockets: {
          sessionSocketPath: (sessionId) => join(home, "sockets", `${sessionId}.sock`),
          openSession: (sessionId) => {
            mkdirSync(join(home, "sockets"), { recursive: true });
            return join(home, "sockets", `${sessionId}.sock`);
          },
          closeSession: async () => undefined,
          sendControl: () => false,
        },
      });

      const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
      service.tmux.newWindow = ((input: Parameters<typeof originalNewWindow>[0]) => {
        capturedEnvs.push(input.env);
        return originalNewWindow(input);
      }) as typeof service.tmux.newWindow;

      const brainSnap = await service.brain.start("session-dir-canary");
      expect(brainSnap.status).toBe("running");
      expect(brainSnap.model).not.toBeNull();
      const brainModel = brainSnap.model as string;
      const brainDir = service.sessionKeys.ensure({
        projectId: BRAIN_SESSION_PROJECT_ID,
        role: "brain",
        model: brainModel,
      }).dir;

      const project = service.projects.register({
        name: "p4-canary",
        path: gitRepo(),
        mode: "local-only",
        trusted: true,
      });
      const created = service.tools.invoke("create_task", {
        spec: {
          shape: "SHIP",
          title: "session dir canary",
          intent: "assert ambient session dirs never leak",
          projectId: project.id,
          mode: "local-only",
          yolo: true,
        },
      });
      expect(created.ok).toBe(true);
      const taskId = (created.data as { id: string }).id;
      expect(
        service.tools.invoke("resolve_cast", {
          taskId,
          roles: [
            {
              role: "planner",
              model: "openai/gpt-4.1",
              thinking: "low",
              cleanRoom: true,
            },
          ],
          familyCheckOverride: false,
        }).ok,
      ).toBe(true);
      const spawned = service.tools.invoke("spawn_crewmate", {
        taskId,
        role: "planner",
        model: "openai/gpt-4.1",
        thinking: "low",
        cleanRoom: true,
        vars: {},
      });
      expect(spawned.ok).toBe(true);
      const crewmateDir = service.sessionKeys.ensure({
        projectId: project.id,
        role: "planner",
        model: "openai/gpt-4.1",
      }).dir;

      expect(capturedEnvs.length).toBeGreaterThanOrEqual(2);
      for (const env of capturedEnvs) {
        expect(env).toBeDefined();
        const record = env as Record<string, string>;
        expect(record.AGENTOS_SESSION_DIR).not.toBe(sentinel);
        expect(record.PI_CODING_AGENT_SESSION_DIR).not.toBe(sentinel);
        expect(Object.values(record).join("\0")).not.toContain(sentinel);
      }

      const brainEnv = capturedEnvs.find((env) => env?.AGENTOS_ROLE === "brain");
      const crewmateEnv = capturedEnvs.find((env) => env?.AGENTOS_ROLE === "planner");
      expect(brainEnv).toBeDefined();
      expect(crewmateEnv).toBeDefined();
      expect(brainEnv?.AGENTOS_SESSION_DIR).toBe(brainDir);
      expect(brainEnv?.PI_CODING_AGENT_SESSION_DIR).toBe(brainDir);
      expect(crewmateEnv?.AGENTOS_SESSION_DIR).toBe(crewmateDir);
      expect(crewmateEnv?.PI_CODING_AGENT_SESSION_DIR).toBe(crewmateDir);

      const noSession = buildPiSpawnSpec({
        agentosHome: home,
        detection: {
          binary: "/usr/bin/true",
          version: PI_PINNED_VERSION,
          pinnedVersion: PI_PINNED_VERSION,
          versionMatchesPin: true,
          managedHome: join(home, "pi"),
          configDirEnv: "PI_CONFIG_DIR",
          isolationMode: "managed",
        },
        args: ["-p", "hi"],
        cwd: home,
        sessionId: "01JSESSIONCANARY0000000001",
        role: "builder",
        socketPath: join(home, "s.sock"),
        extensionPath,
      });
      expect(noSession.env.AGENTOS_SESSION_DIR).toBeUndefined();
      expect(noSession.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    } finally {
      if (prevAgentos === undefined) delete process.env.AGENTOS_SESSION_DIR;
      else process.env.AGENTOS_SESSION_DIR = prevAgentos;
      if (prevPi === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = prevPi;
    }
  });

  it("removes a newly created session key when spawn fails so resume still sees the role missing", () => {
    const { service } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    let windowCalls = 0;
    service.tmux.newWindow = ((input: Parameters<typeof originalNewWindow>[0]) => {
      windowCalls += 1;
      if (windowCalls === 1) {
        throw new Error("tmux refused spawn");
      }
      return originalNewWindow(input);
    }) as typeof service.tmux.newWindow;

    const failed = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      vars: {},
    });
    expect(failed.ok).toBe(false);

    // Orphan empty key dir must not exist — missingRoles must still list the role.
    expect(
      service.sessionKeys.missingRoles(projectId, [
        { role: "planner", model: "anthropic/claude-fable-5" },
      ]),
    ).toEqual([{ role: "planner", model: "anthropic/claude-fable-5" }]);
    expect(service.sessionKeys.has({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    })).toBe(false);

    // Restart half: after a failed spawn the role is still missing and respawns.
    service.tmux.newWindow = originalNewWindow;
    // Seed a surviving sibling session so reconcileMissingCastRoles engages
    // (it requires at least one prior session row on the task).
    const sibling = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      vars: {},
    });
    expect(sibling.ok).toBe(true);
    const siblingDir = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    }).dir;
    expect(existsSync(siblingDir)).toBe(true);

    const respawned = service.tools.reconcileMissingCastRoles();
    expect(respawned).toEqual([
      {
        taskId,
        role: "planner",
        model: "anthropic/claude-fable-5",
      },
    ]);
    expect(
      service.sessionKeys.missingRoles(projectId, [
        { role: "planner", model: "anthropic/claude-fable-5" },
        { role: "planner", model: "openai/gpt-5.6-sol" },
      ]),
    ).toEqual([]);
  });
});

describe("fusion run store", () => {
  it("accumulates per-side telemetry and parses attribution spans", () => {
    const home = temp("agentos-p4-runs-");
    const store = new FusionRunStore(home);
    const run = {
      runId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      taskId: "01JTASK0000000000000000000",
      kind: "opinion" as const,
      templateRef: "fusion/opinion.md",
      templateLayer: "global" as const,
      templateHash: "h",
      renderedHash: "r",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic" as const,
          sessionId: "01JSESSION000000000000000A",
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: "anthropic" as const,
      contractOk: null,
      createdAt: new Date().toISOString(),
    };
    store.create(run);
    store.recordSideUsage(run.taskId, run.runId, "01JSESSION000000000000000A", {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    });
    store.recordSideUsage(run.taskId, run.runId, "01JSESSION000000000000000A", {
      inputTokens: 50,
      outputTokens: 5,
      costUsd: 0.25,
    });

    const after = store.get(run.taskId, run.runId);
    expect(after?.sides[0]?.inputTokens).toBe(150);
    expect(after?.sides[0]?.outputTokens).toBe(25);
    expect(after?.sides[0]?.costUsd).toBeCloseTo(0.75);

    // sideIndex path stamps sessionId and attributes even when the row had null.
    store.save({
      ...after!,
      sides: [{ ...after!.sides[0]!, sessionId: null, inputTokens: null, outputTokens: null, costUsd: null }],
    });
    store.recordSideUsage(
      run.taskId,
      run.runId,
      "01JSESSION000000000000000A",
      { inputTokens: 11, outputTokens: 2, costUsd: 0.1 },
      0,
    );
    const byIndex = store.get(run.taskId, run.runId);
    expect(byIndex?.sides[0]?.sessionId).toBe("01JSESSION000000000000000A");
    expect(byIndex?.sides[0]?.inputTokens).toBe(11);

    store.writeFused(
      run.taskId,
      run.runId,
      "[ARCHITECT]\nkeep it\n[BUILDER]\nindex it\n[FUSION]\nboth\n",
    );
    const detail = store.detail(run.taskId, run.runId);
    expect(detail?.spans.map((s) => s.tag)).toEqual(["ARCHITECT", "BUILDER", "FUSION"]);
  });

  it("discriminates dual-planner side artifacts by index and model", () => {
    const home = temp("agentos-p4-sides-");
    const store = new FusionRunStore(home);
    const taskId = "01JTASK0000000000000000001";
    const runId = "01JZZZZZZZZZZZZZZZZZZZZZZY";
    const path0 = store.writeSideArtifact(
      taskId,
      runId,
      0,
      "anthropic/claude-fable-5",
      "side-a\n",
    );
    const path1 = store.writeSideArtifact(
      taskId,
      runId,
      1,
      "openai/gpt-5.6-sol",
      "side-b\n",
    );
    expect(path0).not.toBe(path1);
    expect(path0).toContain("side-0-");
    expect(path1).toContain("side-1-");
    expect(readFileSync(path0, "utf8")).toBe("side-a\n");
    expect(readFileSync(path1, "utf8")).toBe("side-b\n");
  });
});

describe("/opinion live path", () => {
  it("spawns clean-room sides by default, writes artifacts, and completes only after settle", () => {
    const { service, events } = fleet();
    const { taskId } = seedShipTask(service);

    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "anthropic",
          cleanRoom: true,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          thinking: "low",
          family: "openai",
          cleanRoom: true,
        },
      ],
      // Default path — no spawnSides flag.
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      runId: string;
      promptsIdentical: boolean;
      spawned: boolean;
    };
    expect(data.spawned).toBe(true);
    expect(data.promptsIdentical).toBe(true);

    const types = events.map((e) => e.type);
    expect(types).toContain("fusion.dispatched");
    expect(types.filter((t) => t === "fusion.side_completed")).toHaveLength(2);
    expect(types).toContain("fusion.completed");

    // dispatched must precede completed; side_completed before completed.
    const dispatchedAt = types.indexOf("fusion.dispatched");
    const completedAt = types.lastIndexOf("fusion.completed");
    const firstSide = types.indexOf("fusion.side_completed");
    expect(dispatchedAt).toBeGreaterThanOrEqual(0);
    expect(firstSide).toBeGreaterThan(dispatchedAt);
    expect(completedAt).toBeGreaterThan(firstSide);

    const sideEvents = events.filter((e) => e.type === "fusion.side_completed");
    for (const e of sideEvents) {
      if (e.type !== "fusion.side_completed") continue;
      expect(e.payload.artifactPath).not.toBeNull();
      expect(existsSync(e.payload.artifactPath!)).toBe(true);
      expect(readFileSync(e.payload.artifactPath!, "utf8")).toMatch(/fake-pi/);
    }

    const run = service.fusionRuns.get(taskId, data.runId);
    expect(run).not.toBeNull();
    expect(run!.sides).toHaveLength(2);
    expect(run!.sides.every((s) => s.artifactPath !== null)).toBe(true);
    expect(run!.sides.every((s) => s.sessionId !== null)).toBe(true);
    expect(run!.sides[0]!.artifactPath).not.toBe(run!.sides[1]!.artifactPath);

    // Distinct session keys per model on the live spawn path.
    const projectId = service.tools.getTask(taskId)!.projectId;
    const dir0 = service.tools.ensureSessionKey({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    });
    const dir1 = service.tools.ensureSessionKey({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    });
    expect(dir0).not.toBe(dir1);

    const detail = service.fusionRuns.detail(taskId, data.runId);
    expect(detail?.sideArtifacts).toHaveLength(2);
    expect(detail?.sideArtifacts.map((s) => s.model).sort()).toEqual([
      "anthropic/claude-fable-5",
      "openai/gpt-5.6-sol",
    ]);

    // Thinking resolved per cast index: session records keep each planner's level.
    const sessions = service.tools.listSessions().filter((s) => s.taskId === taskId);
    const byModel = new Map(sessions.map((s) => [s.model, s.thinking]));
    expect(byModel.get("anthropic/claude-fable-5")).toBe("high");
    expect(byModel.get("openai/gpt-5.6-sol")).toBe("low");
  });

  it("treats kind=fusion with an artifact as a contract check (no default spawn)", () => {
    const { service, events } = fleet();
    const { taskId } = seedShipTask(service);
    events.length = 0;

    const artifact = [
      "[ARCHITECT]",
      "keep the plan",
      "[BUILDER]",
      "index the work",
      "[FUSION]",
      "both agree",
      "## Consensus & Divergence",
      "Agree on scope.",
      "## Decision ledger",
      "- ship the plan",
      "",
    ].join("\n");

    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "fusion",
      casts: [
        {
          role: "fusion",
          model: "anthropic/claude-fable-5",
          thinking: "medium",
          family: "anthropic",
          cleanRoom: true,
        },
      ],
      instruction: artifact,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { spawned: boolean; contractOk: boolean };
    expect(data.spawned).toBe(false);
    expect(data.contractOk).toBe(true);

    const types = events.map((e) => e.type);
    expect(types).toContain("fusion.dispatched");
    expect(types).toContain("fusion.completed");
    expect(types).not.toContain("fusion.side_completed");
    expect(types).not.toContain("session.spawned");
  });

  it("honors spawnSides: false bookkeeping opt-out for /opinion", () => {
    const { service, events } = fleet();
    const { taskId } = seedShipTask(service);
    events.length = 0;

    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      spawnSides: false,
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "anthropic",
          cleanRoom: true,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          thinking: "high",
          family: "openai",
          cleanRoom: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect((result.data as { spawned: boolean }).spawned).toBe(false);
    expect(events.map((e) => e.type)).not.toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");
  });

  it("forces clean-room argv for /opinion even when cast.cleanRoom is false", () => {
    const home = temp("agentos-p4-cleanroom-force-");
    mkdirSync(join(home, "config"), { recursive: true });
    const extensionPath = join(home, "extension.js");
    writeFileSync(extensionPath, "export default {};\n");
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const promptService = new PromptService(SHIPPED_PROMPTS_DIR, join(home, "prompts"));
    promptService.installDefaults();

    const capturedArgvs: string[][] = [];
    const service = new FleetService({
      home,
      config,
      prompts: promptService,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: false,
      pi: {
        binary: "/usr/bin/true",
        version: PI_PINNED_VERSION,
        pinnedVersion: PI_PINNED_VERSION,
        versionMatchesPin: true,
        managedHome: join(home, "pi"),
        configDirEnv: "PI_CONFIG_DIR",
        isolationMode: "managed",
      },
      extensionPath,
      sockets: {
        sessionSocketPath: (sessionId) => join(home, "sockets", `${sessionId}.sock`),
        openSession: (sessionId) => {
          mkdirSync(join(home, "sockets"), { recursive: true });
          return join(home, "sockets", `${sessionId}.sock`);
        },
        closeSession: async () => undefined,
        sendControl: () => false,
      },
    });
    service.start();

    const originalNewWindow = service.tmux.newWindow.bind(service.tmux);
    service.tmux.newWindow = ((input: Parameters<typeof originalNewWindow>[0]) => {
      capturedArgvs.push([...input.argv]);
      return originalNewWindow(input);
    }) as typeof service.tmux.newWindow;

    const { taskId } = seedShipTask(service);
    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "anthropic",
          cleanRoom: false,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          thinking: "low",
          family: "openai",
          cleanRoom: false,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect((result.data as { spawned: boolean }).spawned).toBe(true);

    const plannerArgvs = capturedArgvs.filter((argv) =>
      argv.some((a) => a.includes("claude-fable-5") || a.includes("gpt-5.6-sol")),
    );
    expect(plannerArgvs.length).toBeGreaterThanOrEqual(2);
    for (const argv of plannerArgvs) {
      expect(argv).toContain("--no-skills");
      expect(argv).toContain("--no-extensions");
      expect(argv).toContain("--no-context-files");
      expect(argv).toContain("-e");
      expect(argv).toContain(extensionPath);
    }
  });

  it("refuses crew session read_run_artifacts (no clean-room cross-reads)", () => {
    const { service } = fleet();
    const { taskId } = seedShipTask(service);

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    // Captain / Brain path may still read artifacts.
    const asCaptain = service.tools.invoke("read_run_artifacts", { taskId });
    expect(asCaptain.ok).toBe(true);

    service.tools.setBrainSessionId("01JBR4N0000000000000000000");
    const asCrew = service.tools.invokeFromSession(sessionId, "read_run_artifacts", {
      taskId,
    });
    expect(asCrew.ok).toBe(false);
    expect(asCrew.error?.code).toBe("UNAUTHORIZED_TOOL");
  });

  it("refuses same-family /opinion even when cast.family labels disagree", () => {
    const { service } = fleet();
    const { taskId } = seedShipTask(service);

    // Two anthropic models mislabelled as different families — policy must
    // derive family from model, not trust the client label.
    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      spawnSides: false,
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "openai",
          cleanRoom: true,
        },
        {
          role: "planner",
          model: "anthropic/claude-opus-4",
          thinking: "high",
          family: "xai",
          cleanRoom: true,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
    expect(result.error?.message).toMatch(/distinct model families/i);
  });

  it("derives durable FusionSide.family from model, overwriting client labels", () => {
    const { service } = fleet();
    const { taskId } = seedShipTask(service);

    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      spawnSides: false,
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "openai",
          cleanRoom: true,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          thinking: "low",
          family: "anthropic",
          cleanRoom: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { runId: string; aggregatorFamily: string | null };
    expect(data.aggregatorFamily).toBe("anthropic");

    const run = service.fusionRuns.get(taskId, data.runId);
    expect(run).not.toBeNull();
    expect(run!.sides.map((s) => s.family)).toEqual(["anthropic", "openai"]);
    expect(run!.aggregatorFamily).toBe("anthropic");
  });

  it("rebuilds fusion ownership, keeps late usage, finalizes stop without placeholders", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    expect(spawnB.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session.sessionId;
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session.sessionId;

    // Durable in-flight fusion run as if the daemon restarted mid-flight.
    const runId = "01JZZZZZZZZZZZZZZZZZZZZZZX";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: "fusion/opinion.md",
      templateLayer: "global",
      templateHash: "h",
      renderedHash: "r",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: sessionB,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    mkdirSync(join(dirA, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirA, "outputs", `${sessionA}.md`), "hydrated side answer\n", {
      mode: 0o600,
    });

    // Boot reconcile path: rebuild ownership from run.json (no live dispatch map).
    service.tools.hydrateFusionOwnership();

    events.length = 0;
    service.tools.markSessionStatus(sessionA, "settled");
    const afterA = service.fusionRuns.get(taskId, runId);
    expect(afterA?.sides[0]?.settledAt).toBeTruthy();
    expect(afterA?.sides[0]?.artifactPath).not.toBeNull();
    expect(readFileSync(afterA!.sides[0]!.artifactPath!, "utf8")).toBe("hydrated side answer\n");
    expect(afterA?.sides[1]?.settledAt == null).toBe(true);
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).not.toContain("fusion.completed");

    // Late usage after settle still attributes (ownership not dropped at first settle).
    service.tools.attributeFusionUsage(sessionA, {
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.01,
    });
    expect(service.fusionRuns.get(taskId, runId)?.sides[0]?.inputTokens).toBe(7);

    // Real Pi order: agent_settled then session_end while sibling still in flight.
    // Ownership must survive session_end so a late usage frame still attributes.
    service.tools.releaseSessionOnEnd(sessionA);
    service.tools.attributeFusionUsage(sessionA, {
      inputTokens: 11,
      outputTokens: 5,
      costUsd: 0.02,
    });
    // recordSideUsage sums frames; 7+11 / 3+5 must still land on side A.
    expect(service.fusionRuns.get(taskId, runId)?.sides[0]?.inputTokens).toBe(18);
    expect(service.fusionRuns.get(taskId, runId)?.sides[0]?.outputTokens).toBe(8);
    expect(service.fusionRuns.get(taskId, runId)?.completedAt == null).toBe(true);

    // No real model output for side B — remove the per-session capture so stop
    // finalizes with artifactPath null rather than a placeholder.
    const dirB = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    }).dir;
    rmSync(join(dirB, "outputs", `${sessionB}.md`), { force: true });

    events.length = 0;
    const stopped = service.tools.invoke("stop_crewmate", {
      sessionId: sessionB,
      reason: "test stop",
    });
    expect(stopped.ok).toBe(true);
    const afterStop = service.fusionRuns.get(taskId, runId);
    expect(afterStop?.sides[1]?.settledAt).toBeTruthy();
    expect(afterStop?.sides[1]?.artifactPath).toBeNull();
    expect(afterStop?.completedAt).toBeTruthy();
    expect(afterStop?.error).toBe("test stop");
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");
    // One terminal lifecycle event from stop_crewmate — not also
    // "fusion side settled" from releaseSettled.
    expect(events.filter((e) => e.type === "session.stopped")).toHaveLength(1);
    const stopEvent = events.find((e) => e.type === "session.stopped");
    if (stopEvent?.type === "session.stopped") {
      expect(stopEvent.payload.reason).toBe("test stop");
    }
    const completedStop = events.find((e) => e.type === "fusion.completed");
    if (completedStop?.type === "fusion.completed") {
      expect(completedStop.payload.error).toBe("test stop");
    }

    const sideBEvent = events.find((e) => e.type === "fusion.side_completed");
    if (sideBEvent?.type === "fusion.side_completed") {
      expect(sideBEvent.payload.artifactPath).toBeNull();
      expect(sideBEvent.payload.model).toBe("openai/gpt-5.6-sol");
    }

    // Terminal sessions must not resurrect on late settled/running frames.
    events.length = 0;
    service.tools.markSessionStatus(sessionB, "settled");
    service.tools.markSessionStatus(sessionB, "running");
    const afterResurrect = service.tools
      .listSessions()
      .find((s) => s.sessionId === sessionB);
    expect(afterResurrect?.status).toBe("stopped");
    expect(events.map((e) => e.type)).not.toContain("fusion.completed");
    expect(events.map((e) => e.type)).not.toContain("fusion.side_completed");

    // Durable completedAt: hydrate must not re-arm a finished run.
    service.tools.hydrateFusionOwnership();
    events.length = 0;
    service.tools.markSessionStatus(sessionA, "settled");
    service.tools.markSessionStatus(sessionB, "settled");
    expect(events.map((e) => e.type)).not.toContain("fusion.completed");
    expect(service.fusionRuns.get(taskId, runId)?.completedAt).toBeTruthy();
  });

  // Boot-recovery kill-9 windows (property: side cannot still make progress).
  // 1) mid-dispatch never-spawned (null sessionId)
  // 2) halt-without-settle (status stopped)
  // 3) markSessionStatus(settled) before completeFusionSide (status settled, settledAt null)
  it("boot hydrate finalizes mid-dispatch runs left with a never-spawned side", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    // kill-9 mid-dispatch: first side persisted with a sessionId, second side
    // still sessionId null.
    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;

    const runId = "01JMIDDISPATCHFUSION000000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "mid-dispatch-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: null,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    mkdirSync(join(dirA, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirA, "outputs", `${sessionA}.md`), "partial side a\n", {
      mode: 0o600,
    });

    events.length = 0;
    // Daemon restart: rehydrate ownership and reconcile open runs.
    service.tools.hydrateFusionOwnership();

    const run = service.fusionRuns.get(taskId, runId);
    expect(run).not.toBeNull();
    expect(run!.completedAt).toBeTruthy();
    expect(run!.error).toMatch(/never spawned/);
    expect(run!.sides.every((s) => s.settledAt != null)).toBe(true);
    expect(run!.sides[0]?.sessionId).toBe(sessionA);
    expect(run!.sides[1]?.sessionId).toBeNull();
    expect(run!.sides[1]?.artifactPath).toBeNull();

    const types = events.map((e) => e.type);
    expect(types).toContain("fusion.side_completed");
    expect(types).toContain("fusion.completed");
    const completed = events.find((e) => e.type === "fusion.completed");
    if (completed?.type === "fusion.completed") {
      expect(completed.payload.error).toMatch(/never spawned/);
    }

    // All-settled but completedAt-null crash window: hydrate must complete.
    const settledRunId = "01JALLSETTLEDNOCOMPLETE00001";
    const settledAt = new Date().toISOString();
    service.fusionRuns.create({
      runId: settledRunId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "all-settled-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: "ghost-a",
          promptHash: "same",
          artifactPath: null,
          settledAt,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: "ghost-b",
          promptHash: "same",
          artifactPath: null,
          settledAt,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: settledAt,
    });
    events.length = 0;
    service.tools.hydrateFusionOwnership();
    const settledRun = service.fusionRuns.get(taskId, settledRunId);
    expect(settledRun?.completedAt).toBeTruthy();
    expect(events.map((e) => e.type)).toContain("fusion.completed");
  });

  it("boot hydrate finalizes sides whose durable sessions are already stopped", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    // kill-9-during-deliver-halt: panes stopped without completeFusionSide.
    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    expect(spawnB.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session
      .sessionId;

    const runId = "01JHALTEDFUSIONSTOPPED0000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "halted-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: sessionB,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    mkdirSync(join(dirA, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirA, "outputs", `${sessionA}.md`), "halted side a\n", {
      mode: 0o600,
    });

    // Simulate haltTaskSessions without completeFusionSide (kill-9 window).
    service.tools.markSessionStatus(sessionA, "stopped");
    service.tools.markSessionStatus(sessionB, "stopped");
    expect(service.fusionRuns.get(taskId, runId)?.completedAt == null).toBe(true);
    expect(
      service.fusionRuns.get(taskId, runId)?.sides.every((s) => s.settledAt == null),
    ).toBe(true);

    events.length = 0;
    service.tools.hydrateFusionOwnership();

    const run = service.fusionRuns.get(taskId, runId);
    expect(run).not.toBeNull();
    expect(run!.completedAt).toBeTruthy();
    expect(run!.sides.every((s) => s.settledAt != null)).toBe(true);
    expect(run!.sides[0]?.artifactPath).not.toBeNull();
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");
  });

  it("boot hydrate finalizes sides left settled without settledAt", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    // kill-9 between markSessionStatus(settled) and completeFusionSide:
    // durable session status is settled, fusion side still has null settledAt.
    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    expect(spawnB.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session
      .sessionId;

    const runId = "01JSETTLEDNULLATFUSION00000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "settled-null-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: sessionB,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    mkdirSync(join(dirA, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirA, "outputs", `${sessionA}.md`), "settled side a\n", {
      mode: 0o600,
    });

    // Persist status=settled without invoking completeFusionSide (the kill-9
    // window after task.json write, before fusion side settledAt is written).
    const task = service.tools.getTask(taskId);
    expect(task).not.toBeNull();
    const now = new Date().toISOString();
    service.tools.hydrateTask({
      ...task!,
      sessions: task!.sessions.map((s) =>
        s.sessionId === sessionA || s.sessionId === sessionB
          ? { ...s, status: "settled", lastEventAt: now }
          : s,
      ),
      updatedAt: now,
    });
    expect(
      service.tools
        .listSessions()
        .filter((s) => s.sessionId === sessionA || s.sessionId === sessionB)
        .every((s) => s.status === "settled"),
    ).toBe(true);
    expect(service.fusionRuns.get(taskId, runId)?.completedAt == null).toBe(true);
    expect(
      service.fusionRuns.get(taskId, runId)?.sides.every((s) => s.settledAt == null),
    ).toBe(true);

    events.length = 0;
    service.tools.hydrateFusionOwnership();

    const run = service.fusionRuns.get(taskId, runId);
    expect(run).not.toBeNull();
    expect(run!.completedAt).toBeTruthy();
    expect(run!.sides.every((s) => s.settledAt != null)).toBe(true);
    expect(run!.sides[0]?.artifactPath).not.toBeNull();
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");
  });

  it("does not re-attribute a prior /opinion run's bytes to a sequential same-cast run", () => {
    const { service } = fleet();
    const { taskId } = seedShipTask(service);
    const casts = [
      {
        role: "planner" as const,
        model: "anthropic/claude-fable-5",
        thinking: "high" as const,
        family: "anthropic" as const,
        cleanRoom: true,
      },
      {
        role: "planner" as const,
        model: "openai/gpt-5.6-sol",
        thinking: "low" as const,
        family: "openai" as const,
        cleanRoom: true,
      },
    ];

    const first = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts,
    });
    expect(first.ok).toBe(true);
    const runId1 = (first.data as { runId: string }).runId;
    const detail1 = service.fusionRuns.detail(taskId, runId1);
    expect(detail1?.sideArtifacts).toHaveLength(2);
    const firstBytes = detail1!.sideArtifacts.map((s) => s.content).sort();

    const second = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts,
    });
    expect(second.ok).toBe(true);
    const runId2 = (second.data as { runId: string }).runId;
    expect(runId2).not.toBe(runId1);
    const detail2 = service.fusionRuns.detail(taskId, runId2);
    expect(detail2?.sideArtifacts).toHaveLength(2);
    const secondBytes = detail2!.sideArtifacts.map((s) => s.content).sort();

    // Each run's artifacts embed its own session ids — never the prior run's.
    for (const content of secondBytes) {
      expect(firstBytes.includes(content)).toBe(false);
      expect(content).toMatch(/session=01/);
    }
    const run2 = service.fusionRuns.get(taskId, runId2)!;
    for (const side of run2.sides) {
      expect(side.sessionId).not.toBeNull();
      expect(
        detail2!.sideArtifacts.some((a) => a.content.includes(side.sessionId!)),
      ).toBe(true);
    }
  });

  it("finalizes a partial multi-side spawn failure instead of stranding dispatched", () => {
    const { service, events } = fleet();
    const { taskId } = seedShipTask(service);
    events.length = 0;

    // Inject a mid-cast lease failure on the second side. poolSize: 1 is no
    // longer enough: the first side settles and releases its lease before the
    // second spawn runs, so a real pool of one would succeed for both sides.
    const originalLease = service.worktrees.lease.bind(service.worktrees);
    let leaseCalls = 0;
    service.worktrees.lease = ((input: Parameters<typeof originalLease>[0]) => {
      leaseCalls += 1;
      if (leaseCalls >= 2) {
        throw new Error("worktree pool exhausted");
      }
      return originalLease(input);
    }) as typeof service.worktrees.lease;

    const result = service.tools.invoke("dispatch_fusion", {
      taskId,
      kind: "opinion",
      casts: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          thinking: "high",
          family: "anthropic",
          cleanRoom: true,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          thinking: "low",
          family: "openai",
          cleanRoom: true,
        },
      ],
    });
    expect(result.ok).toBe(false);

    const types = events.map((e) => e.type);
    expect(types).toContain("fusion.dispatched");
    // Every side — including never-spawned — must emit side_completed before completed.
    expect(types.filter((t) => t === "fusion.side_completed")).toHaveLength(2);
    expect(types).toContain("fusion.completed");
    const completed = events.find((e) => e.type === "fusion.completed");
    if (completed?.type === "fusion.completed") {
      expect(completed.payload.error).toBeTruthy();
    }

    const runs = service.fusionRuns.listForTask(taskId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs[0]!;
    expect(run.sides.every((s) => s.settledAt != null || s.artifactPath !== null)).toBe(
      true,
    );
    expect(run.completedAt).toBeTruthy();
    // First side got a session + artifact; the failed side has no session.
    expect(run.sides[0]?.sessionId).not.toBeNull();
    expect(run.sides[0]?.artifactPath).not.toBeNull();
    expect(run.sides[1]?.sessionId).toBeNull();
    expect(run.sides[1]?.settledAt).toBeTruthy();

    // Already-spawned side must be stopped so it does not hold a pool slot.
    const firstSessionId = run.sides[0]!.sessionId!;
    const firstSession = service.tools
      .listSessions()
      .find((s) => s.sessionId === firstSessionId);
    expect(firstSession?.status).toBe("stopped");
    expect(
      service.tools
        .listSessions()
        .filter(
          (s) =>
            s.taskId === taskId &&
            (s.status === "running" || s.status === "starting"),
        ),
    ).toHaveLength(0);
    expect(
      service.worktrees.list().filter((l) => l.state === "leased"),
    ).toHaveLength(0);
    expect(types).toContain("session.stopped");
  });

  it("cancel_task finalizes in-flight fusion sides instead of stranding them", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      vars: {},
    });
    expect(spawnA.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;

    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      vars: {},
    });
    expect(spawnB.ok).toBe(true);
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session
      .sessionId;

    const runId = "01JCANCELFUSION000000000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "cancel-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: sessionB,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    mkdirSync(join(dirA, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirA, "outputs", `${sessionA}.md`), "cancel side a\n", {
      mode: 0o600,
    });

    service.tools.hydrateFusionOwnership();
    events.length = 0;

    const cancelled = service.tools.invoke("cancel_task", {
      taskId,
      reason: "captain cancelled mid-opinion",
    });
    expect(cancelled.ok).toBe(true);
    expect((cancelled.data as { phase: string }).phase).toBe("CANCELLED");

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "fusion.side_completed")).toHaveLength(2);
    expect(types).toContain("fusion.completed");
    const completed = events.find((e) => e.type === "fusion.completed");
    expect(completed?.type).toBe("fusion.completed");
    if (completed?.type === "fusion.completed") {
      expect(completed.payload.error).toBe("captain cancelled mid-opinion");
    }

    const run = service.fusionRuns.get(taskId, runId);
    expect(run).not.toBeNull();
    expect(run!.sides.every((s) => s.settledAt != null)).toBe(true);
    expect(run!.sides[0]?.artifactPath).not.toBeNull();
    expect(run!.error).toBe("captain cancelled mid-opinion");

    // Hydrate must not re-arm a finished run after cancel.
    service.tools.hydrateFusionOwnership();
    events.length = 0;
    service.tools.markSessionStatus(sessionA, "settled");
    expect(events.map((e) => e.type)).not.toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).not.toContain("fusion.completed");
  });

  it("latches an earlier side failure when a later side settles cleanly", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      cleanRoom: true,
    });
    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      cleanRoom: true,
    });
    expect(spawnA.ok).toBe(true);
    expect(spawnB.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;
    const sessionB = (spawnB.data as { session: { sessionId: string } }).session
      .sessionId;

    const runId = "01JLATCHERRORFUSION000000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "latch-hash",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic",
          sessionId: sessionA,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: sessionB,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });

    const dirB = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    }).dir;
    mkdirSync(join(dirB, "outputs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dirB, "outputs", `${sessionB}.md`), "clean side b\n", {
      mode: 0o600,
    });

    service.tools.hydrateFusionOwnership();
    events.length = 0;

    // Side A fails first; side B settles cleanly second. Completion must keep
    // the failure rather than last-writer-wins success.
    service.tools.markSessionLost(sessionA, "pane died side A");
    service.tools.markSessionStatus(sessionB, "settled");

    const completed = events.find((e) => e.type === "fusion.completed");
    expect(completed?.type).toBe("fusion.completed");
    if (completed?.type === "fusion.completed") {
      expect(completed.payload.error).toContain("pane died side A");
    }
    const durable = service.fusionRuns.get(taskId, runId);
    expect(durable?.completedAt).toBeTruthy();
    expect(durable?.error).toContain("pane died side A");
    // session.lost is the only terminal lifecycle event for side A (no
    // intermediate session.stopped from releaseSettled).
    expect(
      events.filter(
        (e) =>
          e.type === "session.lost" &&
          e.payload.sessionId === sessionA,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.type === "session.stopped" &&
          e.payload.sessionId === sessionA,
      ),
    ).toHaveLength(0);
  });

  it("deliver_task abort finalizes in-flight fusion sides", () => {
    const { service, events } = fleet();
    const { taskId } = seedShipTask(service);

    // Builder first so phase is BUILDING (deliverable). Dirty tree aborts deliver.
    const spawnBuilder = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "anthropic/claude-fable-5",
      thinking: "low",
      vars: {},
    });
    expect(spawnBuilder.ok).toBe(true);
    const builderPath = (
      spawnBuilder.data as { session: { worktreePath: string } }
    ).session.worktreePath;

    // In-flight fusion side still open when deliver aborts.
    const spawnPlanner = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      vars: {},
    });
    expect(spawnPlanner.ok).toBe(true);
    const plannerSession = (
      spawnPlanner.data as { session: { sessionId: string } }
    ).session.sessionId;

    const runId = "01JDELIVERABORTFUSION0000001";
    service.fusionRuns.create({
      runId,
      taskId,
      kind: "opinion",
      templateRef: null,
      templateLayer: null,
      templateHash: null,
      renderedHash: "deliver-abort",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "openai/gpt-5.6-sol",
          family: "openai",
          sessionId: plannerSession,
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: null,
      contractOk: null,
      createdAt: new Date().toISOString(),
    });
    service.tools.hydrateFusionOwnership();

    writeFileSync(join(builderPath, "builder-wip.txt"), "must not discard\n");

    events.length = 0;
    const deliver = service.tools.invoke("deliver_task", { taskId });
    expect(deliver.ok).toBe(false);
    expect(deliver.error?.code).toBe("CONFLICT");

    const run = service.fusionRuns.get(taskId, runId);
    expect(run?.completedAt).toBeTruthy();
    expect(run?.sides[0]?.settledAt).toBeTruthy();
    expect(run?.error).toBeTruthy();
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");
    const completed = events.find((e) => e.type === "fusion.completed");
    if (completed?.type === "fusion.completed") {
      expect(completed.payload.error).toBeTruthy();
    }
  });

  it("reconcileMissingCastRoles continues after a failed respawn", () => {
    const { service, events } = fleet();
    const { taskId, projectId } = seedShipTask(service);

    const spawnA = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "anthropic/claude-fable-5",
      thinking: "high",
      vars: {},
    });
    expect(spawnA.ok).toBe(true);
    const sessionA = (spawnA.data as { session: { sessionId: string } }).session
      .sessionId;

    const spawnB = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
      thinking: "low",
      vars: {},
    });
    expect(spawnB.ok).toBe(true);

    const dirA = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "anthropic/claude-fable-5",
    }).dir;
    const dirB = service.sessionKeys.ensure({
      projectId,
      role: "planner",
      model: "openai/gpt-5.6-sol",
    }).dir;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });

    const originalLease = service.worktrees.lease.bind(service.worktrees);
    let leaseCalls = 0;
    service.worktrees.lease = ((input: Parameters<typeof originalLease>[0]) => {
      leaseCalls += 1;
      if (leaseCalls === 1) {
        throw new Error("worktree pool exhausted");
      }
      return originalLease(input);
    }) as typeof service.worktrees.lease;

    events.length = 0;
    const respawned = service.tools.reconcileMissingCastRoles();

    // First slot fails; second still respawns. Reconcile must not throw.
    expect(respawned).toEqual([
      {
        taskId,
        role: "planner",
        model: "openai/gpt-5.6-sol",
      },
    ]);
    expect(
      events.some(
        (e) =>
          e.type === "captain.escalation" &&
          e.payload.summary.includes("session-key reconcile failed") &&
          e.payload.summary.includes("anthropic/claude-fable-5"),
      ),
    ).toBe(true);
    expect(
      service.tools.listSessions().some(
        (s) =>
          s.model === "openai/gpt-5.6-sol" &&
          s.sessionId !==
            (spawnB.data as { session: { sessionId: string } }).session.sessionId &&
          (s.status === "running" || s.status === "starting" || s.status === "settled"),
      ),
    ).toBe(true);
    // Surviving failure path still marked the wiped first session lost.
    expect(
      service.tools.listSessions().some(
        (s) => s.sessionId === sessionA && s.status === "lost",
      ),
    ).toBe(true);
  });
});
