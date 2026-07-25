import { existsSync } from "node:fs";
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
import { resolveProviderKeyGrant } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { buildPiSpawnSpec } from "../pi/manager.js";
import { familyFromModel } from "../substrate/family.js";
import type { TmuxController } from "./tmux.js";
import type { SessionChannel, ToolSurface } from "./tool-surface.js";
import type { WakeWatcher } from "./watcher.js";

export type BrainEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

/**
 * The Brain is an LLM, not a rule engine — but it acts only through the typed
 * tool surface, and the substrate rejects illegal moves regardless of what it
 * decides here.
 */
const BRAIN_SYSTEM_PROMPT = [
  "You are the Agent OS Orchestrator Brain.",
  "Your first tool call MUST be read_fleet_state, so you reconcile against reality before deciding anything.",
  "Make every judgment call through the typed agent-os tool surface: intake, cast resolution, spawning, gate authoring, escalation, delivery.",
  "Never edit code, never run shell commands, never touch a worktree — crewmates do the work.",
  "Illegal state transitions and policy violations come back as typed tool errors; read them and choose a legal next move.",
].join(" ");

export interface BrainManagerDeps {
  home: string;
  tmux: TmuxController;
  tools: ToolSurface;
  watcher: WakeWatcher;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  extensionPath?: string;
  sockets?: SessionChannel;
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
    // Explicit seam only. A missing Pi means the Brain cannot run, which is
    // BRAIN_DOWN — not a window that echoes a string and reports "running".
    this.fake = deps.fakeBrain === true || process.env.AGENTOS_FAKE_BRAIN === "1";
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
   * Always tears down any prior Brain pane/socket before spawning so respawn and
   * daemon-restart reclaim cannot leave an unauthorized live pane in BRAIN_DOWN.
   */
  start(reason = "boot"): BrainSnapshot {
    if (this.config.respawnBlocked) {
      this.teardownPriorBrain();
      this.enterDown(`respawn blocked (${reason})`);
      return this.getSnapshot();
    }

    this.teardownPriorBrain();

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
      // Long-lived pane so daemon restart / reconcile does not treat the Brain as dead
      // after a short-lived `echo` exits under real tmux.
      this.deps.tmux.newWindow({
        windowName,
        argv: ["sh", "-c", `echo fake-brain ${sessionId}; exec sleep 86400`],
      });
      this.deps.tools.setBrainSessionId(sessionId);
    } else {
      if (
        this.deps.pi?.binary == null ||
        this.deps.extensionPath === undefined ||
        !existsSync(this.deps.extensionPath)
      ) {
        this.enterDown(
          this.deps.pi?.binary == null
            ? "Pi is not installed — run onboarding to install the pinned Pi"
            : "agent-os Pi extension unavailable",
        );
        return this.getSnapshot();
      }
      let socketPath: string;
      try {
        if (this.deps.sockets !== undefined) {
          socketPath = this.deps.sockets.openSession(sessionId);
        } else {
          socketPath = join(this.deps.home, "sockets", `${sessionId}.sock`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.enterDown(`session control channel failed to open: ${message}`);
        return this.getSnapshot();
      }
      this.deps.tools.setBrainSessionId(sessionId);

      try {
        const grant = resolveProviderKeyGrant(
          this.deps.home,
          model,
          this.deps.connections,
        );
        const spec = buildPiSpawnSpec({
          agentosHome: this.deps.home,
          detection: this.deps.pi,
          args: ["--mode", "json", "-p", BRAIN_SYSTEM_PROMPT, "--model", model],
          cwd: this.deps.home,
          sessionId,
          role: "brain",
          socketPath,
          extensionPath: this.deps.extensionPath,
          cleanRoom: false,
          grantProviderKey: grant,
        });
        const win = this.deps.tmux.newWindow({
          windowName,
          argv: [spec.binary, ...spec.args],
          env: spec.env,
        });
        this.snapshot = { ...this.snapshot, tmuxWindow: win.target };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.tools.setBrainSessionId(null);
        void this.deps.sockets?.closeSession(sessionId);
        this.enterDown(`brain spawn failed: ${message}`);
        return this.getSnapshot();
      }
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
   * Kill any surviving brain tmux window, close its control socket, and clear
   * the authorized brain session id so a respawn cannot collide or leave a
   * live pane unauthorized while the fleet is in BRAIN_DOWN.
   */
  private teardownPriorBrain(): void {
    const priorSessionId = this.snapshot.sessionId;
    const priorWindow = this.snapshot.tmuxWindow;
    const targets = new Set<string>(["agentos:brain"]);
    if (priorWindow !== null) targets.add(priorWindow);
    for (const target of targets) {
      if (this.deps.tmux.hasWindow(target)) {
        try {
          this.deps.tmux.killWindow(target);
        } catch {
          // best-effort reclaim
        }
      }
    }
    if (priorSessionId !== null) {
      void this.deps.sockets?.closeSession(priorSessionId).catch(() => undefined);
    }
    this.deps.tools.setBrainSessionId(null);
  }

  /**
   * Scripted local-only SHIP path for gates (fake brain decides deterministically).
   * sequence: resolve_cast → spawn builder → stop crewmate → deliver
   */
  runScriptedLocalShip(taskId: string, model = "openai/gpt-4.1"): void {
    this.deps.tools.invoke("resolve_cast", {
      taskId,
      roles: [{ role: "builder", model, thinking: "medium", cleanRoom: true }],
      familyCheckOverride: false,
    });
    const spawned = this.deps.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "medium",
      cleanRoom: true,
      vars: {},
      prompt: "local-only ship — implement and stop",
    });
    if (spawned.ok === true && spawned.data !== undefined) {
      const sessionId = (spawned.data as { session?: { sessionId?: string } }).session
        ?.sessionId;
      if (typeof sessionId === "string") {
        this.deps.tools.invoke("stop_crewmate", {
          sessionId,
          reason: "scripted local-only ship complete",
        });
      }
    }
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
    // Real brain: deliver the digest over its control socket; fall back to the
    // tmux pane if the extension channel has not (re)connected yet.
    const message = `[wake] ${digest.class}: ${digest.summary}`;
    const sessionId = this.snapshot.sessionId;
    const sent =
      sessionId !== null &&
      (this.deps.sockets?.sendControl(sessionId, {
        type: "ctl.injectMessage",
        sessionId,
        message,
        ts: new Date().toISOString(),
      }) ??
        false);
    if (!sent && this.snapshot.tmuxWindow !== null) {
      try {
        this.deps.tmux.sendKeys(this.snapshot.tmuxWindow, message);
      } catch {
        // The pane may have died; the watcher's liveness sweep handles it.
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
