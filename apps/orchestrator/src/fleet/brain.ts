import { join } from "node:path";
import { monotonicFactory } from "ulid";
import type {
  BrainConfig,
  BrainSnapshot,
  OrchestratorEvent,
  ThinkingLevel,
  WakeDigest,
} from "@agent-os/protocol";
import type { ConnectionRegistry } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { buildPiSpawnSpec } from "../pi/manager.js";
import { familyFromModel } from "../substrate/family.js";
import type { TmuxController } from "./tmux.js";
import type { ToolSurface } from "./tool-surface.js";
import type { WakeWatcher } from "./watcher.js";

export type BrainEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

export interface BrainManagerDeps {
  home: string;
  tmux: TmuxController;
  tools: ToolSurface;
  watcher: WakeWatcher;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  extensionPath?: string;
  config: BrainConfig;
  /** Scripted brain for tests — deterministic tool sequences. */
  fakeBrain?: boolean;
}

/**
 * Orchestrator Brain lifecycle (master plan §5.1, §5.8, §5.11).
 * Long-lived Pi in tmux window `brain`. On start/respawn, first act is
 * read_fleet_state reconcile. BRAIN_DOWN queues wakes without deciding.
 */
export class BrainManager {
  private snapshot: BrainSnapshot;
  private sink: BrainEventSink = () => undefined;
  private config: BrainConfig;
  private readonly fake: boolean;

  constructor(private readonly deps: BrainManagerDeps) {
    this.config = deps.config;
    this.fake =
      deps.fakeBrain === true ||
      process.env.AGENTOS_FAKE_BRAIN === "1" ||
      deps.pi?.binary == null;
    this.snapshot = {
      status: "down",
      sessionId: null,
      model: null,
      thinking: null,
      family: null,
      provider: null,
      tmuxWindow: null,
      wakeQueueDepth: 0,
      lastReconcileAt: null,
      handoffFrom: null,
      handoffReason: null,
    };
    this.deps.tools.setBrainSnapshot(this.snapshot);
    this.deps.watcher.onDeliver((digest) => this.onWake(digest));
  }

  onEvent(sink: BrainEventSink): void {
    this.sink = sink;
  }

  updateConfig(config: BrainConfig): void {
    this.config = config;
  }

  getSnapshot(): BrainSnapshot {
    return {
      ...this.snapshot,
      wakeQueueDepth: this.deps.watcher.queueDepth(),
    };
  }

  /**
   * Start or respawn the Brain. Blocked when config.respawnBlocked (BRAIN_DOWN fixture).
   */
  start(reason = "boot"): BrainSnapshot {
    if (this.config.respawnBlocked) {
      this.enterDown(`respawn blocked (${reason})`);
      return this.getSnapshot();
    }

    const model = this.resolveModel();
    const thinking = this.config.thinking;
    const sessionId = nextUlid();
    const windowName = "brain";

    this.snapshot = {
      status: "starting",
      sessionId,
      model,
      thinking,
      family: familyFromModel(model),
      provider: null,
      tmuxWindow: `agentos:${windowName}`,
      wakeQueueDepth: this.deps.watcher.queueDepth(),
      lastReconcileAt: null,
      handoffFrom: this.snapshot.handoffFrom,
      handoffReason: this.snapshot.handoffReason,
    };
    this.deps.tools.setBrainSnapshot(this.snapshot);
    this.emitStatus("starting", reason);

    if (this.fake) {
      this.deps.tmux.newWindow({
        windowName,
        command: `echo fake-brain ${sessionId}`,
      });
    } else if (this.deps.pi !== undefined && this.deps.extensionPath !== undefined) {
      const prompt =
        "You are the Agent OS Orchestrator Brain. Your first tool call MUST be read_fleet_state. Make all judgment calls via the typed tool surface. Never edit code directly.";
      const spec = buildPiSpawnSpec({
        agentosHome: this.deps.home,
        detection: this.deps.pi,
        args: ["--mode", "json", "-p", prompt, "--model", model],
        cwd: this.deps.home,
        sessionId,
        socketPath: join(this.deps.home, "sockets", `${sessionId}.sock`),
        extensionPath: this.deps.extensionPath,
        cleanRoom: false,
      });
      const cmd = [spec.binary, ...spec.args]
        .map((s) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`))
        .join(" ");
      const win = this.deps.tmux.newWindow({ windowName, command: cmd });
      this.snapshot = { ...this.snapshot, tmuxWindow: win.target };
    } else {
      this.deps.tmux.newWindow({
        windowName,
        command: `echo brain-no-pi ${sessionId}`,
      });
    }

    // Reconcile: first act is always read_fleet_state
    this.deps.tools.invoke("read_fleet_state", {});
    this.snapshot = {
      ...this.snapshot,
      status: "running",
      lastReconcileAt: new Date().toISOString(),
      wakeQueueDepth: this.deps.watcher.queueDepth(),
    };
    this.deps.tools.setBrainSnapshot(this.snapshot);
    this.emitStatus("running", reason);

    // Drain any wakes queued during BRAIN_DOWN
    this.deps.watcher.drainQueue();
    return this.getSnapshot();
  }

  /** Enter BRAIN_DOWN — sessions stay alive; wakes queue; no orchestration. */
  enterDown(reason: string): void {
    this.snapshot = {
      ...this.snapshot,
      status: "down",
      wakeQueueDepth: this.deps.watcher.queueDepth(),
    };
    this.deps.tools.setBrainSnapshot(this.snapshot);
    this.sink({
      type: "brain.down",
      payload: {
        wakeQueueDepth: this.deps.watcher.queueDepth(),
        reason,
      },
    });
    this.emitStatus("down", reason);
  }

  /**
   * Scripted local-only SHIP path for gates (fake brain decides deterministically).
   * sequence: resolve_cast → spawn builder → deliver
   */
  runScriptedLocalShip(taskId: string, model = "openai/gpt-4.1"): void {
    this.deps.tools.invoke("resolve_cast", {
      taskId,
      roles: [{ role: "builder", model, thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    this.deps.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "medium",
      cleanRoom: true,
      vars: {},
      prompt: "local-only ship — implement and stop",
    });
    this.deps.tools.invoke("deliver_task", { taskId });
  }

  private onWake(digest: WakeDigest): void {
    if (this.snapshot.status === "down") return;
    // Fake brain: absorb settle digests; escalate security.
    if (this.fake) {
      if (digest.class === "SECURITY") {
        this.deps.tools.invoke("escalate_to_captain", {
          taskId: digest.taskId ?? undefined,
          summary: digest.summary,
          severity: "critical",
        });
      }
      // Otherwise no automatic action — scripted tests drive tools explicitly.
      return;
    }
    // Real brain: inject wake digest via tmux/control channel (Phase 3: best-effort send-keys).
    if (this.snapshot.tmuxWindow !== null) {
      try {
        this.deps.tmux.sendKeys(
          this.snapshot.tmuxWindow,
          `[wake] ${digest.class}: ${digest.summary}`,
        );
      } catch {
        // control path best-effort
      }
    }
  }

  private resolveModel(): string {
    if (this.config.cast !== "auto") {
      return this.config.cast;
    }
    // Auto-detect from connections preference order
    const connections = this.deps.connections?.list() ?? [];
    const healthy = connections.filter(
      (c) => c.health === "healthy" || c.health === "unknown" || c.health === "degraded",
    );
    for (const pref of this.config.preferenceOrder) {
      if (pref.includes("anthropic") && pref.includes("claude")) {
        const c = healthy.find(
          (x) => x.provider === "anthropic" || x.provider === "claude-agent-sdk",
        );
        if (c !== undefined) {
          if (c.billingMode === "subscription-sdk") {
            return "claude-agent-sdk/claude-sonnet-4-5";
          }
          return "anthropic/claude-sonnet-4-5";
        }
      }
      if (pref.includes("anthropic") && pref.includes("api-key")) {
        const c = healthy.find(
          (x) =>
            (x.provider === "anthropic" ||
              x.provider === "openrouter" ||
              x.provider === "vercel-ai-gateway") &&
            x.kind === "pi-api-key",
        );
        if (c !== undefined) return "anthropic/claude-sonnet-4-5";
      }
      if (pref.includes("openai") || pref.includes("chatgpt")) {
        const c = healthy.find((x) => x.provider === "openai");
        if (c !== undefined) return "openai/gpt-4.1";
      }
      if (pref.includes("xai")) {
        const c = healthy.find((x) => x.provider === "xai");
        if (c !== undefined) return "xai/grok-3";
      }
    }
    // Fallback for offline/fixture
    return "openai/gpt-4.1";
  }

  private emitStatus(status: BrainSnapshot["status"], reason: string): void {
    this.sink({
      type: "brain.status",
      payload: {
        status,
        sessionId: this.snapshot.sessionId,
        model: this.snapshot.model,
        reason,
      },
    });
  }
}

export type { ThinkingLevel };
