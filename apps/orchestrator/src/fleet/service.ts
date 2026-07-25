import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DaemonControlFrame,
  QuotaSample,
  ExtensionToDaemonFrame,
  FleetSummary,
  OrchestratorEvent,
  TaskListItem,
  TaskSnapshot,
} from "@agent-os/protocol";
import { readLog } from "@agent-os/event-store";
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
import { FusionRunStore } from "./fusion-runs.js";
import { SessionKeyStore } from "./sessions.js";
import { SecondmateRegistry } from "./secondmates.js";
import { SecondmateFleet } from "./secondmate-fleet.js";
// SecondmateRegistry type used in provisionSecondmate return type
import type { PromptService } from "../prompts/service.js";
import { AfkService } from "./afk.js";
import {
  decideHandoff,
  worstWindowPctFromSample,
  type HandoffCandidate,
} from "./brain-handoff.js";
import type { PiAuthBroker } from "../pi/auth-broker.js";

export type FleetEventSink = (event: OrchestratorEvent) => void;

export interface FleetServiceOptions {
  home: string;
  config: ConfigService;
  connections?: ConnectionRegistry;
  pi?: PiDetection;
  authBroker?: PiAuthBroker;
  extensionPath?: string;
  sockets?: SessionChannel;
  prompts?: PromptService;
  fakeTmux?: boolean;
  fakePi?: boolean;
  fakeBrain?: boolean;
  /** Latest quota samples, read live so handoff decisions use current numbers. */
  quotaSamples?: () => QuotaSample[];
  /** Absolute path to agentosd.js for spawning secondmate processes. */
  agentosdBin?: string;
}

/**
 * Brain-capable default model per provider. Deliberately conservative: a
 * handoff target must be a model we already spawn Brains on, not whatever the
 * provider happens to offer.
 *
 * Gateway providers emit provider-qualified refs so a routed Sonnet
 * (`openrouter/anthropic/…`) is a distinct string from an OAuth Sonnet
 * (`anthropic/…`). Without that prefix, pickTarget's `c !== currentModel`
 * filter drops the default same-family refuge and handoff never moves.
 */
const DEFAULT_BRAIN_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "anthropic/claude-sonnet-4-5",
  "claude-agent-sdk": "claude-agent-sdk/claude-sonnet-4-5",
  openai: "openai/gpt-4.1",
  xai: "xai/grok-3",
  openrouter: "openrouter/anthropic/claude-sonnet-4-5",
  "vercel-ai-gateway": "vercel-ai-gateway/anthropic/claude-sonnet-4-5",
};

/** Min interval between successful Brain handoffs — stops thrashing every heartbeat. */
const BRAIN_HANDOFF_COOLDOWN_MS = 5 * 60 * 1000;
/** After a failed land, wait this long before reminting a session. */
const BRAIN_HANDOFF_RETRY_BACKOFF_MS = 30 * 1000;

/** Routing provider id = first segment of a `provider/…` model ref. */
function modelRoutingProvider(model: string): string {
  const slash = model.indexOf("/");
  return (slash === -1 ? model : model.slice(0, slash)).toLowerCase();
}

type PendingToolResult = {
  frame: Extract<DaemonControlFrame, { type: "ctl.tool_result" }>;
  tool: string;
  accepted: boolean;
  reason: string | null;
};

/**
 * Fleet service facade — owns projects, worktrees, tools, watcher, brain.
 */
export class FleetService {
  readonly projects: ProjectRegistry;
  readonly worktrees: WorktreePool;
  readonly tmux: TmuxController;
  readonly watcher: WakeWatcher;
  readonly gates: GateRunner;
  readonly fusionRuns: FusionRunStore;
  readonly sessionKeys: SessionKeyStore;
  readonly secondmates: SecondmateRegistry;
  readonly secondmateFleet: SecondmateFleet;
  readonly tools: ToolSurface;
  readonly brain: BrainManager;
  readonly afk: AfkService;
  private sink: FleetEventSink = () => undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** ctl.tool_result frames that failed sendControl; retried on session re-hello. */
  private readonly pendingToolResults = new Map<string, PendingToolResult[]>();
  /**
   * Last budget handoff attempt — seeded from durable handoff.json on boot so a
   * restart cannot bypass the cooldown. `landed` selects success cooldown vs
   * short retry backoff.
   */
  private lastHandoff: { atMs: number; toModel: string; landed: boolean } | null = null;

  constructor(private readonly options: FleetServiceOptions) {
    const cfg = options.config.effective().config;
    this.projects = new ProjectRegistry(options.home);
    this.worktrees = new WorktreePool(options.home, cfg.worktrees);
    this.tmux = new TmuxController({
      fake: options.fakeTmux === true || process.env.AGENTOS_FAKE_TMUX === "1",
    });
    this.watcher = new WakeWatcher(cfg.supervision);
    this.gates = new GateRunner(options.home, cfg.validation);
    this.fusionRuns = new FusionRunStore(options.home);
    this.sessionKeys = new SessionKeyStore(options.home);
    this.afk = new AfkService(join(options.home, "afk"));
    this.secondmates = new SecondmateRegistry(options.home);
    this.secondmateFleet = new SecondmateFleet(this.secondmates);
    this.tools = new ToolSurface({
      home: options.home,
      config: options.config,
      projects: this.projects,
      worktrees: this.worktrees,
      tmux: this.tmux,
      watcher: this.watcher,
      gates: this.gates,
      fusionRuns: this.fusionRuns,
      sessionKeys: this.sessionKeys,
      secondmates: { registry: this.secondmates, fleet: this.secondmateFleet },
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
      ...(options.connections !== undefined ? { connections: options.connections } : {}),
      ...(options.authBroker !== undefined ? { authBroker: options.authBroker } : {}),
      ...(options.pi !== undefined ? { pi: options.pi } : {}),
      ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
      ...(options.sockets !== undefined ? { sockets: options.sockets } : {}),
      ...(options.fakePi !== undefined ? { fakePi: options.fakePi } : {}),
      afk: this.afk,
    });
    this.brain = new BrainManager({
      home: options.home,
      tmux: this.tmux,
      tools: this.tools,
      watcher: this.watcher,
      sessionKeys: this.sessionKeys,
      config: cfg.brain,
      ...(options.connections !== undefined ? { connections: options.connections } : {}),
      ...(options.authBroker !== undefined ? { authBroker: options.authBroker } : {}),
      ...(options.pi !== undefined ? { pi: options.pi } : {}),
      ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
      ...(options.sockets !== undefined ? { sockets: options.sockets } : {}),
      ...(options.fakeBrain !== undefined ? { fakeBrain: options.fakeBrain } : {}),
    });

    this.hydrateTasks();
    this.hydrateRedProofsFromEventLog();
    this.rehydrateRuntime();
    this.seedHandoffCooldownFromDurable();
  }

  /**
   * Seed the in-memory cooldown from the durable handoff record so a daemon
   * bounce cannot immediately re-handoff while two providers stay over threshold.
   */
  private seedHandoffCooldownFromDurable(): void {
    const durable = this.brain.durableHandoff();
    if (durable === null) return;
    const atMs = Date.parse(durable.at);
    if (!Number.isFinite(atMs)) return;
    this.lastHandoff = {
      atMs,
      toModel: durable.toModel,
      landed: durable.landed,
    };
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
    this.afk.onEvent(fanout);
    this.secondmates.onEvent(fanout);
    this.secondmateFleet.onEvent(fanout);
  }

  /** Boot: start brain (or enter BRAIN_DOWN if blocked) and the pane-liveness tick. */
  async start(): Promise<void> {
    await this.brain.start("daemon-boot");
    this.startReconcileTick();
  }

  /**
   * Single entry point for everything a session's Pi extension reports.
   * Lifecycle drives the zero-token watcher, usage drives context pressure,
   * and `ext.tool_call` is the Brain's only way to act on the fleet.
   */
  handleExtensionFrame(frame: ExtensionToDaemonFrame): void {
    switch (frame.type) {
      case "ext.hello":
        this.flushPendingToolResults(frame.sessionId);
        break;
      case "ext.lifecycle":
        this.onLifecycle(frame);
        break;
      case "ext.usage":
        // Per-side fusion telemetry: attribute the tokens to whichever fusion
        // run owns this session, so the Console's side-by-side shows real cost.
        this.tools.attributeFusionUsage(frame.sessionId, {
          inputTokens: frame.inputTokens,
          outputTokens: frame.outputTokens,
          costUsd: frame.costUsd,
        });
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
        // Fast path for extension-driven end: settle cleanly when still live.
        // SIGKILL / pane death without session_end is handled by reconcileDeadPanes.
        // Release the worktree lease the same way stop_crewmate does so normal
        // settle-and-exit does not exhaust the pool.
        this.tools.markSessionStatus(frame.sessionId, "settled");
        this.tools.releaseSessionOnEnd(frame.sessionId);
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
    void this.onToolCallAsync(frame);
  }

  private async onToolCallAsync(
    frame: Extract<ExtensionToDaemonFrame, { type: "ext.tool_call" }>,
  ): Promise<void> {
    const result = await this.tools.invokeFromSessionAsync(
      frame.sessionId,
      frame.tool,
      frame.input,
    );
    const reason = result.ok ? null : (result.error?.message ?? null);
    const controlFrame: Extract<DaemonControlFrame, { type: "ctl.tool_result" }> = {
      type: "ctl.tool_result",
      sessionId: frame.sessionId,
      invocationId: frame.invocationId,
      ok: result.ok,
      ...(result.ok ? { data: result.data } : {}),
      ...(result.error !== undefined
        ? { error: { code: result.error.code, message: result.error.message } }
        : {}),
      ts: new Date().toISOString(),
    };
    const delivered = this.options.sockets?.sendControl(frame.sessionId, controlFrame) ?? false;
    this.sink({
      type: "bridge.tool_call",
      payload: {
        sessionId: frame.sessionId,
        invocationId: frame.invocationId,
        tool: frame.tool,
        accepted: result.ok,
        reason: delivered
          ? reason
          : (reason ?? "tool_result undelivered — will retry on re-hello"),
        delivered,
      },
    });
    if (!delivered) {
      const queue = this.pendingToolResults.get(frame.sessionId) ?? [];
      queue.push({
        frame: controlFrame,
        tool: frame.tool,
        accepted: result.ok,
        reason,
      });
      this.pendingToolResults.set(frame.sessionId, queue);
    }
  }

  private flushPendingToolResults(sessionId: string): void {
    const queue = this.pendingToolResults.get(sessionId);
    if (queue === undefined || queue.length === 0) return;
    const remaining: PendingToolResult[] = [];
    for (const pending of queue) {
      const delivered = this.options.sockets?.sendControl(sessionId, pending.frame) ?? false;
      if (!delivered) {
        remaining.push(pending);
        continue;
      }
      this.sink({
        type: "bridge.tool_call",
        payload: {
          sessionId,
          invocationId: pending.frame.invocationId,
          tool: pending.tool,
          accepted: pending.accepted,
          reason: pending.reason,
          delivered: true,
        },
      });
    }
    if (remaining.length === 0) {
      this.pendingToolResults.delete(sessionId);
    } else {
      this.pendingToolResults.set(sessionId, remaining);
    }
  }

  /**
   * Provision a secondmate through the fleet surface (REST / tools / CLI).
   * Seeds charter + brain cast under the isolated home.
   */
  provisionSecondmate(input: {
    name: string;
    domain: string;
    port?: number;
    brainModel?: string;
    maxConcurrentTasks?: number;
  }): ReturnType<SecondmateRegistry["provision"]> {
    return this.secondmates.provision(input);
  }

  /**
   * Start a provisioned secondmate as a live agentosd process.
   * Waits until the secondmate is healthy. Token lives under primary runtime/;
   * shared Pi home is the primary managed pi. Charter brainModel is applied
   * to the secondmate brain config before spawn.
   */
  async startSecondmate(name: string): Promise<{
    name: string;
    pid: number;
    port: number;
    tokenPath: string;
    startedAt: string;
  }> {
    const agentosdBin = this.options.agentosdBin;
    if (agentosdBin === undefined) {
      throw new Error("agentosd binary path not configured — cannot start secondmate");
    }
    const record = this.secondmates.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    const { charter } = this.secondmateFleet.readCharter(record);
    this.secondmateFleet.applyCharterToBrainConfig(record, charter);
    const sharedPiHome =
      this.options.pi?.managedHome ??
      `${this.options.home}/pi`;
    return this.secondmates.start(name, {
      agentosdBin,
      sharedPiHome,
      env: {
        AGENTOS_FAKE_PI: process.env.AGENTOS_FAKE_PI,
        AGENTOS_FAKE_BRAIN: process.env.AGENTOS_FAKE_BRAIN,
        AGENTOS_FAKE_GATE: process.env.AGENTOS_FAKE_GATE,
        AGENTOS_FAKE_GIT: process.env.AGENTOS_FAKE_GIT,
        AGENTOS_FAKE_TMUX: process.env.AGENTOS_FAKE_TMUX,
        AGENTOS_TMUX_SOCKET: process.env.AGENTOS_TMUX_SOCKET,
      },
    });
  }

  async stopSecondmate(name: string): Promise<{ stopped: boolean; name: string }> {
    return this.secondmates.stop(name);
  }

  /**
   * Write + sync a secondmate charter. When the secondmate is running, pushes
   * brain cast via its REST API and respawns its Brain so the live model moves.
   */
  async syncSecondmateCharter(
    name: string,
    charter: {
      name: string;
      domains: string[];
      brainModel: string | null;
      maxConcurrentTasks: number;
      acceptsRouting: boolean;
    },
  ): Promise<{ charter: typeof charter; brainSynced: boolean; brainModel: string | null }> {
    const record = this.secondmates.get(name);
    if (record === null) {
      throw new Error(`no secondmate named ${name}`);
    }
    return this.secondmateFleet.syncCharter(record, charter);
  }

  async stop(): Promise<void> {
    await this.secondmates.stopAll();
    // leave tmux windows alive — they survive daemon restarts
    this.stopReconcileTick();
  }

  /**
   * Re-read effective config into fleet subsystems. When `restartBrain` is
   * true (brain domain writes / charter sync), respawn so resolveModel() takes
   * effect on the live snapshot.
   */
  async reloadConfig(options: { restartBrain?: boolean } = {}): Promise<void> {
    const cfg = this.options.config.effective().config;
    this.worktrees.updateConfig(cfg.worktrees);
    this.watcher.updateConfig(cfg.supervision);
    this.gates.updateConfig(cfg.validation);
    this.brain.updateConfig(cfg.brain);
    this.startReconcileTick();
    if (options.restartBrain === true) {
      await this.brain.start("config-reload");
    }
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

  /**
   * Fallback liveness sweep (master plan: pane-scraping demotes to fallback).
   * Public so gates/tests can force one reconcile cycle without waiting.
   * Covers both crewmate sessions and the Brain (which is not a FleetSession).
   * Also reclaims worktree leases whose sessions are all terminal (stopped/lost
   * / missing pane) so a missed release path cannot exhaust the pool until reboot.
   */
  reconcile(): string[] {
    const lost = this.tools.reconcileDeadPanes();
    this.reconcileBrainPane();
    this.reclaimOrphanedWorktreeLeases();
    return lost;
  }

  /**
   * A lease is live only while its session is still starting/running and the
   * tmux pane exists. stopped/lost/missing sessions free the slot.
   */
  private reclaimOrphanedWorktreeLeases(): number {
    return this.tools.reclaimOrphanedLeases((sessionId) => {
      if (sessionId === null) return false;
      const session = this.tools.listSessions().find((s) => s.sessionId === sessionId);
      if (session === undefined) return false;
      if (session.status === "lost" || session.status === "stopped") return false;
      return this.tmux.hasWindow(session.tmuxWindow);
    });
  }

  /**
   * If the Brain pane is gone while status is starting/running, respawn so the
   * fresh Brain's first act is read_fleet_state (or enterDown when blocked).
   */
  private reconcileBrainPane(): void {
    const snap = this.brain.getSnapshot();
    if (snap.status !== "running" && snap.status !== "starting") return;
    if (snap.tmuxWindow === null) return;
    if (this.tmux.hasWindow(snap.tmuxWindow)) return;
    void this.brain.start("pane-died").catch(() => undefined);
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

  /**
   * Replay gate.red_proven from the append-only event log so a kill -9 after
   * the durable event (and before/without a task.json write) still restores
   * daemon-authoritative RED proofs. Disk under validation/ is never trusted.
   */
  private hydrateRedProofsFromEventLog(): void {
    const logPath = join(this.options.home, "events", "events.ndjson");
    if (!existsSync(logPath)) return;
    try {
      const { envelopes } = readLog(logPath);
      for (const envelope of envelopes) {
        const event = envelope.event;
        if (event.type !== "gate.red_proven") continue;
        const payload = event.payload as {
          taskId: string;
          gateSourceHash: string;
          outcome: "EXPECTED_RED" | "FAIL";
          provenAt: string;
          hmac?: string;
        };
        // Missing HMAC cannot be trusted — refuse rather than re-sign.
        if (typeof payload.hmac !== "string" || payload.hmac.length === 0) continue;
        this.tools.hydrateRedProofFromEvent({
          taskId: payload.taskId,
          gateSourceHash: payload.gateSourceHash,
          outcome: payload.outcome,
          provenAt: payload.provenAt,
          hmac: payload.hmac,
        });
      }
    } catch {
      // Corrupt log tails are handled by EventStore boot; best-effort here.
    }
  }

  /**
   * kill -9 restart-proof path: rebind control sockets for surviving sessions,
   * mark dead panes lost, reclaim orphaned worktree leases stuck in `leased`,
   * and respawn only cast roles whose session-key directory is absent (G6).
   */
  private rehydrateRuntime(): void {
    // Rebuild in-flight fusion side ownership from durable run.json so a
    // restart still receives artifacts + fusion.completed for live sides.
    this.tools.hydrateFusionOwnership();
    this.tools.rebindSessionListeners();
    this.tools.reconcileDeadPanes();
    // Route through ToolSurface so dirty quarantine stamps deliveryBlocked on the task.
    this.reclaimOrphanedWorktreeLeases();
    this.tools.reconcileMissingCastRoles();
  }

  /**
   * Brain budget handoff (master plan §11 Phase 8, [R4]).
   *
   * Run on every reconcile tick and callable directly by gates/fixtures. The
   * decision is made in `decideHandoff`, which is pure; this method only maps
   * the fleet's live state into it and carries out what it decided.
   *
   * The below-threshold case is deliberately silent: emitting an event every
   * tick for "nothing happened" would bury the one that matters.
   */
  evaluateBrainHandoff(): ReturnType<typeof decideHandoff> | null {
    const brainSnapshot = this.brain.getSnapshot();
    if (brainSnapshot.model === null) return null;
    const cfg = this.options.config.effective().config;
    const samples = this.options.quotaSamples?.() ?? [];
    const connections = this.options.connections?.list() ?? [];

    // Match the connection that actually routes this model ref (first segment),
    // not a bare origin family — openrouter/anthropic/… is an openrouter cast.
    const brainProvider = modelRoutingProvider(brainSnapshot.model);
    const brainConnection =
      connections.find((c) => c.provider.toLowerCase() === brainProvider) ?? null;

    const decision = decideHandoff({
      brainModel: brainSnapshot.model,
      brainConnectionId: brainConnection?.id ?? null,
      config: cfg.brain,
      budgets: cfg.budgets,
      samples,
      candidates: this.handoffCandidates(brainSnapshot.model),
    });

    // Below threshold: clear the post-handoff latch so a later breach can move
    // the Brain again without waiting out an old cooldown.
    if (!decision.shouldHandoff || decision.toModel === null) {
      if (
        decision.basis !== "none" &&
        decision.observedPct < decision.thresholdPct
      ) {
        this.lastHandoff = null;
      }
      return decision;
    }

    // Suppress thrash: success uses a long cooldown; a failed land uses a short
    // retry backoff so a broken spawn path cannot remint every reconcile tick.
    if (this.lastHandoff !== null) {
      const elapsed = Date.now() - this.lastHandoff.atMs;
      const windowMs = this.lastHandoff.landed
        ? BRAIN_HANDOFF_COOLDOWN_MS
        : BRAIN_HANDOFF_RETRY_BACKOFF_MS;
      if (elapsed < windowMs) {
        const remainingSec = Math.ceil((windowMs - elapsed) / 1000);
        const kind = this.lastHandoff.landed ? "handoff cooldown" : "handoff retry backoff";
        return {
          ...decision,
          shouldHandoff: false,
          toModel: null,
          reason: `${decision.metric} at ${decision.observedPct}% crossed ${decision.thresholdPct}% but ${kind} has ${remainingSec}s remaining after move to ${this.lastHandoff.toModel}`,
        };
      }
    }

    this.sink({
      type: "brain.handoff_triggered",
      payload: {
        fromModel: decision.fromModel,
        toModel: decision.toModel,
        metric: decision.metric,
        observedPct: decision.observedPct,
        thresholdPct: decision.thresholdPct,
      },
    });
    const after = this.brain.handoff(decision.toModel, decision.reason);
    // Keep one inspectable record (also durable via BrainManager): success
    // latches the long cooldown; failure latches only the short retry backoff.
    this.lastHandoff = {
      atMs: Date.now(),
      toModel: decision.toModel,
      landed: after.status === "running",
    };
    return decision;
  }

  /** Last budget handoff time/target/landed, for inspectability and tests. */
  lastBrainHandoff(): { atMs: number; toModel: string; landed: boolean } | null {
    return this.lastHandoff;
  }

  /**
   * Models the Brain could be moved to: one per healthy, not-limit-reached
   * connection other than the one it is spending down. A connection at its own
   * limit is not a refuge. Includes worst-window metrics so decideHandoff can
   * prefer under-threshold refuges.
   */
  private handoffCandidates(currentModel: string): HandoffCandidate[] {
    const connections = this.options.connections?.list() ?? [];
    const samples = this.options.quotaSamples?.() ?? [];
    const currentProvider = modelRoutingProvider(currentModel);
    const candidates: HandoffCandidate[] = [];
    for (const connection of connections) {
      if (connection.limitReached) continue;
      if (connection.health === "unhealthy") continue;
      if (connection.provider.toLowerCase() === currentProvider) continue;
      const model = DEFAULT_BRAIN_MODEL_BY_PROVIDER[connection.provider];
      if (model === undefined) continue;
      const sample = samples.find((s) => s.connectionId === connection.id);
      candidates.push({
        model,
        worstWindowPct: worstWindowPctFromSample(sample),
      });
    }
    return candidates;
  }

  private startReconcileTick(): void {
    this.stopReconcileTick();
    const seconds = this.options.config.effective().config.supervision.heartbeatSeconds;
    const ms = Math.max(1, seconds) * 1000;
    this.reconcileTimer = setInterval(() => {
      try {
        this.reconcile();
        this.evaluateBrainHandoff();
      } catch {
        // never let the tick crash the daemon
      }
    }, ms);
    // Unref so the interval alone cannot keep a test process alive.
    if (typeof this.reconcileTimer.unref === "function") {
      this.reconcileTimer.unref();
    }
  }

  private stopReconcileTick(): void {
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
