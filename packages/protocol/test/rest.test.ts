import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  apiKeyConnectRequestSchema,
  attachTicketResponseSchema,
  connectionsListResponseSchema,
  eventsReplayResponseSchema,
  healthResponseSchema,
  oauthStartRequestSchema,
  onboardingAdvanceRequestSchema,
  projectRegisterRequestSchema,
  runHistoryRowSchema,
  SAFETY_CONFIRM_HEADER,
  sessionDetailResponseSchema,
  statusResponseSchema,
  taskCreateRequestSchema,
  taskEventsResponseSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
} from "../src/rest.js";
import {
  LEGAL_TASK_TRANSITIONS,
  piModelRefSchema,
  taskFailureCauseSchema,
  taskPhaseSchema,
  taskSnapshotSchema,
  taskSpecSchema,
  TERMINAL_TASK_PHASES,
  type TaskPhase,
} from "../src/tasks.js";
import { PI_PINNED_VERSION } from "../src/pi.js";

/**
 * Every assertion here is a rejection path, a default that carries a safety
 * consequence, or a structural invariant of the task state machine. Round-trip
 * "it parses what I just built" assertions are deliberately absent — valid
 * fixtures exist only so the rejection cases differ from them by one field.
 */

const ULID = "01J8Z9K2QF3M4N5P6R7S8T9V0W";
const TS = "2026-07-26T10:00:00.000Z";

/** `safeParse` takes `unknown`, so malformed fixtures need no cast. */
const accepts = (schema: z.ZodType, value: unknown): boolean =>
  schema.safeParse(value).success;

/** Drop a key so "omitted" can be told apart from "present and null". */
const omit = (source: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...source };
  delete clone[key];
  return clone;
};

// ── tasks.ts: piModelRefSchema ─────────────────────────────────────────────

describe("piModelRefSchema", () => {
  /**
   * The provider prefix is what Pi routes on. A bare model name reaching Pi
   * resolves against whatever the default provider happens to be, so a cast
   * meant for `anthropic/…` could silently run on another vendor — which also
   * defeats the cross-family validator independence check.
   */
  it.each([
    ["bare model name, no provider", "claude-sonnet-4-5"],
    ["empty provider segment", "/claude-sonnet-4-5"],
    ["empty model segment", "anthropic/"],
    ["whitespace inside the provider", "anthro pic/claude"],
    ["whitespace opening the model", "anthropic/ claude"],
    ["slash only", "/"],
    ["empty string", ""],
    ["not a string", 42],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(accepts(piModelRefSchema, value)).toBe(false);
  });

  it("accepts an aggregator ref that carries a nested vendor segment", () => {
    // familyOfModelRef peels this second segment; rejecting it would make every
    // OpenRouter cast unrepresentable.
    expect(accepts(piModelRefSchema, "openrouter/anthropic/claude-sonnet-4-5")).toBe(true);
  });
});

// ── tasks.ts: task spec ────────────────────────────────────────────────────

const shipSpec = {
  shape: "SHIP",
  title: "Ship the thing",
  intent: "Do the work",
  projectId: ULID,
  mode: "pipeline",
} as const;

const scoutSpec = {
  shape: "SCOUT",
  title: "Scout the thing",
  intent: "Look around",
  projectId: ULID,
} as const;

describe("taskSpecSchema", () => {
  it("defaults SHIP.yolo to false when omitted", () => {
    // yolo=true lets safety policy drop fusion / plan-fusion. If this default
    // ever flipped, every task created without an explicit flag would quietly
    // skip the review stage.
    const parsed = taskSpecSchema.parse(shipSpec);
    expect(parsed.shape).toBe("SHIP");
    expect(parsed.shape === "SHIP" && parsed.yolo).toBe(false);
  });

  it("rejects `yolo` on a SCOUT spec instead of ignoring it", () => {
    // SCOUT is always read-only. A stripped-and-ignored yolo would read as
    // "accepted" to the caller; strictObject makes the refusal explicit.
    expect(accepts(taskSpecSchema, { ...scoutSpec, yolo: true })).toBe(false);
  });

  it("requires an explicit mode for SHIP but defaults SCOUT to local-only", () => {
    expect(accepts(taskSpecSchema, omit(shipSpec, "mode"))).toBe(false);

    const parsedScout = taskSpecSchema.parse(scoutSpec);
    expect(parsedScout.mode).toBe("local-only");
  });

  it.each([
    ["an unknown shape", { ...shipSpec, shape: "RECON" }],
    ["a missing discriminator", { title: "t", intent: "i", projectId: ULID, mode: "pipeline" }],
    ["a lowercase shape", { ...shipSpec, shape: "ship" }],
    ["an empty title", { ...shipSpec, title: "" }],
    ["a 201-character title", { ...shipSpec, title: "a".repeat(201) }],
    ["an empty intent", { ...shipSpec, intent: "" }],
    ["a 20001-character intent", { ...shipSpec, intent: "a".repeat(20_001) }],
    ["a UUID where a ULID is required", { ...shipSpec, projectId: "550e8400-e29b-41d4-a716-446655440000" }],
    ["a 25-character ULID", { ...shipSpec, projectId: ULID.slice(0, 25) }],
    ["an unknown project mode", { ...shipSpec, mode: "yolo-mode" }],
    ["an unmodelled extra field", { ...shipSpec, priority: "high" }],
    ["an empty fusionProfile", { ...shipSpec, fusionProfile: "" }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(taskSpecSchema, value)).toBe(false);
  });

  it("accepts a 200-character title (the boundary itself is legal)", () => {
    expect(accepts(taskSpecSchema, { ...shipSpec, title: "a".repeat(200) })).toBe(true);
  });
});

// ── tasks.ts: task snapshot ────────────────────────────────────────────────

const snapshot = {
  id: ULID,
  shape: "SHIP",
  title: "Ship the thing",
  intent: "Do the work",
  projectId: ULID,
  mode: "pipeline",
  yolo: false,
  phase: "QUEUED",
  failureCause: null,
  cast: [],
  sessions: [],
  validationAttempt: 0,
  maxValidations: 3,
  branch: null,
  worktreePath: null,
  needsCaptainSummary: null,
  deliveryBlocked: null,
  idempotencyKey: null,
  createdAt: TS,
  updatedAt: TS,
  configSnapshotHash: null,
  policyOverrides: [],
} as const;

describe("taskSnapshotSchema", () => {
  it("defaults redProof and lastFailLedger to null, never undefined", () => {
    // Both are daemon-authoritative and rebuilt on boot. `undefined` would make
    // `snapshot.redProof === null` checks false and read as "proof present".
    const parsed = taskSnapshotSchema.parse(snapshot);
    expect(parsed.redProof).toBeNull();
    expect(parsed.lastFailLedger).toBeNull();
  });

  it("requires deliveryBlocked to be stated explicitly", () => {
    // The sticky delivery block has no default: an omitted field must not be
    // readable as "not blocked", or a snapshot round-trip could clear it.
    expect(accepts(taskSnapshotSchema, omit(snapshot, "deliveryBlocked"))).toBe(false);
  });

  it.each([
    ["maxValidations of 0 (a cap that is exhausted before the first attempt)", { maxValidations: 0 }],
    ["a negative maxValidations", { maxValidations: -1 }],
    ["a negative validationAttempt", { validationAttempt: -1 }],
    ["a fractional validationAttempt", { validationAttempt: 1.5 }],
    ["a lowercase phase", { phase: "queued" }],
    ["a phase that is not in the enum", { phase: "IN_PROGRESS" }],
    ["a failureCause that is not in the enum", { failureCause: "TIMEOUT" }],
    ["a non-ISO createdAt", { createdAt: "2026-07-26" }],
    ["a timezone-less timestamp", { createdAt: "2026-07-26T10:00:00" }],
    ["an unmodelled extra field", { serverSecret: "s3cret" }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts(taskSnapshotSchema, { ...snapshot, ...patch })).toBe(false);
  });

  describe("redProof", () => {
    const proof = {
      gateSourceHash: "abc123",
      outcome: "EXPECTED_RED",
      provenAt: TS,
      hmac: "deadbeef",
    } as const;

    it("rejects a proof with no HMAC", () => {
      // The HMAC is the only thing separating a daemon-signed RED baseline from
      // a value a seat wrote to disk. An optional HMAC would let a builder
      // fabricate its own red proof and skip the gate.
      expect(accepts(taskSnapshotSchema, { ...snapshot, redProof: omit(proof, "hmac") })).toBe(
        false,
      );
    });

    it("rejects an empty-string HMAC", () => {
      expect(accepts(taskSnapshotSchema, { ...snapshot, redProof: { ...proof, hmac: "" } })).toBe(
        false,
      );
    });

    it("rejects a PASS outcome — a green baseline is not a red proof", () => {
      expect(
        accepts(taskSnapshotSchema, { ...snapshot, redProof: { ...proof, outcome: "PASS" } }),
      ).toBe(false);
    });
  });

  it("rejects a deliveryBlocked stamp with no reason", () => {
    expect(
      accepts(taskSnapshotSchema, {
        ...snapshot,
        deliveryBlocked: { leaseId: "lease-1", reason: "", dirtyPaths: [], blockedAt: TS },
      }),
    ).toBe(false);
  });
});

// ── tasks.ts: state machine ────────────────────────────────────────────────

const ALL_PHASES: readonly TaskPhase[] = taskPhaseSchema.options;

function reachableFrom(start: TaskPhase): ReadonlySet<TaskPhase> {
  const seen = new Set<TaskPhase>();
  const queue: TaskPhase[] = [start];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of LEGAL_TASK_TRANSITIONS[current]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const predecessorsOf = (phase: TaskPhase): TaskPhase[] =>
  ALL_PHASES.filter((from) => LEGAL_TASK_TRANSITIONS[from].includes(phase));

describe("LEGAL_TASK_TRANSITIONS", () => {
  it("covers every phase in the enum and names no phase outside it", () => {
    // A typo'd key or target is not a type error at runtime once the table is
    // read from a string phase, and it silently makes a transition unreachable.
    expect(Object.keys(LEGAL_TASK_TRANSITIONS).sort()).toEqual([...ALL_PHASES].sort());
    for (const phase of ALL_PHASES) {
      for (const target of LEGAL_TASK_TRANSITIONS[phase]) {
        expect(taskPhaseSchema.safeParse(target).success).toBe(true);
      }
    }
  });

  it("lists no phase twice in the same target set", () => {
    for (const phase of ALL_PHASES) {
      const targets = LEGAL_TASK_TRANSITIONS[phase];
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it("permits no self-transition", () => {
    // A self-loop lets the validation counter climb without the phase moving,
    // which is exactly how a task spins forever without ever hitting its cap.
    for (const phase of ALL_PHASES) {
      expect(LEGAL_TASK_TRANSITIONS[phase]).not.toContain(phase);
    }
  });

  it("keeps TERMINAL_TASK_PHASES in exact agreement with the empty target sets", () => {
    // Two sources of truth for "this task is over". If a phase is emptied but
    // not added to TERMINAL_TASK_PHASES, reconcile treats a dead task as live.
    const deadEnds = ALL_PHASES.filter((p) => LEGAL_TASK_TRANSITIONS[p].length === 0);
    expect([...deadEnds].sort()).toEqual([...TERMINAL_TASK_PHASES].sort());
  });

  it("leaves no non-terminal phase without a route to a terminal phase", () => {
    for (const phase of ALL_PHASES) {
      if (TERMINAL_TASK_PHASES.includes(phase)) continue;
      const reachable = reachableFrom(phase);
      const canFinish = TERMINAL_TASK_PHASES.some((terminal) => reachable.has(terminal));
      expect(canFinish, `${phase} cannot reach any terminal phase`).toBe(true);
    }
  });

  it("lets the Captain cancel from every non-terminal phase in one step", () => {
    for (const phase of ALL_PHASES) {
      if (TERMINAL_TASK_PHASES.includes(phase)) continue;
      expect(LEGAL_TASK_TRANSITIONS[phase], `${phase} is not directly cancellable`).toContain(
        "CANCELLED",
      );
    }
  });

  it("makes every phase reachable from QUEUED", () => {
    // An orphan phase can be written into a snapshot by a bug but never entered
    // legally, so nothing would ever exercise the code that handles it.
    const reachable = reachableFrom("QUEUED");
    for (const phase of ALL_PHASES) {
      if (phase === "QUEUED") continue;
      expect(reachable.has(phase), `${phase} is unreachable from QUEUED`).toBe(true);
    }
  });

  it("admits DONE only from DELIVERING", () => {
    // The single door to DONE is the delivery step. Any other predecessor would
    // let a task be marked complete without its work ever being delivered.
    expect(predecessorsOf("DONE")).toEqual(["DELIVERING"]);
  });

  it("admits GATE_RED_VERIFIED only from GATE_AUTHORING", () => {
    // The red baseline cannot be short-circuited from BUILDING or NEEDS_CAPTAIN.
    expect(predecessorsOf("GATE_RED_VERIFIED")).toEqual(["GATE_AUTHORING"]);
  });

  it("does not let NEEDS_CAPTAIN jump straight to DONE", () => {
    expect(LEGAL_TASK_TRANSITIONS.NEEDS_CAPTAIN).not.toContain("DONE");
  });

  it("keeps VALIDATION_EXHAUSTED reachable from BUILDING (regression)", () => {
    // A candidate gate can FAIL straight out of BUILDING. When this edge was
    // missing the halt threw ILLEGAL_TRANSITION and the attempt counter climbed
    // past its cap instead of stopping.
    expect(LEGAL_TASK_TRANSITIONS.BUILDING).toContain("VALIDATION_EXHAUSTED");
    expect(LEGAL_TASK_TRANSITIONS.VALIDATING).toContain("VALIDATION_EXHAUSTED");
  });

  it("does not let VALIDATION_EXHAUSTED re-enter the build/validate loop", () => {
    // Re-entering would make the cap advisory: the task could loop forever by
    // bouncing through the exhausted phase.
    expect(LEGAL_TASK_TRANSITIONS.VALIDATION_EXHAUSTED).not.toContain("BUILDING");
    expect(LEGAL_TASK_TRANSITIONS.VALIDATION_EXHAUSTED).not.toContain("VALIDATING");
  });

  it("keeps the build↔validate retry loop intact in both directions", () => {
    expect(LEGAL_TASK_TRANSITIONS.BUILDING).toContain("VALIDATING");
    expect(LEGAL_TASK_TRANSITIONS.VALIDATING).toContain("BUILDING");
  });
});

describe("taskFailureCauseSchema", () => {
  it.each(["timeout", "CAPTAIN CANCEL", "captain_cancel", ""])(
    "rejects %o",
    (value) => {
      expect(accepts(taskFailureCauseSchema, value)).toBe(false);
    },
  );
});

// ── rest.ts: health & status ───────────────────────────────────────────────

describe("healthResponseSchema", () => {
  const health = { ok: true, name: "agentosd", version: "0.1.0", pid: 4242 } as const;

  it.each([
    ["ok:false — the literal is the liveness contract", { ok: false }],
    ["a foreign daemon name", { name: "agentos" }],
    ["pid 0", { pid: 0 }],
    ["a negative pid", { pid: -1 }],
    ["a fractional pid", { pid: 42.5 }],
    ["a stringified pid", { pid: "4242" }],
    ["an unmodelled extra field", { debugToken: "t" }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts(healthResponseSchema, { ...health, ...patch })).toBe(false);
  });
});

describe("statusResponseSchema", () => {
  const status = {
    daemon: {
      version: "0.1.0",
      pid: 4242,
      home: "/home/.agentos",
      port: 4317,
      startedAt: TS,
      uptimeSeconds: 0,
    },
    events: { count: 0, lastSeq: 0, lastId: null },
  } as const;

  it("rejects a pi block whose pinnedVersion drifts from PI_PINNED_VERSION", () => {
    // The pin is the whole point of reporting it: a status payload claiming a
    // different pinned version means the daemon and the protocol disagree about
    // which Pi is supported, and the Console would render the daemon's claim.
    expect(
      accepts(statusResponseSchema, {
        ...status,
        pi: {
          pinnedVersion: "0.0.0-not-the-pin",
          detectedVersion: null,
          binary: null,
          managedHome: null,
          configDirEnv: null,
        },
      }),
    ).toBe(false);
    expect(PI_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    ["a negative uptime", { daemon: { ...status.daemon, uptimeSeconds: -1 } }],
    ["port 0", { daemon: { ...status.daemon, port: 0 } }],
    ["a fractional port", { daemon: { ...status.daemon, port: 4317.5 } }],
    ["a negative lastSeq", { events: { ...status.events, lastSeq: -1 } }],
    ["a fractional lastSeq", { events: { ...status.events, lastSeq: 1.5 } }],
    ["a negative event count", { events: { ...status.events, count: -1 } }],
    ["a non-ULID lastId", { events: { ...status.events, lastId: "seq-1" } }],
    ["an unmodelled top-level field", { uptime: 1 }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts(statusResponseSchema, { ...status, ...patch })).toBe(false);
  });

  it("omits the pi block entirely rather than accepting a partial one", () => {
    expect(accepts(statusResponseSchema, status)).toBe(true);
    expect(accepts(statusResponseSchema, { ...status, pi: { pinnedVersion: PI_PINNED_VERSION } })).toBe(
      false,
    );
  });
});

// ── rest.ts: errors ────────────────────────────────────────────────────────

describe("apiErrorResponseSchema", () => {
  it("requires `issues` to be present even when there are none", () => {
    // `issues` is nullable but not optional. Clients branch on `issues === null`
    // to decide between a field-level and a message-level error display; an
    // omitted key would land in neither branch.
    expect(accepts(apiErrorResponseSchema, { error: { code: "NOT_FOUND", message: "gone" } })).toBe(
      false,
    );
    expect(
      accepts(apiErrorResponseSchema, { error: { code: "NOT_FOUND", message: "gone", issues: null } }),
    ).toBe(true);
  });

  it.each([
    ["an unknown error code", { code: "TEAPOT", message: "m", issues: null }],
    ["a lowercase error code", { code: "not_found", message: "m", issues: null }],
    ["a numeric HTTP status in place of a code", { code: 404, message: "m", issues: null }],
    ["an extra field beside the error", { code: "NOT_FOUND", message: "m", issues: null, stack: "…" }],
  ])("rejects %s", (_label, error) => {
    expect(accepts(apiErrorResponseSchema, { error })).toBe(false);
  });

  it("keeps CONFIRMATION_REQUIRED in the code set that guards safety writes", () => {
    // app.ts returns this code when the confirm header is absent; dropping it
    // from the enum would make the daemon's own error body unparseable.
    expect(apiErrorCodeSchema.options).toContain("CONFIRMATION_REQUIRED");
    expect(apiErrorCodeSchema.options).toContain("ILLEGAL_TRANSITION");
  });
});

describe("SAFETY_CONFIRM_HEADER", () => {
  it("is lower-case and whitespace-free", () => {
    // The daemon looks it up as `request.headers[SAFETY_CONFIRM_HEADER]`, and
    // Node lower-cases every incoming header name. Any upper-case character
    // here makes the lookup permanently undefined, so safety-policy writes
    // would be rejected no matter what the Captain sends.
    expect(SAFETY_CONFIRM_HEADER).toBe(SAFETY_CONFIRM_HEADER.toLowerCase());
    expect(SAFETY_CONFIRM_HEADER).not.toMatch(/\s/);
    expect(SAFETY_CONFIRM_HEADER).toBe("x-agentos-confirm-safety");
  });
});

// ── rest.ts: request DTOs at the daemon edge ───────────────────────────────

describe("projectRegisterRequestSchema", () => {
  const request = { name: "agent-os", path: "/repos/agent-os" } as const;

  it.each([
    ["an empty name", { name: "" }],
    ["a 101-character name", { name: "a".repeat(101) }],
    ["an empty path", { path: "" }],
    ["a caller-supplied id", { id: ULID }],
    ["a caller-supplied trustHash", { trustHash: "forged" }],
    ["a stringy boolean for trusted", { trusted: "true" }],
    ["a stringy boolean for yolo", { yolo: "false" }],
    ["a numeric boolean for trusted", { trusted: 1 }],
    ["an unknown mode", { mode: "direct-push" }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts(projectRegisterRequestSchema, { ...request, ...patch })).toBe(false);
  });

  it("accepts a 100-character name at the boundary", () => {
    expect(accepts(projectRegisterRequestSchema, { ...request, name: "a".repeat(100) })).toBe(true);
  });
});

describe("taskCreateRequestSchema", () => {
  it.each([
    ["an empty idempotencyKey", { spec: shipSpec, idempotencyKey: "" }],
    ["a 201-character idempotencyKey", { spec: shipSpec, idempotencyKey: "k".repeat(201) }],
    ["a missing spec", { idempotencyKey: "k" }],
    ["a spec that is not an object", { spec: "SHIP" }],
    ["a spec whose intent overflows", { spec: { ...shipSpec, intent: "a".repeat(20_001) } }],
    ["a spec carrying an unmodelled field", { spec: { ...shipSpec, autoApprove: true } }],
    ["an extra top-level field", { spec: shipSpec, priority: 1 }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(taskCreateRequestSchema, value)).toBe(false);
  });

  it("accepts a 200-character idempotencyKey at the boundary", () => {
    expect(accepts(taskCreateRequestSchema, { spec: shipSpec, idempotencyKey: "k".repeat(200) })).toBe(
      true,
    );
  });
});

describe("toolCallRequestSchema", () => {
  it.each([
    ["a tool name outside the catalog", { tool: "delete_project", input: {} }],
    ["a tool name in the wrong case", { tool: "Create_Task", input: {} }],
    ["an array as input", { tool: "read_task", input: [] }],
    ["a null input", { tool: "read_task", input: null }],
    ["a string input", { tool: "read_task", input: "{}" }],
    ["a missing input", { tool: "read_task" }],
    ["a non-ULID sessionId", { tool: "read_task", input: {}, sessionId: "session-7" }],
    ["an empty idempotencyKey", { tool: "read_task", input: {}, idempotencyKey: "" }],
    ["a 201-character idempotencyKey", { tool: "read_task", input: {}, idempotencyKey: "k".repeat(201) }],
    ["an extra field beside the call", { tool: "read_task", input: {}, bypassPolicy: true }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(toolCallRequestSchema, value)).toBe(false);
  });

  it("treats sessionId as the narrowing knob it is, not a free-form label", () => {
    // Supplying a sessionId applies that session's *narrower* rights. If the
    // field accepted arbitrary strings, a typo would silently fall back to the
    // unrestricted Captain path instead of erroring.
    expect(accepts(toolCallRequestSchema, { tool: "read_task", input: {}, sessionId: ULID })).toBe(
      true,
    );
    expect(accepts(toolCallRequestSchema, { tool: "read_task", input: {}, sessionId: "" })).toBe(
      false,
    );
  });
});

describe("toolCallResponseSchema", () => {
  it.each([
    ["a non-ULID invocationId", { invocationId: "inv-1", ok: true }],
    ["a missing ok flag", { invocationId: ULID }],
    ["a stringy ok flag", { invocationId: ULID, ok: "true" }],
    ["an error object with an extra field", { invocationId: ULID, ok: false, error: { code: "X", message: "m", stack: "…" } }],
    ["an error object with no message", { invocationId: ULID, ok: false, error: { code: "X" } }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(toolCallResponseSchema, value)).toBe(false);
  });
});

describe("oauthStartRequestSchema", () => {
  it.each([
    ["a marketing name instead of a provider id", { provider: "claude" }],
    ["a provider id in the wrong case", { provider: "Anthropic" }],
    ["an unknown billing mode", { provider: "anthropic", billingMode: "free" }],
    ["an extra field", { provider: "anthropic", redirectUri: "http://evil" }],
    ["no provider at all", {}],
  ])("rejects %s", (_label, value) => {
    expect(accepts(oauthStartRequestSchema, value)).toBe(false);
  });

  it("distinguishes an explicit null billingMode from an omitted one", () => {
    expect(accepts(oauthStartRequestSchema, { provider: "openai" })).toBe(true);
    expect(accepts(oauthStartRequestSchema, { provider: "openai", billingMode: null })).toBe(true);
  });
});

describe("apiKeyConnectRequestSchema", () => {
  it.each([
    ["an empty api key", { provider: "openai", apiKey: "" }],
    ["a null api key", { provider: "openai", apiKey: null }],
    ["a missing api key", { provider: "openai" }],
    ["an empty label", { provider: "openai", apiKey: "sk-live", label: "" }],
    ["an unknown provider", { provider: "cohere", apiKey: "sk-live" }],
    ["an extra secret-bearing field", { provider: "openai", apiKey: "sk-live", apiSecret: "s" }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(apiKeyConnectRequestSchema, value)).toBe(false);
  });
});

describe("onboardingAdvanceRequestSchema", () => {
  it.each([
    ["an action outside the wizard", { action: "skip" }],
    ["an action in the wrong case", { action: "Complete" }],
    ["no action", {}],
    ["an unknown provider in the list", { action: "set-providers", providers: ["claude"] }],
    ["a non-array providers value", { action: "set-providers", providers: "anthropic" }],
    ["an unknown connection kind", { action: "verify-auth", kind: "oauth" }],
    ["an extra field", { action: "complete", force: true }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(onboardingAdvanceRequestSchema, value)).toBe(false);
  });
});

// ── rest.ts: response DTOs the Console reads ───────────────────────────────

describe("attachTicketResponseSchema", () => {
  const ticket = { sessionId: ULID, ticket: "one-shot", expiresAt: TS, wsUrl: "ws://127.0.0.1:1/x" };

  it.each([
    ["an empty ticket — an empty credential must never serialise", { ticket: "" }],
    ["a missing ticket", { ticket: undefined }],
    ["an empty wsUrl", { wsUrl: "" }],
    ["a missing expiry — a ticket with no deadline is not single-use", { expiresAt: undefined }],
    ["a non-ISO expiry", { expiresAt: "in 60 seconds" }],
    ["a non-ULID sessionId", { sessionId: "session-7" }],
    ["a leaked bearer token alongside the ticket", { token: "bearer-abc" }],
  ])("rejects %s", (_label, patch) => {
    const candidate: Record<string, unknown> = { ...ticket, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete candidate[key];
    }
    expect(accepts(attachTicketResponseSchema, candidate)).toBe(false);
  });
});

describe("sessionDetailResponseSchema", () => {
  it("requires taskTitle and attachCommand even when the session is null", () => {
    // All three keys are nullable; none is optional. A missing key would render
    // as `undefined` in the Agent Detail view rather than the intended dash.
    expect(
      accepts(sessionDetailResponseSchema, {
        session: null,
        taskTitle: null,
        attachCommand: null,
      }),
    ).toBe(true);
    expect(accepts(sessionDetailResponseSchema, { session: null, taskTitle: null })).toBe(false);
    expect(accepts(sessionDetailResponseSchema, { session: null, attachCommand: null })).toBe(false);
  });
});

describe("event-window responses", () => {
  it.each([
    ["a stringy truncated flag", { events: [], truncated: "false" }],
    ["a missing truncated flag", { events: [] }],
    ["a non-array events field", { events: {}, truncated: false }],
    ["an extra field", { events: [], truncated: false, nextCursor: "abc" }],
  ])("eventsReplayResponseSchema rejects %s", (_label, value) => {
    expect(accepts(eventsReplayResponseSchema, value)).toBe(false);
  });

  it("taskEventsResponseSchema requires a ULID taskId scoping the window", () => {
    // `truncated` here means "this task has more frames", not "the global log
    // is large". Losing the taskId would let a global page masquerade as
    // task-scoped evidence.
    expect(accepts(taskEventsResponseSchema, { taskId: ULID, events: [], truncated: false })).toBe(
      true,
    );
    expect(accepts(taskEventsResponseSchema, { events: [], truncated: false })).toBe(false);
    expect(
      accepts(taskEventsResponseSchema, { taskId: "task-1", events: [], truncated: false }),
    ).toBe(false);
  });
});

describe("runHistoryRowSchema", () => {
  const task = {
    id: ULID,
    shape: "SHIP",
    title: "Ship the thing",
    phase: "DONE",
    projectId: ULID,
    projectName: "agent-os",
    mode: "pipeline",
    model: "anthropic/claude-sonnet-4-5",
    agent: "builder",
    updatedAt: TS,
    createdAt: TS,
  } as const;
  const row = {
    task,
    gateRuns: 2,
    gateFailures: 1,
    gateErrors: 0,
    fusionRuns: 1,
    firstSeen: TS,
    lastSeen: TS,
  } as const;

  it.each([
    ["a negative gateRuns", { gateRuns: -1 }],
    ["a negative gateFailures", { gateFailures: -1 }],
    ["a fractional fusionRuns", { fusionRuns: 1.5 }],
    ["a missing firstSeen — nullable is not optional", { firstSeen: undefined }],
    ["a bare model name on the embedded task", { task: { ...task, model: "claude-sonnet-4-5" } }],
    ["an unknown phase on the embedded task", { task: { ...task, phase: "SHIPPED" } }],
    ["an extra aggregate field", { gateSkips: 0 }],
  ])("rejects %s", (_label, patch) => {
    const candidate: Record<string, unknown> = { ...row, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete candidate[key];
    }
    expect(accepts(runHistoryRowSchema, candidate)).toBe(false);
  });
});

describe("connectionsListResponseSchema", () => {
  it("pins the reported Pi version to the protocol constant", () => {
    expect(
      accepts(connectionsListResponseSchema, {
        connections: [],
        piPinnedVersion: PI_PINNED_VERSION,
      }),
    ).toBe(true);
    expect(accepts(connectionsListResponseSchema, { connections: [], piPinnedVersion: "9.9.9" })).toBe(
      false,
    );
    expect(accepts(connectionsListResponseSchema, { connections: [] })).toBe(false);
  });
});

// ── pagination guard: documented absence ───────────────────────────────────

describe("pagination limits", () => {
  /**
   * A negative `limit` reaching SQLite disables paging entirely (SQLite reads a
   * negative LIMIT as unlimited), so a single `?limit=-5` can serialise the
   * whole log. There is deliberately no shared limit schema in `rest.ts` today
   * — every paged route re-derives its own guard in `apps/orchestrator`. This
   * test fails the moment one is introduced, so the boundary cases below stop
   * being someone else's problem and get tested here.
   */
  it("has no pagination request DTO in rest.ts yet", async () => {
    const rest: Record<string, unknown> = await import("../src/rest.js");
    const paginationExports = Object.keys(rest).filter((name) =>
      /(limit|paginat|cursor|offset|page)/i.test(name),
    );
    expect(
      paginationExports,
      "a limit/pagination schema landed in rest.ts — add negative/zero/fractional/over-max rejection cases for it here",
    ).toEqual([]);
  });
});
