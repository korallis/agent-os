import { z } from "zod";
import { isoTimestampSchema, ulidSchema } from "./ids.js";
import {
  configDomainSchema,
  configLayerSchema,
  configValidationIssueSchema,
} from "./config.js";
import {
  agentRoleSchema,
  authStorePresenceSchema,
  billingSurfaceSchema,
  claudeBillingModeSchema,
  connectionHealthSchema,
  connectionKindSchema,
  modelFamilySchema,
  piProviderIdSchema,
} from "./providers.js";
import { honestyTierSchema, quotaMetricSchema } from "./quota.js";
import { onboardingStepSchema } from "./onboarding.js";
import {
  taskFailureCauseSchema,
  taskPhaseSchema,
  taskShapeSchema,
} from "./tasks.js";
import { brainStatusSchema, wakeClassSchema } from "./fleet.js";
import { brainToolNameSchema, toolErrorCodeSchema } from "./tools.js";

/**
 * Orchestrator event union (master plan §8.2, §9).
 * Phase 1: daemon + config. Phase 2: provider, quota, extension, onboarding.
 * Phase 3: tasks, fleet, brain, tools, wakes.
 */

export const daemonStartedEventSchema = z.strictObject({
  type: z.literal("daemon.started"),
  payload: z.strictObject({
    version: z.string(),
    pid: z.number().int().positive(),
    home: z.string(),
    port: z.number().int().positive(),
  }),
});

export const daemonStoppingEventSchema = z.strictObject({
  type: z.literal("daemon.stopping"),
  payload: z.strictObject({
    reason: z.enum(["signal", "shutdown"]),
    signal: z.string().nullable(),
  }),
});

export const configInstalledEventSchema = z.strictObject({
  type: z.literal("config.installed"),
  payload: z.strictObject({
    domains: z.array(configDomainSchema),
  }),
});

export const configChangedEventSchema = z.strictObject({
  type: z.literal("config.changed"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    hotReloaded: z.boolean(),
    contentHash: z.string(),
  }),
});

export const configRejectedEventSchema = z.strictObject({
  type: z.literal("config.rejected"),
  payload: z.strictObject({
    domain: configDomainSchema,
    layer: configLayerSchema,
    issues: z.array(configValidationIssueSchema),
  }),
});

export const policyChangedEventSchema = z.strictObject({
  type: z.literal("policy.changed"),
  payload: z.strictObject({
    domain: z.literal("policies"),
    layer: configLayerSchema,
    safetyOverride: z.boolean(),
  }),
});

/** A provider connection was created or its health/presence flipped. */
export const providerConnectionUpdatedEventSchema = z.strictObject({
  type: z.literal("provider.connection_updated"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    kind: connectionKindSchema,
    health: connectionHealthSchema,
    billingSurface: billingSurfaceSchema,
    billingMode: claudeBillingModeSchema.nullable(),
    family: modelFamilySchema,
    limitReached: z.boolean(),
  }),
});

/** Auth-store presence changed (mtime/hash) — never carries token material. */
export const providerCredentialRefreshedEventSchema = z.strictObject({
  type: z.literal("provider.credential_refreshed"),
  payload: z.strictObject({
    provider: piProviderIdSchema,
    presence: authStorePresenceSchema,
  }),
});

/** BILLING_MISMATCH: cast credential path ≠ observed telemetry path (§4.2). */
export const providerBillingMismatchEventSchema = z.strictObject({
  type: z.literal("provider.billing_mismatch"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    expectedPath: z.string(),
    observedPath: z.string(),
    detail: z.string(),
  }),
});

export const quotaUpdatedEventSchema = z.strictObject({
  type: z.literal("quota.updated"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    metrics: z.array(quotaMetricSchema),
    sampleId: ulidSchema,
  }),
});

/**
 * One outbound HTTP call the daemon actually made (§7 Network I/O Detail,
 * Figma 41:4815). Today the only outbound traffic Agent OS originates is the
 * quota probes, and every one of them is recorded here.
 *
 * Header capture is deliberately narrow: the Authorization value is stored
 * redacted to its last four characters and never in full. A credential in the
 * append-only log would be permanent, and the Phase 8 canary gate scans for
 * exactly this.
 */
export const netRequestEventSchema = z.strictObject({
  type: z.literal("net.request"),
  payload: z.strictObject({
    requestId: ulidSchema,
    connectionId: ulidSchema.nullable(),
    provider: piProviderIdSchema,
    method: z.string(),
    url: z.string(),
    /** Derived from the URL scheme — the fetch API does not expose ALPN. */
    protocol: z.string(),
    /** null when the call never produced a response (DNS failure, timeout). */
    status: z.number().int().nullable(),
    /** Total wall-clock ms for the call, measured around fetch. */
    durationMs: z.number().min(0),
    /** Bytes sent / received where measurable; null when not. */
    requestBytes: z.number().int().min(0).nullable(),
    responseBytes: z.number().int().min(0).nullable(),
    /** Request headers with credentials redacted to their last 4 characters. */
    requestHeaders: z.array(z.tuple([z.string(), z.string()])),
    responseHeaders: z.array(z.tuple([z.string(), z.string()])),
    /** Response body, truncated; null when not read or not text. */
    responseBody: z.string().nullable(),
    /** Populated when the call failed outright. */
    error: z.string().nullable(),
  }),
});

export const quotaThresholdEventSchema = z.strictObject({
  type: z.literal("quota.threshold"),
  payload: z.strictObject({
    connectionId: ulidSchema,
    provider: piProviderIdSchema,
    kind: z.string(),
    tier: honestyTierSchema,
    value: z.number(),
    level: z.enum(["warn", "critical", "limit-reached"]),
    reason: z.string(),
  }),
});

export const extensionHelloEventSchema = z.strictObject({
  type: z.literal("ext.hello"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    role: z.string(),
    piVersion: z.string(),
  }),
});

export const extensionUsageEventSchema = z.strictObject({
  type: z.literal("ext.usage"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  }),
});

export const onboardingStepEventSchema = z.strictObject({
  type: z.literal("onboarding.step"),
  payload: z.strictObject({
    step: onboardingStepSchema,
    previous: onboardingStepSchema.nullable(),
  }),
});

export const onboardingCompletedEventSchema = z.strictObject({
  type: z.literal("onboarding.completed"),
  payload: z.strictObject({
    at: isoTimestampSchema,
  }),
});

// ── Phase 3: tasks / fleet / brain / tools ─────────────────────────────────

export const projectRegisteredEventSchema = z.strictObject({
  type: z.literal("project.registered"),
  payload: z.strictObject({
    projectId: ulidSchema,
    name: z.string(),
    path: z.string(),
    mode: z.string(),
    trusted: z.boolean(),
  }),
});

export const projectUpdatedEventSchema = z.strictObject({
  type: z.literal("project.updated"),
  payload: z.strictObject({
    projectId: ulidSchema,
    name: z.string().optional(),
    mode: z.string().optional(),
    trusted: z.boolean().optional(),
  }),
});

export const taskCreatedEventSchema = z.strictObject({
  type: z.literal("task.created"),
  payload: z.strictObject({
    taskId: ulidSchema,
    shape: taskShapeSchema,
    projectId: ulidSchema,
    title: z.string(),
    mode: z.string(),
    phase: taskPhaseSchema,
    idempotencyKey: z.string().nullable(),
  }),
});

export const taskPhaseChangedEventSchema = z.strictObject({
  type: z.literal("task.phase_changed"),
  payload: z.strictObject({
    taskId: ulidSchema,
    from: taskPhaseSchema,
    to: taskPhaseSchema,
    reason: z.string().nullable(),
  }),
});

export const taskUpdatedEventSchema = z.strictObject({
  type: z.literal("task.updated"),
  payload: z.strictObject({
    taskId: ulidSchema,
    title: z.string().optional(),
    phase: taskPhaseSchema.optional(),
    failureCause: taskFailureCauseSchema.nullable().optional(),
  }),
});

export const taskCastResolvedEventSchema = z.strictObject({
  type: z.literal("task.cast_resolved"),
  payload: z.strictObject({
    taskId: ulidSchema,
    roles: z.array(
      z.strictObject({
        role: agentRoleSchema,
        model: z.string(),
        thinking: z.string(),
        family: modelFamilySchema,
      }),
    ),
    familyCheckOverridden: z.boolean(),
  }),
});

export const sessionSpawnedEventSchema = z.strictObject({
  type: z.literal("session.spawned"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    taskId: ulidSchema,
    role: agentRoleSchema,
    model: z.string(),
    family: modelFamilySchema,
    tmuxWindow: z.string(),
    worktreePath: z.string().nullable(),
  }),
});

export const sessionStoppedEventSchema = z.strictObject({
  type: z.literal("session.stopped"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    taskId: ulidSchema.nullable(),
    reason: z.string(),
  }),
});

export const sessionLostEventSchema = z.strictObject({
  type: z.literal("session.lost"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    taskId: ulidSchema.nullable(),
    reason: z.string(),
  }),
});

export const worktreeLeasedEventSchema = z.strictObject({
  type: z.literal("worktree.leased"),
  payload: z.strictObject({
    leaseId: ulidSchema,
    projectId: ulidSchema,
    taskId: ulidSchema,
    path: z.string(),
    branch: z.string().nullable(),
  }),
});

export const worktreeReleasedEventSchema = z.strictObject({
  type: z.literal("worktree.released"),
  payload: z.strictObject({
    leaseId: ulidSchema,
    projectId: ulidSchema,
    path: z.string(),
    quarantined: z.boolean(),
    reason: z.string().optional(),
  }),
});

export const wakeClassifiedEventSchema = z.strictObject({
  type: z.literal("wake.classified"),
  payload: z.strictObject({
    wakeId: ulidSchema,
    class: wakeClassSchema,
    taskId: ulidSchema.nullable(),
    sessionId: ulidSchema.nullable(),
    absorbed: z.boolean(),
    deliveredToBrain: z.boolean(),
    summary: z.string(),
  }),
});

export const brainStatusEventSchema = z.strictObject({
  type: z.literal("brain.status"),
  payload: z.strictObject({
    status: brainStatusSchema,
    sessionId: ulidSchema.nullable(),
    model: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

export const brainHandoffEventSchema = z.strictObject({
  type: z.literal("brain.handoff"),
  payload: z.strictObject({
    fromModel: z.string(),
    toModel: z.string(),
    triggerMetric: z.string(),
    reason: z.string(),
  }),
});

export const brainDownEventSchema = z.strictObject({
  type: z.literal("brain.down"),
  payload: z.strictObject({
    wakeQueueDepth: z.number().int().min(0),
    reason: z.string(),
  }),
});

export const toolInvokedEventSchema = z.strictObject({
  type: z.literal("tool.invoked"),
  payload: z.strictObject({
    invocationId: ulidSchema,
    tool: brainToolNameSchema,
    taskId: ulidSchema.nullable(),
    ok: z.boolean(),
    errorCode: toolErrorCodeSchema.nullable(),
    durationMs: z.number().int().min(0),
  }),
});

export const gateResultEventSchema = z.strictObject({
  type: z.literal("gate.result"),
  payload: z.strictObject({
    taskId: ulidSchema,
    target: z.enum(["baseline", "candidate"]),
    outcome: z.enum(["PASS", "FAIL", "GATE_ERROR", "EXPECTED_RED"]),
    attempt: z.number().int().min(0),
    outputHash: z.string().nullable(),
  }),
});

/**
 * Daemon recorded a RED baseline proof for a gate source hash.
 * Survives kill -9 via append-only log replay into process memory.
 * HMAC is daemon-signed material carried with the event so hydrate verifies
 * and never re-signs log contents.
 */
export const gateRedProvenEventSchema = z.strictObject({
  type: z.literal("gate.red_proven"),
  payload: z.strictObject({
    taskId: ulidSchema,
    gateSourceHash: z.string().min(1),
    outcome: z.enum(["EXPECTED_RED", "FAIL"]),
    provenAt: isoTimestampSchema,
    /** HMAC-SHA256(gateSourceHash) with daemon-only key — verified on hydrate. */
    hmac: z.string().min(1),
  }),
});

export const fusionDispatchedEventSchema = z.strictObject({
  type: z.literal("fusion.dispatched"),
  payload: z.strictObject({
    taskId: ulidSchema,
    kind: z.enum(["opinion", "fusion", "plan-fusion"]),
    runId: ulidSchema,
  }),
});

/** Shipped prompt templates materialised into the editable global layer. */
export const promptInstalledEventSchema = z.strictObject({
  type: z.literal("prompt.installed"),
  payload: z.strictObject({
    refs: z.array(z.string()),
  }),
});

/**
 * A fusion side produced its artifact. `promptHash` is what proves the
 * clean-room contract: every side of an `/opinion` saw identical bytes.
 */
export const fusionSideCompletedEventSchema = z.strictObject({
  type: z.literal("fusion.side_completed"),
  payload: z.strictObject({
    taskId: ulidSchema,
    runId: ulidSchema,
    role: z.string(),
    model: z.string(),
    family: modelFamilySchema,
    promptHash: z.string(),
    artifactPath: z.string().nullable(),
  }),
});

/** A fusion run finished, with its contract verdict and aggregator family. */
export const fusionCompletedEventSchema = z.strictObject({
  type: z.literal("fusion.completed"),
  payload: z.strictObject({
    taskId: ulidSchema,
    runId: ulidSchema,
    kind: z.enum(["opinion", "fusion", "plan-fusion"]),
    promptsIdentical: z.boolean(),
    aggregatorFamily: modelFamilySchema.nullable(),
    contractOk: z.boolean().nullable(),
    /** Set when the run finished because a side failed to spawn (or similar). */
    error: z.string().nullable().optional(),
  }),
});

/** A crewmate asked a blocking question; routed to the Brain/Captain. */
export const crewQuestionEventSchema = z.strictObject({
  type: z.literal("crew.question"),
  payload: z.strictObject({
    questionId: ulidSchema,
    sessionId: ulidSchema,
    taskId: ulidSchema.nullable(),
    question: z.string(),
  }),
});

export const crewAnsweredEventSchema = z.strictObject({
  type: z.literal("crew.answered"),
  payload: z.strictObject({
    questionId: ulidSchema,
    sessionId: ulidSchema,
    delivered: z.boolean(),
  }),
});

/**
 * A SCOUT session mutated its worktree. Scouts are read-only by policy
 * (`policies.scoutReadOnly`); the audit is a real `git status` diff, not trust.
 */
export const scoutWriteViolationEventSchema = z.strictObject({
  type: z.literal("scout.write_violation"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    taskId: ulidSchema,
    worktreePath: z.string(),
    changedPaths: z.array(z.string()),
    quarantined: z.boolean(),
  }),
});

/** A session's Pi extension called the daemon tool surface over its socket. */
export const bridgeToolCallEventSchema = z.strictObject({
  type: z.literal("bridge.tool_call"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    invocationId: ulidSchema,
    tool: z.string(),
    accepted: z.boolean(),
    reason: z.string().nullable(),
    /** False when ctl.tool_result could not be written to the session socket. */
    delivered: z.boolean().optional(),
  }),
});

/** AFK posture armed or disarmed. */
export const afkChangedEventSchema = z.strictObject({
  type: z.literal("afk.changed"),
  payload: z.strictObject({
    armed: z.boolean(),
    until: isoTimestampSchema.nullable(),
    faqEntries: z.number().int().min(0),
  }),
});

/** A crew question answered from the Captain's recorded FAQ while AFK. */
export const afkAutoAnsweredEventSchema = z.strictObject({
  type: z.literal("afk.auto_answered"),
  payload: z.strictObject({
    question: z.string(),
    rationale: z.string(),
    matched: z.array(z.string()),
  }),
});

/** Brain crossed its budget window and was handed to another model. */
export const brainHandoffTriggeredEventSchema = z.strictObject({
  type: z.literal("brain.handoff_triggered"),
  payload: z.strictObject({
    fromModel: z.string(),
    toModel: z.string(),
    metric: z.string(),
    observedPct: z.number().min(0),
    thresholdPct: z.number().min(0),
  }),
});

/**
 * The handoff actually happened: the new Brain seat is live in a NEW session.
 * Recording both session ids is what makes "no cross-model transcript replay"
 * checkable after the fact rather than a claim in a comment.
 */
export const brainHandoffCompletedEventSchema = z.strictObject({
  type: z.literal("brain.handoff_completed"),
  payload: z.strictObject({
    fromModel: z.string().nullable(),
    toModel: z.string(),
    fromSessionId: ulidSchema.nullable(),
    toSessionId: ulidSchema.nullable(),
    reason: z.string(),
  }),
});

/** A secondmate charter was written — its Brain or routing domains changed. */
export const secondmateCharterChangedEventSchema = z.strictObject({
  type: z.literal("secondmate.charter_changed"),
  payload: z.strictObject({
    name: z.string(),
    brainModel: z.string().nullable(),
    domains: z.array(z.string()),
  }),
});

/** A task was handed to a secondmate; it leaves the primary's fleet. */
export const secondmateRoutedEventSchema = z.strictObject({
  type: z.literal("secondmate.routed"),
  payload: z.strictObject({
    name: z.string(),
    taskId: ulidSchema,
    domain: z.string(),
    accepted: z.boolean(),
    reason: z.string().nullable(),
    /** Task id on the secondmate after a successful POST /v1/tasks handover. */
    remoteTaskId: ulidSchema.nullable().optional(),
  }),
});

/**
 * A seat is structurally WEDGED: its pane is alive but it has produced nothing
 * for longer than the configured stale window (§11 Phase 3).
 *
 * Distinct from SESSION_LOST, where the pane is gone. A wedged seat looks
 * healthy from the outside, which is precisely why it needs saying out loud —
 * left alone it consumes a worktree lease and a cast slot indefinitely.
 */
export const sessionWedgedEventSchema = z.strictObject({
  type: z.literal("session.wedged"),
  payload: z.strictObject({
    sessionId: ulidSchema,
    taskId: ulidSchema.nullable(),
    role: z.string(),
    /** Minutes of silence that tripped the detector. */
    idleMinutes: z.number().min(0),
    thresholdMinutes: z.number().min(0),
    /** Durable wedge-respawn ledger for this task/role after the outcome. */
    respawnsUsed: z.number().int().min(0),
    respawnCap: z.number().int().min(0),
    /** What the substrate did about it. */
    action: z.enum(["respawned", "escalated"]),
  }),
});

/**
 * Live view of the `no-mistakes` gate (§11 Phase 9). Agent OS republishes the
 * gate's own state onto its append-only log so the Console consumes pipeline
 * progress through the same SSE + projection path as everything else.
 */
export const pipelineFindingSchema = z.strictObject({
  id: z.string(),
  severity: z.string(),
  /** Captain-facing disposition: auto-fix / no-op / ask-user (or gate-specific). */
  action: z.string(),
  description: z.string(),
});
export type PipelineFinding = z.infer<typeof pipelineFindingSchema>;

export const pipelineStepSnapshotSchema = z.strictObject({
  step: z.string(),
  order: z.number().int().min(0),
  status: z.string(),
  findingsCount: z.number().int().min(0),
  /** Projected from findings_json when present — the parked-gate decision table. */
  findings: z.array(pipelineFindingSchema).default([]),
  lastActivity: z.string().nullable(),
  lastActivityAt: isoTimestampSchema.nullable(),
  durationMs: z.number().int().min(0).nullable(),
  agentPid: z.number().int().nullable(),
});
export type PipelineStepSnapshot = z.infer<typeof pipelineStepSnapshotSchema>;

export const pipelineRunSnapshotSchema = z.strictObject({
  runId: z.string(),
  branch: z.string(),
  status: z.string(),
  headSha: z.string(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  intent: z.string().nullable(),
  steps: z.array(pipelineStepSnapshotSchema),
  updatedAt: isoTimestampSchema,
});
export type PipelineRunSnapshot = z.infer<typeof pipelineRunSnapshotSchema>;

export const pipelineRunUpdatedEventSchema = z.strictObject({
  type: z.literal("pipeline.run_updated"),
  payload: pipelineRunSnapshotSchema,
});

/** Newly appended bytes from the active step's log — incremental, not a replay. */
export const pipelineLogAppendedEventSchema = z.strictObject({
  type: z.literal("pipeline.log_appended"),
  payload: z.strictObject({
    runId: z.string(),
    step: z.string(),
    chunk: z.string(),
  }),
});

/**
 * The gate's state could not be read — most often a schema change in a newer
 * no-mistakes. Emitted ONCE per incompatibility so the Console can degrade
 * visibly instead of rendering stale rows as current.
 */
export const pipelineUnavailableEventSchema = z.strictObject({
  type: z.literal("pipeline.unavailable"),
  payload: z.strictObject({
    reason: z.string(),
    missingColumns: z.array(z.string()),
    home: z.string(),
  }),
});

export const captainEscalationEventSchema = z.strictObject({
  type: z.literal("captain.escalation"),
  payload: z.strictObject({
    taskId: ulidSchema.nullable(),
    summary: z.string(),
    severity: z.enum(["info", "warn", "critical"]),
  }),
});

/** Captain cleared a sticky deliveryBlocked stamp after inspecting the tree. */
export const taskDeliveryBlockResolvedEventSchema = z.strictObject({
  type: z.literal("task.delivery_block_resolved"),
  payload: z.strictObject({
    taskId: ulidSchema,
    reason: z.string(),
    previousLeaseId: z.string().nullable(),
    previousReason: z.string().nullable(),
    clearedBy: z.literal("captain"),
  }),
});

export const orchestratorEventSchema = z.discriminatedUnion("type", [
  daemonStartedEventSchema,
  daemonStoppingEventSchema,
  configInstalledEventSchema,
  configChangedEventSchema,
  configRejectedEventSchema,
  policyChangedEventSchema,
  providerConnectionUpdatedEventSchema,
  providerCredentialRefreshedEventSchema,
  providerBillingMismatchEventSchema,
  quotaUpdatedEventSchema,
  quotaThresholdEventSchema,
  netRequestEventSchema,
  extensionHelloEventSchema,
  extensionUsageEventSchema,
  onboardingStepEventSchema,
  onboardingCompletedEventSchema,
  projectRegisteredEventSchema,
  projectUpdatedEventSchema,
  taskCreatedEventSchema,
  taskPhaseChangedEventSchema,
  taskUpdatedEventSchema,
  taskCastResolvedEventSchema,
  sessionSpawnedEventSchema,
  sessionStoppedEventSchema,
  sessionLostEventSchema,
  worktreeLeasedEventSchema,
  worktreeReleasedEventSchema,
  wakeClassifiedEventSchema,
  brainStatusEventSchema,
  brainHandoffEventSchema,
  brainDownEventSchema,
  toolInvokedEventSchema,
  gateResultEventSchema,
  gateRedProvenEventSchema,
  fusionDispatchedEventSchema,
  promptInstalledEventSchema,
  fusionSideCompletedEventSchema,
  fusionCompletedEventSchema,
  crewQuestionEventSchema,
  crewAnsweredEventSchema,
  scoutWriteViolationEventSchema,
  bridgeToolCallEventSchema,
  afkChangedEventSchema,
  afkAutoAnsweredEventSchema,
  brainHandoffTriggeredEventSchema,
  brainHandoffCompletedEventSchema,
  secondmateCharterChangedEventSchema,
  secondmateRoutedEventSchema,
  sessionWedgedEventSchema,
  pipelineRunUpdatedEventSchema,
  pipelineLogAppendedEventSchema,
  pipelineUnavailableEventSchema,
  captainEscalationEventSchema,
  taskDeliveryBlockResolvedEventSchema,
]);
export type OrchestratorEvent = z.infer<typeof orchestratorEventSchema>;

export type OrchestratorEventType = OrchestratorEvent["type"];

/** All orchestrator SSE event type names — derived from the schema so UIs cannot drift. */
export const ORCHESTRATOR_EVENT_TYPES: readonly OrchestratorEventType[] =
  orchestratorEventSchema.options.map(
    (option) => option.shape.type.value as OrchestratorEventType,
  );

export const eventEnvelopeSchema = z.strictObject({
  id: ulidSchema,
  seq: z.number().int().positive(),
  ts: isoTimestampSchema,
  event: orchestratorEventSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const sseFrameSchema = z.strictObject({
  id: ulidSchema,
  event: z.string(),
  data: eventEnvelopeSchema,
});
export type SseFrame = z.infer<typeof sseFrameSchema>;
