import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHIPPED_DEFAULTS_DIR, SHIPPED_PROMPTS_DIR } from "../src/daemon.js";
import { ConfigService } from "../src/config/service.js";
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

  it("wires session dirs into live spawns and hands AGENTOS_SESSION_DIR to Pi", () => {
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

    // buildPiSpawnSpec carries AGENTOS_SESSION_DIR through the scrubbed env.
    const detection: PiDetection = {
      binary: "/usr/bin/true",
      version: "0.0.0-test",
      pinnedVersion: "0.82.0" as PiDetection["pinnedVersion"],
      versionMatchesPin: false,
      managedHome: temp("agentos-p4-pi-home-"),
      configDirEnv: "PI_CONFIG_DIR",
      isolationMode: "managed",
    };
    const spec = buildPiSpawnSpec({
      agentosHome: temp("agentos-p4-spec-home-"),
      detection,
      args: ["-p", "hi", "--model", "openai/gpt-4.1"],
      cwd: temp("agentos-p4-spec-cwd-"),
      sessionId: "01JSESSION000000000000000A",
      role: "planner",
      socketPath: "/tmp/agentos-test.sock",
      extensionPath: join(temp("agentos-p4-ext-"), "ext.js"),
      sessionDir: dirB,
      cleanRoom: true,
    });
    expect(spec.env.AGENTOS_SESSION_DIR).toBe(dirB);
    expect(spec.envKeys).toContain("AGENTOS_SESSION_DIR");

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
    expect(events.map((e) => e.type)).toContain("fusion.side_completed");
    expect(events.map((e) => e.type)).toContain("fusion.completed");

    const sideBEvent = events.find((e) => e.type === "fusion.side_completed");
    if (sideBEvent?.type === "fusion.side_completed") {
      expect(sideBEvent.payload.artifactPath).toBeNull();
      expect(sideBEvent.payload.model).toBe("openai/gpt-5.6-sol");
    }
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

    // Only one worktree slot: first side spawns, second fails mid-cast.
    service.worktrees.updateConfig({
      poolSize: 1,
      reclaimPolicy: "verified-reset",
      networkPolicy: "fetch-allowed",
    });

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
});
