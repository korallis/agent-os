import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_EVENT_TYPES,
  eventEnvelopeSchema,
  orchestratorEventSchema,
  sseFrameSchema,
  type OrchestratorEvent,
  type OrchestratorEventType,
} from "../src/events.js";

/**
 * The event log is append-only and is the system's source of truth: anything a
 * schema accepts here is permanent. These tests therefore care far more about
 * what the schemas REJECT than about what they accept.
 */

const ULID_A = "01J0ZQ8P0000000000000000AB";
const ULID_B = "01J0ZQ8P0000000000000000CD";
const ULID_C = "01J0ZQ8P0000000000000000EF";
const TS = "2026-07-24T10:00:00.000Z";

type JsonRecord = Record<string, unknown>;

/**
 * One structurally-valid sample per event type. The union is exhaustive over
 * `ORCHESTRATOR_EVENT_TYPES` (asserted below), so adding an event type without
 * adding a sample fails the suite rather than silently going untested.
 *
 * Optional payload keys are present here on purpose: the generic key-deletion
 * sweep uses these samples to pin required-vs-optional in both directions.
 */
const SAMPLES: readonly OrchestratorEvent[] = [
  {
    type: "daemon.started",
    payload: { version: "0.1.0", pid: 4321, home: "/Users/captain/.agentos", port: 7777 },
  },
  { type: "daemon.stopping", payload: { reason: "signal", signal: "SIGTERM" } },
  { type: "config.installed", payload: { domains: ["supervision", "policies"] } },
  {
    type: "config.changed",
    payload: {
      domain: "supervision",
      layer: "global",
      hotReloaded: true,
      contentHash: "sha256:abc",
    },
  },
  {
    type: "config.rejected",
    payload: {
      domain: "quota",
      layer: "project",
      issues: [{ path: "staleMinutes.build", message: "expected integer" }],
    },
  },
  {
    type: "policy.changed",
    payload: { domain: "policies", layer: "global", safetyOverride: false },
  },
  {
    type: "provider.connection_updated",
    payload: {
      connectionId: ULID_A,
      provider: "anthropic",
      kind: "pi-oauth",
      health: "healthy",
      billingSurface: "plan-quota",
      billingMode: "subscription-sdk",
      family: "anthropic",
      limitReached: false,
    },
  },
  {
    type: "provider.credential_refreshed",
    payload: {
      provider: "openai",
      presence: {
        provider: "openai",
        present: true,
        mtime: TS,
        presenceHash: "sha256:zzz",
        expiresAt: null,
      },
    },
  },
  {
    type: "provider.billing_mismatch",
    payload: {
      connectionId: ULID_A,
      expectedPath: "claude-code-oauth",
      observedPath: "api-key",
      detail: "telemetry reported api metering",
    },
  },
  {
    type: "quota.updated",
    payload: {
      connectionId: ULID_A,
      provider: "anthropic",
      metrics: [
        {
          kind: "session-window-pct",
          value: 42,
          unit: "percent",
          tier: "live",
          source: "OAUTH · SYNCED 10:27",
          syncedAt: TS,
          reason: null,
          resetsAt: null,
          limitReached: false,
        },
      ],
      sampleId: ULID_B,
    },
  },
  {
    type: "quota.threshold",
    payload: {
      connectionId: ULID_A,
      provider: "anthropic",
      kind: "session-window-pct",
      tier: "live",
      value: 91,
      level: "warn",
      reason: "session window above 90%",
    },
  },
  {
    type: "net.request",
    payload: {
      requestId: ULID_A,
      connectionId: ULID_B,
      provider: "anthropic",
      method: "GET",
      url: "https://api.anthropic.com/v1/usage",
      protocol: "https",
      status: 200,
      durationMs: 123.5,
      requestBytes: 0,
      responseBytes: 512,
      requestHeaders: [["authorization", "Bearer …abcd"]],
      responseHeaders: [["content-type", "application/json"]],
      responseBody: '{"ok":true}',
      error: null,
    },
  },
  { type: "ext.hello", payload: { sessionId: ULID_A, role: "builder", piVersion: "0.9.1" } },
  {
    type: "ext.usage",
    payload: {
      sessionId: ULID_A,
      provider: "anthropic",
      model: "anthropic/claude-opus-4",
      inputTokens: 100,
      outputTokens: 250,
      costUsd: 0.42,
    },
  },
  { type: "onboarding.step", payload: { step: "providers", previous: "doctor" } },
  { type: "onboarding.completed", payload: { at: TS } },
  {
    type: "project.registered",
    payload: { projectId: ULID_A, name: "agent-os", path: "/repo", mode: "pipeline", trusted: true },
  },
  {
    type: "project.updated",
    payload: { projectId: ULID_A, name: "agent-os", mode: "direct-pr", trusted: false },
  },
  {
    type: "task.created",
    payload: {
      taskId: ULID_A,
      shape: "SHIP",
      projectId: ULID_B,
      title: "Close the protocol test gap",
      mode: "pipeline",
      phase: "QUEUED",
      idempotencyKey: null,
    },
  },
  {
    type: "task.phase_changed",
    payload: { taskId: ULID_A, from: "QUEUED", to: "PLANNING", reason: null },
  },
  {
    type: "task.updated",
    payload: { taskId: ULID_A, title: "new title", phase: "BUILDING", failureCause: null },
  },
  {
    type: "task.cast_resolved",
    payload: {
      taskId: ULID_A,
      roles: [
        {
          role: "builder",
          model: "anthropic/claude-opus-4",
          thinking: "high",
          family: "anthropic",
        },
      ],
      familyCheckOverridden: false,
    },
  },
  {
    type: "session.spawned",
    payload: {
      sessionId: ULID_A,
      taskId: ULID_B,
      role: "builder",
      model: "anthropic/claude-opus-4",
      family: "anthropic",
      tmuxWindow: "agentos:builder-1",
      worktreePath: "/wt/1",
    },
  },
  { type: "session.stopped", payload: { sessionId: ULID_A, taskId: ULID_B, reason: "completed" } },
  {
    type: "session.lost",
    payload: { sessionId: ULID_A, taskId: ULID_B, reason: "tmux window vanished" },
  },
  {
    type: "worktree.leased",
    payload: {
      leaseId: ULID_A,
      projectId: ULID_B,
      taskId: ULID_C,
      path: "/wt/1",
      branch: "phase-17/protocol-tests",
    },
  },
  {
    type: "worktree.released",
    payload: {
      leaseId: ULID_A,
      projectId: ULID_B,
      path: "/wt/1",
      quarantined: false,
      reason: "task done",
    },
  },
  {
    type: "wake.classified",
    payload: {
      wakeId: ULID_A,
      class: "NEEDS_INPUT",
      taskId: ULID_B,
      sessionId: ULID_C,
      absorbed: false,
      deliveredToBrain: true,
      summary: "builder asked a question",
    },
  },
  {
    type: "brain.status",
    payload: {
      status: "running",
      sessionId: ULID_A,
      model: "anthropic/claude-opus-4",
      reason: null,
    },
  },
  {
    type: "brain.handoff",
    payload: {
      fromModel: "anthropic/claude-opus-4",
      toModel: "openai/gpt-5",
      triggerMetric: "weekly-window-pct",
      reason: "budget window crossed",
    },
  },
  { type: "brain.down", payload: { wakeQueueDepth: 3, reason: "pi unavailable" } },
  {
    type: "tool.invoked",
    payload: {
      invocationId: ULID_A,
      tool: "create_task",
      taskId: ULID_B,
      ok: true,
      errorCode: null,
      durationMs: 12,
    },
  },
  {
    type: "gate.result",
    payload: {
      taskId: ULID_A,
      target: "candidate",
      outcome: "PASS",
      attempt: 1,
      outputHash: "sha256:aaa",
    },
  },
  {
    type: "gate.red_proven",
    payload: {
      taskId: ULID_A,
      gateSourceHash: "sha256:bbb",
      outcome: "EXPECTED_RED",
      provenAt: TS,
      hmac: "deadbeef",
    },
  },
  { type: "fusion.dispatched", payload: { taskId: ULID_A, kind: "opinion", runId: ULID_B } },
  { type: "prompt.installed", payload: { refs: ["brain/system", "builder/system"] } },
  {
    type: "fusion.side_completed",
    payload: {
      taskId: ULID_A,
      runId: ULID_B,
      role: "fusion",
      model: "openai/gpt-5",
      family: "openai",
      promptHash: "sha256:ccc",
      artifactPath: "/runs/a.md",
    },
  },
  {
    type: "fusion.completed",
    payload: {
      taskId: ULID_A,
      runId: ULID_B,
      kind: "fusion",
      promptsIdentical: true,
      aggregatorFamily: "anthropic",
      contractOk: true,
      error: null,
    },
  },
  {
    type: "crew.question",
    payload: { questionId: ULID_A, sessionId: ULID_B, taskId: ULID_C, question: "which branch?" },
  },
  { type: "crew.answered", payload: { questionId: ULID_A, sessionId: ULID_B, delivered: true } },
  {
    type: "scout.write_violation",
    payload: {
      sessionId: ULID_A,
      taskId: ULID_B,
      worktreePath: "/wt/2",
      changedPaths: ["src/index.ts"],
      quarantined: true,
    },
  },
  {
    type: "bridge.tool_call",
    payload: {
      sessionId: ULID_A,
      invocationId: ULID_B,
      tool: "create_task",
      accepted: true,
      reason: null,
      delivered: true,
    },
  },
  { type: "afk.changed", payload: { armed: true, until: TS, faqEntries: 4 } },
  {
    type: "afk.auto_answered",
    payload: {
      question: "ok to force push?",
      rationale: "captain FAQ says no",
      matched: ["force-push"],
    },
  },
  {
    type: "brain.handoff_triggered",
    payload: {
      fromModel: "anthropic/claude-opus-4",
      toModel: "openai/gpt-5",
      metric: "weekly-window-pct",
      observedPct: 92.5,
      thresholdPct: 90,
    },
  },
  {
    type: "brain.handoff_completed",
    payload: {
      fromModel: "anthropic/claude-opus-4",
      toModel: "openai/gpt-5",
      fromSessionId: ULID_A,
      toSessionId: ULID_B,
      reason: "budget",
    },
  },
  {
    type: "captain.escalation",
    payload: { taskId: ULID_A, summary: "validation exhausted", severity: "critical" },
  },
  {
    type: "task.delivery_block_resolved",
    payload: {
      taskId: ULID_A,
      reason: "tree inspected and clean",
      previousLeaseId: ULID_B,
      previousReason: "dirty tree",
      clearedBy: "captain",
    },
  },
];

/**
 * Payload keys that are genuinely `.optional()`. Everything not listed is
 * required, including every `.nullable()` key — nullable is not optional, and
 * a projection that reads `payload.x` must never see `undefined`.
 */
const OPTIONAL_PAYLOAD_KEYS: Partial<Record<OrchestratorEventType, readonly string[]>> = {
  "project.updated": ["name", "mode", "trusted"],
  "task.updated": ["title", "phase", "failureCause"],
  "worktree.released": ["reason"],
  "fusion.completed": ["error"],
  "bridge.tool_call": ["delivered"],
};

/** Deep clone through plain JSON values so mutations never touch a sample. */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        cloneJson(inner),
      ]),
    );
  }
  return value;
}

function toRecord(event: OrchestratorEvent): JsonRecord {
  return cloneJson(event) as JsonRecord;
}

const SAMPLE_BY_TYPE = new Map<OrchestratorEventType, OrchestratorEvent>(
  SAMPLES.map((sample) => [sample.type, sample]),
);

function payloadOf(type: OrchestratorEventType): JsonRecord {
  const sample = SAMPLE_BY_TYPE.get(type);
  if (sample === undefined) throw new Error(`no sample for ${type}`);
  return toRecord(sample).payload as JsonRecord;
}

/** A sample event with its payload shallow-patched — the patch may add or replace keys. */
function patched(type: OrchestratorEventType, patch: JsonRecord): JsonRecord {
  return { type, payload: { ...payloadOf(type), ...patch } };
}

/** A sample event with one payload key removed. */
function without(type: OrchestratorEventType, key: string): JsonRecord {
  const payload = payloadOf(type);
  delete payload[key];
  return { type, payload };
}

function accepts(value: unknown): boolean {
  return orchestratorEventSchema.safeParse(value).success;
}

function rejects(value: unknown): boolean {
  return !accepts(value);
}

function envelope(event: OrchestratorEvent): JsonRecord {
  return { id: ULID_A, seq: 1, ts: TS, event: toRecord(event) };
}

describe("ORCHESTRATOR_EVENT_TYPES", () => {
  /**
   * Pinned literally. Renaming or dropping a type silently breaks every
   * projection and SSE consumer downstream; adding one without updating the
   * consumers is equally a break. Either way this list must be edited on
   * purpose, with the diff visible in review.
   */
  const EXPECTED_TYPES: readonly string[] = [
    "daemon.started",
    "daemon.stopping",
    "config.installed",
    "config.changed",
    "config.rejected",
    "policy.changed",
    "provider.connection_updated",
    "provider.credential_refreshed",
    "provider.billing_mismatch",
    "quota.updated",
    "quota.threshold",
    "net.request",
    "ext.hello",
    "ext.usage",
    "onboarding.step",
    "onboarding.completed",
    "project.registered",
    "project.updated",
    "task.created",
    "task.phase_changed",
    "task.updated",
    "task.cast_resolved",
    "session.spawned",
    "session.stopped",
    "session.lost",
    "worktree.leased",
    "worktree.released",
    "wake.classified",
    "brain.status",
    "brain.handoff",
    "brain.down",
    "tool.invoked",
    "gate.result",
    "gate.red_proven",
    "fusion.dispatched",
    "prompt.installed",
    "fusion.side_completed",
    "fusion.completed",
    "crew.question",
    "crew.answered",
    "scout.write_violation",
    "bridge.tool_call",
    "afk.changed",
    "afk.auto_answered",
    "brain.handoff_triggered",
    "brain.handoff_completed",
    "captain.escalation",
    "task.delivery_block_resolved",
  ];

  it("is the exact, ordered set of event type literals", () => {
    expect([...ORCHESTRATOR_EVENT_TYPES]).toEqual(EXPECTED_TYPES);
  });

  it("has no duplicate type literals", () => {
    expect(new Set(ORCHESTRATOR_EVENT_TYPES).size).toBe(ORCHESTRATOR_EVENT_TYPES.length);
  });

  it("stays derived from the union options rather than hand-maintained", () => {
    const fromOptions = orchestratorEventSchema.options.map((option) => option.shape.type.value);
    expect([...ORCHESTRATOR_EVENT_TYPES]).toEqual(fromOptions);
  });

  it("has one test sample per declared type", () => {
    expect(SAMPLES.map((sample) => sample.type)).toEqual([...ORCHESTRATOR_EVENT_TYPES]);
  });
});

describe("orchestratorEventSchema — union routing", () => {
  it("rejects an unknown event type with an unmatched-discriminator issue on `type`", () => {
    const result = orchestratorEventSchema.safeParse({
      type: "daemon.restarted",
      payload: { version: "0.1.0", pid: 1, home: "/h", port: 1 },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["type"]);
    expect(result.error.issues[0]?.code).toBe("invalid_union");
  });

  it.each([undefined, null, 1, "daemon.started", ["daemon.started"], {}])(
    "rejects a non-literal discriminator: %o",
    (type) => {
      expect(rejects({ type, payload: {} })).toBe(true);
    },
  );

  it("rejects a top-level object with no payload", () => {
    expect(rejects({ type: "brain.down" })).toBe(true);
  });

  it.each([null, "payload", 7, []])("rejects a non-object payload: %o", (payload) => {
    expect(rejects({ type: "brain.down", payload })).toBe(true);
  });

  it.each([undefined, null, "event", 42, []])("rejects a non-object event: %o", (value) => {
    expect(rejects(value)).toBe(true);
  });

  /**
   * 48 × 47 cross-checks. Only `session.stopped` and `session.lost` are
   * deliberately payload-identical, so exactly two pairs may interchange. Any
   * new pair appearing here means a payload schema was loosened enough that
   * one event can masquerade as another — the classic way a discriminated
   * union starts silently accepting the wrong record.
   */
  it("does not let one event type accept another's payload", () => {
    const IDENTICAL_BY_DESIGN = new Set(["session.stopped|session.lost", "session.lost|session.stopped"]);
    const interchangeable: string[] = [];
    for (const outer of SAMPLES) {
      for (const inner of SAMPLES) {
        if (outer.type === inner.type) continue;
        if (accepts({ type: outer.type, payload: payloadOf(inner.type) })) {
          interchangeable.push(`${outer.type}|${inner.type}`);
        }
      }
    }
    expect(new Set(interchangeable)).toEqual(IDENTICAL_BY_DESIGN);
  });

  it("keeps `session.stopped` and `session.lost` distinct after parsing", () => {
    // Payload-identical by design, so `type` is the only thing separating a
    // clean shutdown from a lost session. Parsing must not normalise it away.
    const lost = orchestratorEventSchema.parse(toRecord(SAMPLE_BY_TYPE.get("session.lost")!));
    const stopped = orchestratorEventSchema.parse(toRecord(SAMPLE_BY_TYPE.get("session.stopped")!));
    expect(lost.type).toBe("session.lost");
    expect(stopped.type).toBe("session.stopped");
  });
});

describe("orchestratorEventSchema — per-event structural sweep", () => {
  it.each(SAMPLES.map((sample) => [sample.type, sample] as const))(
    "%s accepts its canonical shape without dropping fields",
    (_type, sample) => {
      const result = orchestratorEventSchema.safeParse(toRecord(sample));
      expect(result.success).toBe(true);
      if (!result.success) return;
      // Guards the rejection sweeps below from passing vacuously, and catches a
      // payload schema being replaced by one that strips or coerces keys.
      expect(result.data).toEqual(sample);
    },
  );

  it.each(SAMPLES.map((sample) => [sample.type] as const))(
    "%s rejects an unknown top-level key",
    (type) => {
      expect(rejects({ ...toRecord(SAMPLE_BY_TYPE.get(type)!), source: "spoofed" })).toBe(true);
    },
  );

  it.each(SAMPLES.map((sample) => [sample.type] as const))(
    "%s rejects an unknown payload key",
    (type) => {
      // strictObject everywhere: an unrecognised key means the writer and the
      // schema disagree, and in an append-only log that lands permanently.
      expect(rejects(patched(type, { accessToken: "sk-live-not-redacted" }))).toBe(true);
    },
  );

  it.each(SAMPLES.map((sample) => [sample.type] as const))(
    "%s rejects removal of every required payload key",
    (type) => {
      const optional = new Set(OPTIONAL_PAYLOAD_KEYS[type] ?? []);
      const required = Object.keys(payloadOf(type)).filter((key) => !optional.has(key));
      expect(required.length).toBeGreaterThan(0);
      for (const key of required) {
        expect(rejects(without(type, key)), `${type}.${key} must be required`).toBe(true);
      }
    },
  );

  it.each(Object.keys(OPTIONAL_PAYLOAD_KEYS).map((type) => [type] as const))(
    "%s keeps its documented optional keys optional",
    (type) => {
      const eventType = type as OrchestratorEventType;
      for (const key of OPTIONAL_PAYLOAD_KEYS[eventType] ?? []) {
        expect(accepts(without(eventType, key)), `${type}.${key} must stay optional`).toBe(true);
      }
    },
  );

  it.each(SAMPLES.map((sample) => [sample.type] as const))(
    "%s rejects `undefined` in place of a required payload key",
    (type) => {
      const optional = new Set(OPTIONAL_PAYLOAD_KEYS[type] ?? []);
      for (const key of Object.keys(payloadOf(type))) {
        if (optional.has(key)) continue;
        expect(rejects(patched(type, { [key]: undefined })), `${type}.${key}`).toBe(true);
      }
    },
  );
});

describe("daemon events", () => {
  it.each([0, -1, 1.5, "4321", null])("rejects pid %o", (pid) => {
    expect(rejects(patched("daemon.started", { pid }))).toBe(true);
  });

  it.each([0, -1, 8080.5, "7777"])("rejects port %o", (port) => {
    expect(rejects(patched("daemon.started", { port }))).toBe(true);
  });

  it("rejects a stop reason outside the enum", () => {
    // "SIGTERM" is the *signal*, not the reason — a writer conflating the two
    // would otherwise produce an unprojectable record.
    expect(rejects(patched("daemon.stopping", { reason: "SIGTERM" }))).toBe(true);
    expect(rejects(patched("daemon.stopping", { reason: null }))).toBe(true);
  });

  it("allows a null signal but not a non-string one", () => {
    expect(accepts(patched("daemon.stopping", { signal: null }))).toBe(true);
    expect(rejects(patched("daemon.stopping", { signal: 15 }))).toBe(true);
  });
});

describe("config and policy events", () => {
  it("rejects an unknown config domain", () => {
    expect(rejects(patched("config.changed", { domain: "supervison" }))).toBe(true);
    expect(rejects(patched("config.installed", { domains: ["supervision", "telemetry"] }))).toBe(
      true,
    );
  });

  it("rejects a non-array domains list", () => {
    expect(rejects(patched("config.installed", { domains: "supervision" }))).toBe(true);
  });

  it("accepts an empty domains list", () => {
    expect(accepts(patched("config.installed", { domains: [] }))).toBe(true);
  });

  it("rejects an unknown config layer", () => {
    expect(rejects(patched("config.changed", { layer: "user" }))).toBe(true);
  });

  it("rejects a malformed validation issue", () => {
    expect(rejects(patched("config.rejected", { issues: [{ path: "a" }] }))).toBe(true);
    expect(rejects(patched("config.rejected", { issues: [{ message: "bad" }] }))).toBe(true);
    expect(rejects(patched("config.rejected", { issues: ["bad"] }))).toBe(true);
    // Nested strictObject: an issue carrying anything beyond path/message.
    expect(
      rejects(patched("config.rejected", { issues: [{ path: "a", message: "b", value: "c" }] })),
    ).toBe(true);
  });

  it("pins policy.changed to the `policies` domain literal", () => {
    // It is a literal, not the domain enum: a policy event about `quota` would
    // be a category error the projection cannot recover from.
    expect(rejects(patched("policy.changed", { domain: "quota" }))).toBe(true);
  });
});

describe("provider and quota events", () => {
  it("rejects unknown provider ids and connection kinds", () => {
    expect(rejects(patched("provider.connection_updated", { provider: "antropic" }))).toBe(true);
    expect(rejects(patched("provider.connection_updated", { kind: "oauth" }))).toBe(true);
    expect(rejects(patched("provider.connection_updated", { health: "ok" }))).toBe(true);
    expect(rejects(patched("provider.connection_updated", { billingSurface: "free" }))).toBe(true);
    expect(rejects(patched("provider.connection_updated", { family: "" }))).toBe(true);
  });

  it("allows a null billing mode but not an unknown one", () => {
    expect(accepts(patched("provider.connection_updated", { billingMode: null }))).toBe(true);
    expect(rejects(patched("provider.connection_updated", { billingMode: "subscription" }))).toBe(
      true,
    );
  });

  it("rejects a non-ULID connection id", () => {
    expect(rejects(patched("provider.connection_updated", { connectionId: "conn-1" }))).toBe(true);
    expect(
      rejects(
        patched("provider.connection_updated", {
          connectionId: "3f1e0c1a-0b3a-4f5e-8a1b-9c2d3e4f5a6b",
        }),
      ),
    ).toBe(true);
  });

  it("refuses token material smuggled into the credential presence record", () => {
    // §4.3: presence is opaque metadata. A secret written here would live in
    // the append-only log forever, which is exactly what the strict nested
    // object exists to prevent.
    expect(
      rejects(
        patched("provider.credential_refreshed", {
          presence: {
            provider: "openai",
            present: true,
            mtime: TS,
            presenceHash: "sha256:zzz",
            expiresAt: null,
            accessToken: "sk-live-abc",
          },
        }),
      ),
    ).toBe(true);
  });

  it("requires the presence record's own fields", () => {
    expect(
      rejects(
        patched("provider.credential_refreshed", {
          presence: { provider: "openai", present: true, mtime: TS, presenceHash: "sha256:zzz" },
        }),
      ),
    ).toBe(true);
    expect(rejects(patched("provider.credential_refreshed", { presence: null }))).toBe(true);
  });

  it("rejects a malformed quota metric", () => {
    const metric: JsonRecord = {
      kind: "session-window-pct",
      value: 42,
      unit: "percent",
      tier: "live",
      source: "OAUTH",
      syncedAt: TS,
      reason: null,
      resetsAt: null,
      limitReached: false,
    };
    expect(accepts(patched("quota.updated", { metrics: [metric] }))).toBe(true);
    expect(rejects(patched("quota.updated", { metrics: [{ ...metric, kind: "session-pct" }] }))).toBe(
      true,
    );
    expect(rejects(patched("quota.updated", { metrics: [{ ...metric, unit: "%" }] }))).toBe(true);
    expect(rejects(patched("quota.updated", { metrics: [{ ...metric, tier: "guess" }] }))).toBe(true);
    expect(rejects(patched("quota.updated", { metrics: [{ ...metric, syncedAt: 1750000000 }] }))).toBe(
      true,
    );
    expect(rejects(patched("quota.updated", { metrics: [{ ...metric, extra: 1 }] }))).toBe(true);
    expect(rejects(patched("quota.updated", { metrics: metric }))).toBe(true);
  });

  it("rejects an unknown honesty tier or threshold level", () => {
    expect(rejects(patched("quota.threshold", { tier: "live-ish" }))).toBe(true);
    expect(rejects(patched("quota.threshold", { level: "warning" }))).toBe(true);
    expect(rejects(patched("quota.threshold", { level: "info" }))).toBe(true);
  });

  it.each(["warn", "critical", "limit-reached"])("accepts threshold level %s", (level) => {
    expect(accepts(patched("quota.threshold", { level }))).toBe(true);
  });
});

describe("net.request", () => {
  it("allows a null status but not a fractional one", () => {
    expect(accepts(patched("net.request", { status: null }))).toBe(true);
    expect(rejects(patched("net.request", { status: 200.5 }))).toBe(true);
    expect(rejects(patched("net.request", { status: "200" }))).toBe(true);
  });

  it("rejects a negative duration", () => {
    expect(rejects(patched("net.request", { durationMs: -1 }))).toBe(true);
    expect(accepts(patched("net.request", { durationMs: 0 }))).toBe(true);
  });

  it.each([-1, 1.5, "512"])("rejects byte count %o", (bytes) => {
    expect(rejects(patched("net.request", { requestBytes: bytes }))).toBe(true);
    expect(rejects(patched("net.request", { responseBytes: bytes }))).toBe(true);
  });

  it("allows null byte counts when not measurable", () => {
    expect(accepts(patched("net.request", { requestBytes: null, responseBytes: null }))).toBe(true);
  });

  it("holds headers to exactly [name, value] string pairs", () => {
    // A three-element entry is how a header value plus a stray un-redacted
    // token would sneak in; the tuple arity is the guard.
    expect(rejects(patched("net.request", { requestHeaders: [["authorization"]] }))).toBe(true);
    expect(
      rejects(patched("net.request", { requestHeaders: [["authorization", "Bearer …abcd", "raw"]] })),
    ).toBe(true);
    expect(rejects(patched("net.request", { requestHeaders: [["content-length", 12]] }))).toBe(true);
    expect(rejects(patched("net.request", { requestHeaders: [{ authorization: "x" }] }))).toBe(true);
    expect(rejects(patched("net.request", { responseHeaders: [["a", "b", "c"]] }))).toBe(true);
    expect(accepts(patched("net.request", { requestHeaders: [], responseHeaders: [] }))).toBe(true);
  });

  it("allows null body and error but not other types", () => {
    expect(accepts(patched("net.request", { responseBody: null, error: null }))).toBe(true);
    expect(rejects(patched("net.request", { responseBody: { ok: true } }))).toBe(true);
    expect(rejects(patched("net.request", { error: new Error("boom") }))).toBe(true);
  });
});

describe("extension and onboarding events", () => {
  it.each([-1, 1.5, "100"])("rejects token count %o", (tokens) => {
    expect(rejects(patched("ext.usage", { inputTokens: tokens }))).toBe(true);
    expect(rejects(patched("ext.usage", { outputTokens: tokens }))).toBe(true);
  });

  it("rejects a negative cost but allows null", () => {
    expect(rejects(patched("ext.usage", { costUsd: -0.01 }))).toBe(true);
    expect(accepts(patched("ext.usage", { costUsd: null }))).toBe(true);
    expect(accepts(patched("ext.usage", { costUsd: 0 }))).toBe(true);
  });

  it("rejects an unknown onboarding step", () => {
    expect(rejects(patched("onboarding.step", { step: "billing" }))).toBe(true);
    expect(rejects(patched("onboarding.step", { step: null }))).toBe(true);
    expect(rejects(patched("onboarding.step", { previous: "billing" }))).toBe(true);
  });

  it("allows a null previous step for the first step", () => {
    expect(accepts(patched("onboarding.step", { previous: null }))).toBe(true);
  });

  it.each(["2026-07-24", "24/07/2026", "2026-07-24 10:00:00", "2026-07-24T10:00:00+02:00", 1750000000])(
    "rejects completion timestamp %o",
    (at) => {
      expect(rejects(patched("onboarding.completed", { at }))).toBe(true);
    },
  );
});

describe("task and project events", () => {
  it("rejects unknown task shapes and phases", () => {
    expect(rejects(patched("task.created", { shape: "ship" }))).toBe(true);
    expect(rejects(patched("task.created", { shape: "PLAN" }))).toBe(true);
    expect(rejects(patched("task.created", { phase: "IN_PROGRESS" }))).toBe(true);
    expect(rejects(patched("task.phase_changed", { from: "queued" }))).toBe(true);
    expect(rejects(patched("task.phase_changed", { to: "SHIPPED" }))).toBe(true);
  });

  it("keeps idempotencyKey required even though it is nullable", () => {
    // Nullable-not-optional: a writer that omits the key would make replay
    // dedupe silently ineffective rather than loudly wrong.
    expect(accepts(patched("task.created", { idempotencyKey: null }))).toBe(true);
    expect(rejects(without("task.created", "idempotencyKey"))).toBe(true);
  });

  it("accepts a project.updated carrying only the id", () => {
    expect(accepts({ type: "project.updated", payload: { projectId: ULID_A } })).toBe(true);
    expect(rejects({ type: "project.updated", payload: {} })).toBe(true);
  });

  it("rejects an unknown failure cause on task.updated", () => {
    expect(rejects(patched("task.updated", { failureCause: "TIMEOUT" }))).toBe(true);
    expect(accepts(patched("task.updated", { failureCause: "GATE_ERROR" }))).toBe(true);
    expect(accepts(patched("task.updated", { failureCause: null }))).toBe(true);
  });

  it("validates every entry in a resolved cast", () => {
    const role: JsonRecord = {
      role: "builder",
      model: "anthropic/claude-opus-4",
      thinking: "high",
      family: "anthropic",
    };
    expect(accepts(patched("task.cast_resolved", { roles: [role, { ...role, role: "validator" }] }))).toBe(
      true,
    );
    expect(rejects(patched("task.cast_resolved", { roles: [{ ...role, role: "captain" }] }))).toBe(
      true,
    );
    expect(rejects(patched("task.cast_resolved", { roles: [{ ...role, family: "grok" }] }))).toBe(
      true,
    );
    expect(rejects(patched("task.cast_resolved", { roles: [{ ...role, seat: 1 }] }))).toBe(true);
    expect(rejects(patched("task.cast_resolved", { roles: [{ role: "builder" }] }))).toBe(true);
    expect(rejects(patched("task.cast_resolved", { roles: role }))).toBe(true);
  });

  it("pins clearedBy to the captain literal", () => {
    // Only the Captain may clear a sticky delivery block; a Brain-written
    // clearance must not be representable at all.
    expect(rejects(patched("task.delivery_block_resolved", { clearedBy: "brain" }))).toBe(true);
    expect(rejects(patched("task.delivery_block_resolved", { clearedBy: "Captain" }))).toBe(true);
  });
});

describe("session, worktree and wake events", () => {
  it("rejects an unknown agent role on spawn", () => {
    expect(rejects(patched("session.spawned", { role: "captain" }))).toBe(true);
    expect(rejects(patched("session.spawned", { role: "BUILDER" }))).toBe(true);
  });

  it("allows a null worktree path but requires the key", () => {
    expect(accepts(patched("session.spawned", { worktreePath: null }))).toBe(true);
    expect(rejects(without("session.spawned", "worktreePath"))).toBe(true);
  });

  it("rejects an unknown wake class", () => {
    expect(rejects(patched("wake.classified", { class: "IDLE" }))).toBe(true);
    expect(rejects(patched("wake.classified", { class: "progress" }))).toBe(true);
  });

  it("requires the absorbed/deliveredToBrain flags to be booleans", () => {
    expect(rejects(patched("wake.classified", { absorbed: "false" }))).toBe(true);
    expect(rejects(patched("wake.classified", { deliveredToBrain: 0 }))).toBe(true);
  });

  it("requires changedPaths to be a string array", () => {
    expect(accepts(patched("scout.write_violation", { changedPaths: [] }))).toBe(true);
    expect(rejects(patched("scout.write_violation", { changedPaths: "src/index.ts" }))).toBe(true);
    expect(rejects(patched("scout.write_violation", { changedPaths: [{ path: "a" }] }))).toBe(true);
  });
});

describe("brain, tool and gate events", () => {
  it("rejects an unknown brain status", () => {
    expect(rejects(patched("brain.status", { status: "idle" }))).toBe(true);
    expect(rejects(patched("brain.status", { status: "RUNNING" }))).toBe(true);
  });

  it.each([-1, 1.5, "3"])("rejects wake queue depth %o", (depth) => {
    expect(rejects(patched("brain.down", { wakeQueueDepth: depth }))).toBe(true);
  });

  it("rejects negative handoff percentages", () => {
    expect(rejects(patched("brain.handoff_triggered", { observedPct: -1 }))).toBe(true);
    expect(rejects(patched("brain.handoff_triggered", { thresholdPct: -0.5 }))).toBe(true);
  });

  it("allows a null fromModel only on handoff_completed", () => {
    // The very first Brain seat has no predecessor; a mid-flight handoff does.
    expect(accepts(patched("brain.handoff_completed", { fromModel: null }))).toBe(true);
    expect(rejects(patched("brain.handoff_triggered", { fromModel: null }))).toBe(true);
    expect(rejects(patched("brain.handoff", { fromModel: null }))).toBe(true);
  });

  it("rejects an unknown brain tool name on tool.invoked", () => {
    expect(rejects(patched("tool.invoked", { tool: "delete_repo" }))).toBe(true);
    expect(rejects(patched("tool.invoked", { tool: "create-task" }))).toBe(true);
    expect(accepts(patched("tool.invoked", { tool: "advance_phase" }))).toBe(true);
  });

  it("rejects an unknown tool error code", () => {
    expect(rejects(patched("tool.invoked", { errorCode: "TIMEOUT" }))).toBe(true);
    expect(accepts(patched("tool.invoked", { errorCode: "POLICY_VIOLATION" }))).toBe(true);
  });

  it.each([-1, 12.5, "12"])("rejects tool duration %o", (durationMs) => {
    expect(rejects(patched("tool.invoked", { durationMs }))).toBe(true);
  });

  it("keeps bridge.tool_call's tool name deliberately unconstrained", () => {
    // Unlike tool.invoked, this records what a session *asked* for — including
    // names the daemon does not implement, which is precisely what `accepted`
    // and `reason` exist to describe.
    expect(accepts(patched("bridge.tool_call", { tool: "delete_repo", accepted: false }))).toBe(true);
    expect(rejects(patched("bridge.tool_call", { tool: 7 }))).toBe(true);
  });

  it("rejects an unknown gate outcome or target", () => {
    expect(rejects(patched("gate.result", { outcome: "PASSED" }))).toBe(true);
    expect(rejects(patched("gate.result", { outcome: "RED" }))).toBe(true);
    expect(rejects(patched("gate.result", { target: "head" }))).toBe(true);
  });

  it.each(["PASS", "FAIL", "GATE_ERROR", "EXPECTED_RED"])("accepts gate outcome %s", (outcome) => {
    expect(accepts(patched("gate.result", { outcome }))).toBe(true);
  });

  it("rejects a negative gate attempt", () => {
    expect(rejects(patched("gate.result", { attempt: -1 }))).toBe(true);
    expect(accepts(patched("gate.result", { attempt: 0 }))).toBe(true);
  });

  it("refuses to record a green run as RED proof", () => {
    // gate.red_proven is replayed into memory to decide whether a gate was ever
    // proven failing. Accepting PASS here would let a green run masquerade as
    // proof of red and skip the whole point of the gate.
    expect(rejects(patched("gate.red_proven", { outcome: "PASS" }))).toBe(true);
    expect(rejects(patched("gate.red_proven", { outcome: "GATE_ERROR" }))).toBe(true);
    expect(accepts(patched("gate.red_proven", { outcome: "FAIL" }))).toBe(true);
  });

  it("rejects an empty gate source hash or HMAC", () => {
    // Empty strings would replay as a valid-looking proof for every gate.
    expect(rejects(patched("gate.red_proven", { gateSourceHash: "" }))).toBe(true);
    expect(rejects(patched("gate.red_proven", { hmac: "" }))).toBe(true);
    expect(rejects(patched("gate.red_proven", { hmac: null }))).toBe(true);
  });
});

describe("fusion, crew and AFK events", () => {
  it.each(["opinion", "fusion", "plan-fusion"])("accepts fusion kind %s", (kind) => {
    expect(accepts(patched("fusion.dispatched", { kind }))).toBe(true);
    expect(accepts(patched("fusion.completed", { kind }))).toBe(true);
  });

  it("rejects an unknown fusion kind", () => {
    expect(rejects(patched("fusion.dispatched", { kind: "debate" }))).toBe(true);
    expect(rejects(patched("fusion.completed", { kind: "Opinion" }))).toBe(true);
  });

  it("requires promptsIdentical to be a real boolean", () => {
    // This flag is the clean-room contract's verdict; a truthy string would
    // read as "identical" in every consumer while proving nothing.
    expect(rejects(patched("fusion.completed", { promptsIdentical: "true" }))).toBe(true);
    expect(rejects(patched("fusion.completed", { promptsIdentical: 1 }))).toBe(true);
    expect(rejects(without("fusion.completed", "promptsIdentical"))).toBe(true);
  });

  it("allows null aggregator family and contract verdict", () => {
    expect(accepts(patched("fusion.completed", { aggregatorFamily: null, contractOk: null }))).toBe(
      true,
    );
    expect(rejects(patched("fusion.completed", { aggregatorFamily: "grok" }))).toBe(true);
  });

  it("requires a string array of prompt refs", () => {
    expect(accepts(patched("prompt.installed", { refs: [] }))).toBe(true);
    expect(rejects(patched("prompt.installed", { refs: "brain/system" }))).toBe(true);
    expect(rejects(patched("prompt.installed", { refs: [{ ref: "brain/system" }] }))).toBe(true);
  });

  it("rejects an unknown model family on a fusion side", () => {
    expect(rejects(patched("fusion.side_completed", { family: "gemini" }))).toBe(true);
    expect(accepts(patched("fusion.side_completed", { family: "google" }))).toBe(true);
  });

  it("keeps the crew question/answer ids as ULIDs", () => {
    expect(rejects(patched("crew.question", { questionId: "q-1" }))).toBe(true);
    expect(rejects(patched("crew.answered", { sessionId: `${ULID_A}0` }))).toBe(true);
    // Crockford base32 is case-insensitive, so lowercase ids parse. Recorded
    // deliberately: a consumer that compares ids as raw strings (or a schema
    // tightened to uppercase-only) would break replay of already-written logs.
    expect(accepts(patched("crew.answered", { sessionId: ULID_A.toLowerCase() }))).toBe(true);
  });

  it("allows a null taskId on an unattached crew question", () => {
    expect(accepts(patched("crew.question", { taskId: null }))).toBe(true);
    expect(rejects(without("crew.question", "taskId"))).toBe(true);
  });

  it.each([-1, 1.5, "4"])("rejects AFK faq entry count %o", (faqEntries) => {
    expect(rejects(patched("afk.changed", { faqEntries }))).toBe(true);
  });

  it("allows an open-ended AFK window", () => {
    expect(accepts(patched("afk.changed", { until: null }))).toBe(true);
    expect(rejects(patched("afk.changed", { until: "2026-07-24" }))).toBe(true);
  });

  it("rejects an unknown escalation severity", () => {
    expect(rejects(patched("captain.escalation", { severity: "urgent" }))).toBe(true);
    expect(rejects(patched("captain.escalation", { severity: "CRITICAL" }))).toBe(true);
  });
});

describe("eventEnvelopeSchema", () => {
  const sample = SAMPLE_BY_TYPE.get("daemon.started")!;

  it("accepts a well-formed envelope", () => {
    const result = eventEnvelopeSchema.safeParse(envelope(sample));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.event).toEqual(sample);
  });

  it.each([0, -1, 1.5, "1", null])("rejects seq %o", (seq) => {
    // seq is the replay ordinal: zero, negative or fractional values would
    // corrupt ordering and resume-from-last-seq for every consumer.
    expect(eventEnvelopeSchema.safeParse({ ...envelope(sample), seq }).success).toBe(false);
  });

  it.each([
    "not-a-ulid",
    "3f1e0c1a-0b3a-4f5e-8a1b-9c2d3e4f5a6b",
    "01J0ZQ8P0000000000000000A",
    "01J0ZQ8P0000000000000000ABC",
    "01J0ZQ8P0000000000000000AI",
    "",
  ])("rejects envelope id %o", (id) => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope(sample), id }).success).toBe(false);
  });

  it.each(["2026-07-24", "2026-07-24T10:00:00+02:00", "not a date", 1750000000, null])(
    "rejects envelope ts %o",
    (ts) => {
      expect(eventEnvelopeSchema.safeParse({ ...envelope(sample), ts }).success).toBe(false);
    },
  );

  it("rejects an unknown envelope key", () => {
    expect(
      eventEnvelopeSchema.safeParse({ ...envelope(sample), actor: "brain" }).success,
    ).toBe(false);
  });

  it.each(["id", "seq", "ts", "event"])("requires envelope key %s", (key) => {
    const value = envelope(sample);
    delete value[key];
    expect(eventEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an envelope wrapping an invalid event", () => {
    expect(
      eventEnvelopeSchema.safeParse({
        ...envelope(sample),
        event: { type: "daemon.started", payload: { version: "0.1.0", pid: 0, home: "/h", port: 1 } },
      }).success,
    ).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...envelope(sample), event: null }).success).toBe(false);
  });

  it("reports the failing path through the nested event payload", () => {
    const result = eventEnvelopeSchema.safeParse({
      ...envelope(sample),
      event: { type: "daemon.started", payload: { version: "0.1.0", pid: -1, home: "/h", port: 1 } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join(".") === "event.payload.pid")).toBe(
      true,
    );
  });
});

describe("sseFrameSchema", () => {
  const sample = SAMPLE_BY_TYPE.get("brain.down")!;
  const frame = (): JsonRecord => ({ id: ULID_A, event: "brain.down", data: envelope(sample) });

  it("accepts a well-formed frame", () => {
    expect(sseFrameSchema.safeParse(frame()).success).toBe(true);
  });

  it("requires data to be a full envelope, not a bare event", () => {
    // The SSE `data` field is what the console replays from; a bare event has
    // no seq and would break resume-after-disconnect.
    expect(sseFrameSchema.safeParse({ ...frame(), data: toRecord(sample) }).success).toBe(false);
  });

  it.each(["id", "event", "data"])("requires frame key %s", (key) => {
    const value = frame();
    delete value[key];
    expect(sseFrameSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an unknown frame key", () => {
    expect(sseFrameSchema.safeParse({ ...frame(), retry: 1000 }).success).toBe(false);
  });

  it("rejects a non-ULID frame id", () => {
    expect(sseFrameSchema.safeParse({ ...frame(), id: "1" }).success).toBe(false);
  });
});
