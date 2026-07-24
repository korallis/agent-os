import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionToDaemonFrame,
  FleetSummary,
  OrchestratorEvent,
  TaskListItem,
  TaskSnapshot,
} from "@agent-os/protocol";
import type { ConfigService } from "../config/service.js";
import type { ConnectionRegistry } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { ProjectRegistry } from "./projects.js";
import { WorktreePool } from "./worktree-pool.js";
import { TmuxController } from "./tmux.js";
import { WakeWatcher } from "./watcher.js";
import { GateRunner } from "./gate-runner.js";
import { ToolSurface, type SessionChannel } from "./tool-surface.js";
import { BrainManager } from "./brain.js";

export type FleetEventSink = (event: OrchestratorEvent) => void;

export interface FleetServiceOptions {
  home: string;
  config: ConfigService;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  extensionPath?: string;
  sockets?: SessionChannel;
  fakeTmux?: boolean;
  fakePi?: boolean;
  fakeBrain?: boolean;
}

/**
 * Fleet service facade — owns projects, worktrees, tools, watcher, brain.
 */
export class FleetService {
  readonly projects: ProjectRegistry;
  readonly worktrees: WorktreePool;
  readonly tmux: TmuxController;
  readonly watcher: WakeWatcher;
  readonly gates: GateRunner;
  readonly tools: ToolSurface;
  readonly brain: BrainManager;
  private sink: FleetEventSink = () => undefined;

  constructor(private readonly options: FleetServiceOptions) {
    const cfg = options.config.effective().config;
    this.projects = new ProjectRegistry(options.home);
    this.worktrees = new WorktreePool(options.home, cfg.worktrees);
    this.tmux = new TmuxController({
      fake: options.fakeTmux === true || process.env.AGENTOS_FAKE_TMUX === "1",
    });
    this.watcher = new WakeWatcher(cfg.supervision);
    this.gates = new GateRunner(options.home, cfg.validation);
    this.tools = new ToolSurface({
      home: options.home,
      config: options.config,
      projects: this.projects,
      worktrees: this.worktrees,
      tmux: this.tmux,
      watcher: this.watcher,
      gates: this.gates,
      ...(options.connections !== undefined ? { connections: options.connections } : {}),
      ...(options.pi !== undefined ? { pi: options.pi } : {}),
      ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
      ...(options.sockets !== undefined ? { sockets: options.sockets } : {}),
      ...(options.fakePi !== undefined ? { fakePi: options.fakePi } : {}),
    });
    this.brain = new BrainManager({
      home: options.home,
      tmux: this.tmux,
      tools: this.tools,
      watcher: this.watcher,
      config: cfg.brain,
      ...(options.connections !== undefined ? { connections: options.connections } : {}),
      ...(options.pi !== undefined ? { pi: options.pi } : {}),
      ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
      ...(options.sockets !== undefined ? { sockets: options.sockets } : {}),
      ...(options.fakeBrain !== undefined ? { fakeBrain: options.fakeBrain } : {}),
    });

    this.hydrateTasks();
  }

  onEvent(sink: FleetEventSink): void {
    this.sink = sink;
    const fanout = (event: OrchestratorEvent): void => {
      this.sink(event);
    };
    this.projects.onEvent(fanout);
    this.worktrees.onEvent(fanout);
    this.watcher.onEvent(fanout);
    this.tools.onEvent(fanout);
    this.brain.onEvent(fanout);
  }

  /** Boot: start brain (or enter BRAIN_DOWN if blocked). */
  start(): void {
    this.brain.start("daemon-boot");
  }

  /**
   * Single entry point for everything a session's Pi extension reports.
   * Lifecycle drives the zero-token watcher, usage drives context pressure,
   * and `ext.tool_call` is the Brain's only way to act on the fleet.
   */
  handleExtensionFrame(frame: ExtensionToDaemonFrame): void {
    switch (frame.type) {
      case "ext.hello":
        break;
      case "ext.lifecycle":
        this.onLifecycle(frame);
        break;
      case "ext.usage":
        if (frame.contextUsedPct !== null) {
          this.watcher.classify({
            class: "CONTEXT_PRESSURE",
            sessionId: frame.sessionId,
            summary: `context ${frame.contextUsedPct}% used on ${frame.model}`,
            contextUsedPct: frame.contextUsedPct,
          });
        }
        break;
      case "ext.tool_blocked":
        this.watcher.classify({
          class: "SECURITY",
          sessionId: frame.sessionId,
          summary: `tool ${frame.toolName} blocked: ${frame.reason}`,
        });
        break;
      case "ext.question":
        this.tools.recordQuestion({
          questionId: frame.questionId,
          sessionId: frame.sessionId,
          question: frame.question,
        });
        break;
      case "ext.tool_call":
        this.onToolCall(frame);
        break;
      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  }

  private onLifecycle(
    frame: Extract<ExtensionToDaemonFrame, { type: "ext.lifecycle" }>,
  ): void {
    switch (frame.phase) {
      case "turn_start":
      case "tool_call":
      case "tool_result":
        this.watcher.classify({
          class: "PROGRESS",
          sessionId: frame.sessionId,
          summary: frame.detail ?? frame.phase,
        });
        break;
      case "turn_end":
        this.watcher.classify({
          class: "TURN_SETTLED",
          sessionId: frame.sessionId,
          summary: frame.detail ?? "turn end",
        });
        break;
      case "agent_settled":
        this.tools.markSessionStatus(frame.sessionId, "settled");
        this.watcher.classify({
          class: "AGENT_SETTLED",
          sessionId: frame.sessionId,
          summary: frame.detail ?? "agent settled",
        });
        break;
      case "session_end":
        this.tools.markSessionStatus(frame.sessionId, "settled");
        void this.options.sockets?.closeSession(frame.sessionId).catch(() => undefined);
        break;
      case "session_start":
        this.tools.markSessionStatus(frame.sessionId, "running");
        break;
      default: {
        const _exhaustive: never = frame.phase;
        void _exhaustive;
      }
    }
  }

  private onToolCall(
    frame: Extract<ExtensionToDaemonFrame, { type: "ext.tool_call" }>,
  ): void {
    const result = this.tools.invokeFromSession(frame.sessionId, frame.tool, frame.input);
    this.sink({
      type: "bridge.tool_call",
      payload: {
        sessionId: frame.sessionId,
        invocationId: frame.invocationId,
        tool: frame.tool,
        accepted: result.ok,
        reason: result.ok ? null : (result.error?.message ?? null),
      },
    });
    this.options.sockets?.sendControl(frame.sessionId, {
      type: "ctl.tool_result",
      sessionId: frame.sessionId,
      invocationId: frame.invocationId,
      ok: result.ok,
      ...(result.ok ? { data: result.data } : {}),
      ...(result.error !== undefined
        ? { error: { code: result.error.code, message: result.error.message } }
        : {}),
      ts: new Date().toISOString(),
    });
  }

  stop(): void {
    // leave tmux windows alive — they survive daemon restarts
  }

  reloadConfig(): void {
    const cfg = this.options.config.effective().config;
    this.worktrees.updateConfig(cfg.worktrees);
    this.watcher.updateConfig(cfg.supervision);
    this.gates.updateConfig(cfg.validation);
    this.brain.updateConfig(cfg.brain);
  }

  summary(): FleetSummary {
    const tasks = this.tools.listTasks();
    const active = tasks.filter((t) =>
      ["BUILDING", "VALIDATING", "PLANNING", "GATE_AUTHORING", "DELIVERING", "PLAN_FUSED", "GATE_RED_VERIFIED", "DISPATCH_RESOLVED"].includes(
        t.phase,
      ),
    ).length;
    const queued = tasks.filter((t) => t.phase === "QUEUED" || t.phase === "WAITING_WORKTREE").length;
    const needsCaptain = tasks.filter((t) => t.phase === "NEEDS_CAPTAIN").length;
    const failed = tasks.filter((t) => t.phase === "FAILED").length;
    const today = new Date().toISOString().slice(0, 10);
    const doneToday = tasks.filter(
      (t) => t.phase === "DONE" && t.updatedAt.startsWith(today),
    ).length;
    const brain = this.brain.getSnapshot();
    return {
      active,
      queued,
      needsCaptain,
      doneToday,
      failed,
      brain,
      brainDown: brain.status === "down",
    };
  }

  listTaskItems(): TaskListItem[] {
    const projects = new Map(this.projects.list().map((p) => [p.id, p]));
    return this.tools.listTasks().map((t) => taskToListItem(t, projects.get(t.projectId)?.name ?? null));
  }

  private hydrateTasks(): void {
    const runsDir = join(this.options.home, "runs");
    if (!existsSync(runsDir)) return;
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskPath = join(runsDir, entry.name, "task.json");
      if (!existsSync(taskPath)) continue;
      try {
        const task = JSON.parse(readFileSync(taskPath, "utf8")) as TaskSnapshot;
        this.tools.hydrateTask(task);
      } catch {
        // skip corrupt
      }
    }
  }
}

function taskToListItem(task: TaskSnapshot, projectName: string | null): TaskListItem {
  const primary = task.sessions[0] ?? null;
  const castRole = task.cast[0] ?? null;
  return {
    id: task.id,
    shape: task.shape,
    title: task.title,
    phase: task.phase,
    projectId: task.projectId,
    projectName,
    mode: task.mode,
    model: primary?.model ?? castRole?.model ?? null,
    agent: primary?.role ?? castRole?.role ?? null,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  };
}
