import { describe, expect, it } from "vitest";
import {
  daemonControlFrameSchema,
  extensionHelloFrameSchema,
  extensionLifecycleFrameSchema,
  extensionQuestionFrameSchema,
  extensionToDaemonFrameSchema,
  extensionToolBlockedFrameSchema,
  extensionToolCallFrameSchema,
  extensionUsageFrameSchema,
  type DaemonControlFrame,
  type ExtensionToDaemonFrame,
} from "../src/sockets.js";
import {
  PI_CONFIG_DIR_ENV_CANDIDATES,
  PI_PINNED_VERSION,
  piAuthBrokerModeSchema,
  piSpawnSpecSchema,
} from "../src/pi.js";

/**
 * `src/sockets.ts` is the wire between a Pi extension running inside an agent
 * process and the Agent OS daemon. Both peers parse NDJSON lines from an
 * untrusted-ish socket, so every assertion here is about what the schema
 * REFUSES: the daemon's socket hub and the extension's reader both `continue`
 * on a failed `safeParse`, which means anything these schemas accept is
 * dispatched for real.
 *
 * `src/pi.ts` is the spawn contract for the managed Pi process — argv, config
 * dir, and the exact harness pin — so the refusals there are about not handing
 * a shell string or a secret to a child process.
 */

const TS = "2026-07-24T12:00:00.000Z";
const SESSION_ID = "01HQ8W7YV3ZQK9N6M4R2XJ0T5C";
const OTHER_SESSION_ID = "01HQ8W7YV3ZQK9N6M4R2XJ0T60";
const INVOCATION_ID = "01HQ8W7YV3ZQK9N6M4R2XJ0T61";

/** Every frame the extension may legally emit, one of each `type`. */
const validExtensionFrames: readonly ExtensionToDaemonFrame[] = [
  {
    type: "ext.hello",
    sessionId: SESSION_ID,
    role: "builder",
    piVersion: PI_PINNED_VERSION,
    extensionVersion: "0.1.0",
    ts: TS,
  },
  {
    type: "ext.lifecycle",
    sessionId: SESSION_ID,
    phase: "turn_start",
    detail: null,
    ts: TS,
  },
  {
    type: "ext.usage",
    sessionId: SESSION_ID,
    provider: "anthropic",
    model: "claude-opus-4",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.5,
    contextUsedPct: 12.5,
    ts: TS,
  },
  {
    type: "ext.tool_blocked",
    sessionId: SESSION_ID,
    toolName: "spawn_crewmate",
    reason: "policy",
    ts: TS,
  },
  {
    type: "ext.tool_call",
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    tool: "ask_captain",
    input: { question: "ship it?" },
    ts: TS,
  },
  {
    type: "ext.question",
    sessionId: SESSION_ID,
    questionId: INVOCATION_ID,
    question: "Which branch?",
    ts: TS,
  },
];

/** Every control frame the daemon may legally emit, one of each `type`. */
const validControlFrames: readonly DaemonControlFrame[] = [
  { type: "ctl.ack", ref: "ext.hello", ts: TS },
  { type: "ctl.injectMessage", sessionId: SESSION_ID, message: "stand by", ts: TS },
  { type: "ctl.shutdown", reason: "daemon restart", ts: TS },
  {
    type: "ctl.tool_result",
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    ok: true,
    data: { answer: "yes" },
    ts: TS,
  },
];

/** Drop one key from a frame without reaching for `any`. */
function omitKey(frame: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...frame };
  delete copy[key];
  return copy;
}

function asRecord(frame: ExtensionToDaemonFrame | DaemonControlFrame): Record<string, unknown> {
  return { ...frame } as Record<string, unknown>;
}

describe("frame direction is not interchangeable", () => {
  it("refuses a ctl.* frame offered to the extension→daemon schema", () => {
    // The daemon feeds everything a per-session peer writes through
    // extensionToDaemonFrameSchema. If control frames were accepted here, a
    // compromised extension could write `ctl.tool_result` onto its own socket
    // and forge the answer to a Brain tool call it never made.
    for (const frame of validControlFrames) {
      expect(extensionToDaemonFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it("refuses an ext.* frame offered to the daemon→extension control schema", () => {
    // Symmetrically, the extension must not act on a frame that a peer echoed
    // back to it: `ext.tool_call` reaching the extension's control reader
    // would be a self-addressed instruction with no daemon in the loop.
    for (const frame of validExtensionFrames) {
      expect(daemonControlFrameSchema.safeParse(frame).success).toBe(false);
    }
  });
});

describe("unknown and malformed frames", () => {
  it("refuses frame types that do not exist in the union", () => {
    // Plausible-looking names an attacker (or a future branch) might try. Each
    // one must fail closed rather than fall through to a permissive branch.
    const impostors = [
      "ext.exec",
      "ext.log",
      "ext.token",
      "ext.hello ", // trailing space
      "EXT.HELLO",
      "ctl.exec",
      "",
    ];
    for (const type of impostors) {
      const frame = { ...asRecord(validExtensionFrames[0]!), type };
      expect(extensionToDaemonFrameSchema.safeParse(frame).success).toBe(false);
      expect(daemonControlFrameSchema.safeParse({ ...frame, type }).success).toBe(false);
    }
  });

  it("refuses a frame with no discriminator at all", () => {
    const frame = omitKey(asRecord(validExtensionFrames[0]!), "type");
    const result = extensionToDaemonFrameSchema.safeParse(frame);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["type"]);
    }
  });

  it("refuses non-object JSON values that a peer can legally write as a line", () => {
    // `JSON.parse` succeeds on all of these, so the schema is the only thing
    // standing between them and `frame.data.sessionId`.
    for (const value of [null, 42, "ext.hello", true, [], [{ type: "ext.hello" }]]) {
      expect(extensionToDaemonFrameSchema.safeParse(value).success).toBe(false);
      expect(daemonControlFrameSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("strict objects reject unexpected properties", () => {
  it("rejects an extra property on every extension frame variant", () => {
    // Every frame in this file is a z.strictObject, so extra keys are a hard
    // rejection, not a silent strip. That is deliberate: the daemon forwards
    // `ext.tool_call.input` to the Brain tool dispatcher, and a stripped-but-
    // accepted smuggled field would be indistinguishable from a legitimate
    // frame in the event log.
    for (const frame of validExtensionFrames) {
      const result = extensionToDaemonFrameSchema.safeParse({
        ...asRecord(frame),
        smuggled: "payload",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
      }
    }
  });

  it("rejects an extra property on every control frame variant", () => {
    for (const frame of validControlFrames) {
      expect(
        daemonControlFrameSchema.safeParse({ ...asRecord(frame), smuggled: "payload" }).success,
      ).toBe(false);
    }
  });

  it("rejects an extra property nested inside ctl.tool_result.error", () => {
    // The error object is strict too — a peer cannot attach a `stack` or a
    // `retryAfter` the extension might be tempted to trust.
    const result = daemonControlFrameSchema.safeParse({
      type: "ctl.tool_result",
      sessionId: SESSION_ID,
      invocationId: INVOCATION_ID,
      ok: false,
      error: { code: "E_DENIED", message: "no", stack: "…" },
      ts: TS,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["error"]);
    }
  });
});

describe("correlation ids", () => {
  it("requires sessionId on every extension frame variant", () => {
    // The daemon's socket hub compares `frame.data.sessionId` against the
    // session the socket connected as, and drops the frame on mismatch. A
    // variant that omitted sessionId would compare `undefined !== boundSessionId`
    // and be dropped — or, worse, bypass the check if it were ever loosened.
    for (const frame of validExtensionFrames) {
      const without = omitKey(asRecord(frame), "sessionId");
      expect(extensionToDaemonFrameSchema.safeParse(without).success).toBe(false);
    }
  });

  it("requires a ULID sessionId, not an arbitrary string or a UUID", () => {
    for (const sessionId of [
      "",
      "session-1",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "01HQ8W7YV3ZQK9N6M4R2XJ0T5", // 25 chars
      "01HQ8W7YV3ZQK9N6M4R2XJ0T5CC", // 27 chars
      "01HQ8W7YV3ZQK9N6M4R2XJ0T5I", // I is not in Crockford base32
      42,
      null,
    ]) {
      const frame = { ...asRecord(validExtensionFrames[0]!), sessionId };
      expect(extensionToDaemonFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it("requires invocationId on ext.tool_call and ctl.tool_result", () => {
    // The extension keys its in-flight promise map by invocationId. A result
    // frame without one would look up `inflight.get(undefined)` and either
    // resolve nothing or, if the map were ever keyed loosely, resolve the
    // wrong caller's tool call.
    const call = omitKey(
      asRecord(validExtensionFrames.find((f) => f.type === "ext.tool_call")!),
      "invocationId",
    );
    expect(extensionToDaemonFrameSchema.safeParse(call).success).toBe(false);

    const result = omitKey(
      asRecord(validControlFrames.find((f) => f.type === "ctl.tool_result")!),
      "invocationId",
    );
    const parsed = daemonControlFrameSchema.safeParse(result);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "invocationId")).toBe(true);
    }
  });

  it("requires a ULID invocationId so results cannot be correlated by a guessable key", () => {
    for (const invocationId of ["1", "invocation-1", SESSION_ID.slice(0, 10), 1]) {
      expect(
        daemonControlFrameSchema.safeParse({
          type: "ctl.tool_result",
          sessionId: SESSION_ID,
          invocationId,
          ok: true,
          ts: TS,
        }).success,
      ).toBe(false);
    }
  });

  it("documents that ctl.ack.ref is an opaque string, not a ULID", () => {
    // Acks reference frame types as often as ids ("ext.hello"), so `ref` is
    // deliberately unconstrained beyond being a string. Recording the shape
    // here so a future tightening to ulidSchema is a conscious change.
    expect(daemonControlFrameSchema.safeParse({ type: "ctl.ack", ref: "ext.hello", ts: TS }).success).toBe(true);
    expect(daemonControlFrameSchema.safeParse({ type: "ctl.ack", ref: 7, ts: TS }).success).toBe(false);
    expect(daemonControlFrameSchema.safeParse({ type: "ctl.ack", ts: TS }).success).toBe(false);
  });

  it("documents that ctl.ack and ctl.shutdown carry no sessionId", () => {
    // These are connection-scoped, so routing comes from the socket, not the
    // frame. Adding a sessionId to one of them must be a deliberate schema
    // change, not something a peer can assert.
    expect(
      daemonControlFrameSchema.safeParse({
        type: "ctl.shutdown",
        reason: "restart",
        sessionId: SESSION_ID,
        ts: TS,
      }).success,
    ).toBe(false);
  });
});

describe("timestamps", () => {
  it("requires ts on every frame in both directions", () => {
    for (const frame of validExtensionFrames) {
      expect(extensionToDaemonFrameSchema.safeParse(omitKey(asRecord(frame), "ts")).success).toBe(
        false,
      );
    }
    for (const frame of validControlFrames) {
      expect(daemonControlFrameSchema.safeParse(omitKey(asRecord(frame), "ts")).success).toBe(false);
    }
  });

  it("requires a UTC ISO-8601 instant, refusing local time and numeric epochs", () => {
    // Frames from many sessions are interleaved into one ordered event log. A
    // naive local timestamp or an epoch number would sort against Z-stamped
    // frames incorrectly and reorder a session's turn history.
    for (const ts of [
      "2026-07-24T12:00:00", // no zone
      "2026-07-24T12:00:00+01:00", // offset, not UTC
      "2026-07-24 12:00:00Z", // space separator
      "2026-07-24", // date only
      "2026-13-24T12:00:00Z", // month 13
      1_753_358_400_000,
      "",
    ]) {
      const frame = { ...asRecord(validExtensionFrames[0]!), ts };
      expect(extensionToDaemonFrameSchema.safeParse(frame).success).toBe(false);
    }
    // Sub-second precision and whole seconds both remain valid.
    for (const ts of ["2026-07-24T12:00:00Z", "2026-07-24T12:00:00.123Z"]) {
      expect(
        extensionToDaemonFrameSchema.safeParse({ ...asRecord(validExtensionFrames[0]!), ts })
          .success,
      ).toBe(true);
    }
  });
});

describe("ext.hello", () => {
  it("refuses a role outside the cast, so an extension cannot self-promote", () => {
    // Role drives cast resolution and tool policy. An extension that could
    // announce itself as an unlisted or invented role would be classified by
    // whatever default the consumer applies.
    for (const role of ["captain", "admin", "root", "Builder", "", null]) {
      expect(
        extensionHelloFrameSchema.safeParse({
          type: "ext.hello",
          sessionId: SESSION_ID,
          role,
          piVersion: PI_PINNED_VERSION,
          extensionVersion: "0.1.0",
          ts: TS,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts every role the provider contract defines", () => {
    for (const role of [
      "brain",
      "planner",
      "builder",
      "validator",
      "fusion",
      "scout",
      "healthcheck",
    ]) {
      expect(
        extensionHelloFrameSchema.safeParse({
          type: "ext.hello",
          sessionId: SESSION_ID,
          role,
          piVersion: PI_PINNED_VERSION,
          extensionVersion: "0.1.0",
          ts: TS,
        }).success,
      ).toBe(true);
    }
  });

  it("documents that piVersion is a free string and is NOT pinned by the schema", () => {
    // Deliberate: hello reports what Pi actually is, including a drifted
    // version, so the daemon can detect and surface the mismatch. Pinning it
    // here would make a drifted extension invisible instead of reported.
    expect(
      extensionHelloFrameSchema.safeParse({
        type: "ext.hello",
        sessionId: SESSION_ID,
        role: "builder",
        piVersion: "99.0.0",
        extensionVersion: "0.1.0",
        ts: TS,
      }).success,
    ).toBe(true);
    // It still has to be a string — a null version would crash a comparison.
    expect(
      extensionHelloFrameSchema.safeParse({
        type: "ext.hello",
        sessionId: SESSION_ID,
        role: "builder",
        piVersion: null,
        extensionVersion: "0.1.0",
        ts: TS,
      }).success,
    ).toBe(false);
  });
});

describe("ext.lifecycle", () => {
  it("refuses phases outside the known lifecycle", () => {
    for (const phase of ["start", "turn", "session_started", "TURN_END", "", null]) {
      expect(
        extensionLifecycleFrameSchema.safeParse({
          type: "ext.lifecycle",
          sessionId: SESSION_ID,
          phase,
          detail: null,
          ts: TS,
        }).success,
      ).toBe(false);
    }
  });

  it("requires detail to be present-and-explicitly-null, not absent", () => {
    // `detail` is nullable but not optional. A sender that omits the key when
    // it has nothing to report gets a rejected frame, which is why the
    // extension always writes `detail: null`. This test pins that asymmetry.
    const withoutDetail = {
      type: "ext.lifecycle",
      sessionId: SESSION_ID,
      phase: "turn_end",
      ts: TS,
    };
    expect(extensionLifecycleFrameSchema.safeParse(withoutDetail).success).toBe(false);
    expect(
      extensionLifecycleFrameSchema.safeParse({ ...withoutDetail, detail: null }).success,
    ).toBe(true);
    // …and detail is text, never a structured object smuggled through.
    expect(
      extensionLifecycleFrameSchema.safeParse({ ...withoutDetail, detail: { tool: "bash" } })
        .success,
    ).toBe(false);
  });
});

describe("ext.usage", () => {
  const usage = (patch: Readonly<Record<string, unknown>>): unknown => ({
    type: "ext.usage",
    sessionId: SESSION_ID,
    provider: "anthropic",
    model: "claude-opus-4",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.5,
    contextUsedPct: 50,
    ...patch,
  });

  it("refuses negative or fractional token counts", () => {
    // These numbers accumulate into quota and spend. A negative count would
    // subtract from a session's usage; a fractional one would drift the total.
    for (const patch of [
      { inputTokens: -1 },
      { outputTokens: -1 },
      { inputTokens: 1.5 },
      { outputTokens: 0.1 },
      { inputTokens: Number.NaN },
      { inputTokens: "100" },
    ]) {
      expect(extensionUsageFrameSchema.safeParse(usage({ ...patch, ts: TS })).success).toBe(false);
    }
  });

  it("refuses negative cost and out-of-range context percentage", () => {
    for (const patch of [
      { costUsd: -0.01 },
      { contextUsedPct: -1 },
      { contextUsedPct: 100.1 },
      { contextUsedPct: 1000 },
    ]) {
      expect(extensionUsageFrameSchema.safeParse(usage({ ...patch, ts: TS })).success).toBe(false);
    }
    // The inclusive boundaries are legal: a context window can be exactly full.
    for (const contextUsedPct of [0, 100]) {
      expect(
        extensionUsageFrameSchema.safeParse(usage({ contextUsedPct, ts: TS })).success,
      ).toBe(true);
    }
  });

  it("accepts null for every unknown metric but not a missing key", () => {
    // "Unknown cost" must be reportable as null — the console renders that as
    // an em dash rather than $0.00 — but a sender cannot simply drop the field.
    expect(
      extensionUsageFrameSchema.safeParse(
        usage({ inputTokens: null, outputTokens: null, costUsd: null, contextUsedPct: null, ts: TS }),
      ).success,
    ).toBe(true);
    for (const key of ["inputTokens", "outputTokens", "costUsd", "contextUsedPct"]) {
      const frame = omitKey(usage({ ts: TS }) as Record<string, unknown>, key);
      expect(extensionUsageFrameSchema.safeParse(frame).success).toBe(false);
    }
  });
});

describe("ext.tool_blocked", () => {
  it("requires both toolName and reason as strings", () => {
    for (const patch of [
      { toolName: undefined },
      { reason: undefined },
      { toolName: 1 },
      { reason: { code: "policy" } },
    ]) {
      const base: Record<string, unknown> = {
        type: "ext.tool_blocked",
        sessionId: SESSION_ID,
        toolName: "spawn_crewmate",
        reason: "policy",
        ts: TS,
        ...patch,
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete base[key];
      }
      expect(extensionToolBlockedFrameSchema.safeParse(base).success).toBe(false);
    }
  });
});

describe("ext.tool_call", () => {
  const call = (input: unknown): unknown => ({
    type: "ext.tool_call",
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    tool: "ask_captain",
    input,
    ts: TS,
  });

  it("requires input to be a string-keyed object, refusing arrays and primitives", () => {
    // The daemon spreads `input` into a Brain tool handler's named arguments.
    // An array or a primitive here would reach that handler as a shape it
    // never checks for, and `input[0]`-style access is not what a tool schema
    // is written against.
    for (const input of [[], ["a"], null, "question", 3, true]) {
      expect(extensionToolCallFrameSchema.safeParse(call(input)).success).toBe(false);
    }
    expect(extensionToolCallFrameSchema.safeParse(call({})).success).toBe(true);
    expect(extensionToolCallFrameSchema.safeParse(call({ nested: { a: [1, null] } })).success).toBe(
      true,
    );
  });

  it("does not let a __proto__ key in input reach the tool dispatcher", () => {
    // JSON.parse gives `__proto__` as a real own property, and the daemon
    // forwards `input` onward. z.record drops it and leaves the prototype
    // alone; a swap to a passthrough object or a bare `z.unknown()` here would
    // silently regress that.
    const line = JSON.stringify({
      type: "ext.tool_call",
      sessionId: SESSION_ID,
      invocationId: INVOCATION_ID,
      tool: "ask_captain",
      input: { a: 1 },
      ts: TS,
    }).replace('"input":{"a":1}', '"input":{"__proto__":{"polluted":true},"a":1}');
    const raw: unknown = JSON.parse(line);
    const parsed = extensionToolCallFrameSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.prototype.hasOwnProperty.call(parsed.data.input, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf(parsed.data.input)).toBe(Object.prototype);
    }
    const probe: Record<string, unknown> = {};
    expect(probe["polluted"]).toBeUndefined();
  });

  it("requires a tool name", () => {
    const frame = omitKey(call({}) as Record<string, unknown>, "tool");
    expect(extensionToolCallFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("ext.question", () => {
  it("refuses an empty question and one past the 20k bound", () => {
    // The question is held in daemon memory keyed by questionId until the
    // Captain answers. Unbounded text from a looping agent is a memory bug;
    // an empty question is a prompt the Captain cannot act on.
    const question = (text: string): unknown => ({
      type: "ext.question",
      sessionId: SESSION_ID,
      questionId: INVOCATION_ID,
      question: text,
      ts: TS,
    });
    expect(extensionQuestionFrameSchema.safeParse(question("")).success).toBe(false);
    expect(extensionQuestionFrameSchema.safeParse(question("a")).success).toBe(true);
    expect(extensionQuestionFrameSchema.safeParse(question("a".repeat(20_000))).success).toBe(true);
    expect(extensionQuestionFrameSchema.safeParse(question("a".repeat(20_001))).success).toBe(false);
  });

  it("requires a ULID questionId so the answer routes back to one asker", () => {
    expect(
      extensionQuestionFrameSchema.safeParse({
        type: "ext.question",
        sessionId: SESSION_ID,
        questionId: "q1",
        question: "Which branch?",
        ts: TS,
      }).success,
    ).toBe(false);
  });
});

describe("ctl.tool_result", () => {
  const result = (patch: Readonly<Record<string, unknown>>): unknown => ({
    type: "ctl.tool_result",
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    ok: true,
    ts: TS,
    ...patch,
  });

  it("requires ok to be a real boolean, not a truthy value", () => {
    // The extension resolves the caller's promise with `ok` verbatim. A string
    // "false" is truthy and would report a failed tool call as a success.
    for (const ok of ["true", "false", 1, 0, null, undefined]) {
      const frame = result({ ok });
      expect(daemonControlFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it("treats data and error as independently optional", () => {
    // Documented shape, not an oversight: a successful call may carry no data
    // (a void tool), and an `ok: false` frame is allowed with no error object.
    // Consumers therefore must not assume `!ok` implies `error` is present.
    expect(daemonControlFrameSchema.safeParse(result({})).success).toBe(true);
    expect(daemonControlFrameSchema.safeParse(result({ ok: false })).success).toBe(true);
    expect(daemonControlFrameSchema.safeParse(result({ data: null })).success).toBe(true);
    expect(
      daemonControlFrameSchema.safeParse(result({ ok: false, error: { code: "E", message: "m" } }))
        .success,
    ).toBe(true);
  });

  it("requires both code and message when error is present", () => {
    for (const error of [{}, { code: "E" }, { message: "m" }, { code: 1, message: "m" }, "boom"]) {
      expect(daemonControlFrameSchema.safeParse(result({ ok: false, error })).success).toBe(false);
    }
  });

  it("preserves an explicit null data rather than collapsing it to absent", () => {
    // The extension distinguishes `data === undefined` (omit the key) from a
    // real null result. Losing that distinction changes what a tool returns.
    const parsed = daemonControlFrameSchema.safeParse(result({ data: null }));
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "ctl.tool_result") {
      expect("data" in parsed.data).toBe(true);
      expect(parsed.data.data).toBeNull();
    }
  });
});

describe("ctl.injectMessage", () => {
  it("requires a ULID sessionId and a string message", () => {
    // Injection puts text straight into a live agent's turn. Routing it with a
    // non-ULID id, or injecting a structured object, are both refused.
    for (const patch of [
      { sessionId: "not-a-ulid" },
      { sessionId: 1 },
      { message: 1 },
      { message: { text: "hi" } },
    ]) {
      expect(
        daemonControlFrameSchema.safeParse({
          type: "ctl.injectMessage",
          sessionId: SESSION_ID,
          message: "stand by",
          ts: TS,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
});

describe("NDJSON framing", () => {
  it("survives a round-trip and cannot be split into two frames by embedded newlines", () => {
    // Both peers split on "\n" before parsing. A reason string containing a
    // literal newline plus a forged frame must not become a second line — if
    // it did, an extension could make the daemon read a frame it never sent.
    const forged = JSON.stringify({ type: "ctl.shutdown", reason: "pwned", ts: TS });
    const frame: ExtensionToDaemonFrame = {
      type: "ext.tool_blocked",
      sessionId: SESSION_ID,
      toolName: "bash",
      reason: `blocked\n${forged}\n`,
      ts: TS,
    };
    const line = `${JSON.stringify(frame)}\n`;
    expect(line.split("\n").filter((part) => part.length > 0)).toHaveLength(1);

    const parsed = extensionToDaemonFrameSchema.safeParse(JSON.parse(line.trimEnd()));
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "ext.tool_blocked") {
      expect(parsed.data.reason).toBe(frame.reason);
    }
  });

  it("keeps every valid frame in both directions serializable without loss", () => {
    for (const frame of validExtensionFrames) {
      const round: unknown = JSON.parse(JSON.stringify(frame));
      const parsed = extensionToDaemonFrameSchema.safeParse(round);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(frame);
    }
    for (const frame of validControlFrames) {
      const round: unknown = JSON.parse(JSON.stringify(frame));
      const parsed = daemonControlFrameSchema.safeParse(round);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(frame);
    }
  });

  it("does not let a session claim a frame for a different session by mutation", () => {
    // The hub's guard is `frame.data.sessionId !== boundSessionId`. Both ids
    // are valid ULIDs, so the schema accepts the frame — the mismatch check is
    // the hub's job, and this pins that the schema does NOT do it for them.
    const frame = { ...asRecord(validExtensionFrames[0]!), sessionId: OTHER_SESSION_ID };
    expect(extensionToDaemonFrameSchema.safeParse(frame).success).toBe(true);
  });
});

describe("pi harness pin", () => {
  it("pins an exact version with no range operator", () => {
    // rest.ts embeds this as `z.literal(PI_PINNED_VERSION)` in the status and
    // connections responses. A caret or tilde would make the literal
    // "^0.82.0", which the daemon's own reported version can never equal, so
    // every status response would fail its own schema.
    expect(PI_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PI_PINNED_VERSION.startsWith("^")).toBe(false);
    expect(PI_PINNED_VERSION.startsWith("~")).toBe(false);
    expect(PI_PINNED_VERSION).not.toContain(" ");
    expect(PI_PINNED_VERSION).not.toMatch(/latest|\*|x/i);
  });

  it("prefers Pi-specific config-dir env vars over the shared XDG one", () => {
    // The candidates are tried in order. XDG_CONFIG_HOME is not Pi's — setting
    // it relocates the config dir of every XDG-aware tool the child process
    // spawns, so it must stay the last resort behind the Pi-specific names.
    const candidates = [...PI_CONFIG_DIR_ENV_CANDIDATES];
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.at(-1)).toBe("XDG_CONFIG_HOME");
    expect(candidates.indexOf("PI_CONFIG_DIR")).toBeLessThan(candidates.indexOf("XDG_CONFIG_HOME"));
    expect(candidates.indexOf("PI_HOME")).toBeLessThan(candidates.indexOf("XDG_CONFIG_HOME"));
    expect(candidates.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))).toBe(true);
  });
});

describe("piSpawnSpecSchema", () => {
  const spec = (patch: Readonly<Record<string, unknown>>): unknown => ({
    binary: "/usr/local/bin/pi",
    version: PI_PINNED_VERSION,
    managedHome: "/home/captain/.agent-os/pi",
    configDirEnv: "PI_CONFIG_DIR",
    args: ["--headless"],
    cwd: "/home/captain/project",
    envKeys: ["PI_CONFIG_DIR"],
    ...patch,
  });

  it("refuses argv as a shell string", () => {
    // The docstring promises argv is "never shell-joined". A string here would
    // be the exact shape a caller would hand to `sh -c`, which is how an
    // attacker-controlled cwd or flag becomes command injection.
    expect(piSpawnSpecSchema.safeParse(spec({ args: "--headless --print" })).success).toBe(false);
    expect(piSpawnSpecSchema.safeParse(spec({ args: ["--headless", 3] })).success).toBe(false);
    expect(piSpawnSpecSchema.safeParse(spec({ args: null })).success).toBe(false);
    // An empty argv is legitimate: `pi` with no flags.
    expect(piSpawnSpecSchema.safeParse(spec({ args: [] })).success).toBe(true);
  });

  it("refuses empty paths that would spawn or chdir into nothing", () => {
    for (const patch of [{ binary: "" }, { managedHome: "" }, { cwd: "" }, { version: "" }]) {
      expect(piSpawnSpecSchema.safeParse(spec(patch)).success).toBe(false);
    }
  });

  it("refuses an env map, so secret values cannot ride along in the spec", () => {
    // envKeys is a redacted manifest of key NAMES. The strict object means a
    // caller cannot attach the values next to them.
    const withEnv = piSpawnSpecSchema.safeParse(
      spec({ env: { ANTHROPIC_API_KEY: "sk-live-secret" } }),
    );
    expect(withEnv.success).toBe(false);
    if (!withEnv.success) {
      expect(withEnv.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
    expect(piSpawnSpecSchema.safeParse(spec({ envKeys: [{ ANTHROPIC_API_KEY: "sk" }] })).success).toBe(
      false,
    );
    expect(piSpawnSpecSchema.safeParse(spec({ envKeys: "PI_CONFIG_DIR" })).success).toBe(false);
  });

  it("allows a null configDirEnv but not an absent one", () => {
    // null means "no isolation available, sharing ~/.pi" — a state the daemon
    // must surface. Omitting the key would let that state be indistinguishable
    // from a spec that simply forgot to record it.
    expect(piSpawnSpecSchema.safeParse(spec({ configDirEnv: null })).success).toBe(true);
    expect(
      piSpawnSpecSchema.safeParse(omitKey(spec({}) as Record<string, unknown>, "configDirEnv"))
        .success,
    ).toBe(false);
  });

  it("documents that the spec does NOT enforce the pinned version", () => {
    // version records what was observed, drift included, so pin enforcement
    // lives in the caller. If that ever moves into the schema, this flips.
    expect(piSpawnSpecSchema.safeParse(spec({ version: "0.1.0-drifted" })).success).toBe(true);
  });
});

describe("piAuthBrokerModeSchema", () => {
  it("accepts only the three defined serialization modes", () => {
    // The mode decides whether two Pi logins may run at once. An unrecognized
    // value falling through to a permissive default would race two OAuth flows
    // against the same credential store.
    for (const mode of ["concurrent", "login-serialized", "strict-serial"]) {
      expect(piAuthBrokerModeSchema.safeParse(mode).success).toBe(true);
    }
    for (const mode of ["serial", "parallel", "none", "Concurrent", "", null, undefined, 0]) {
      expect(piAuthBrokerModeSchema.safeParse(mode).success).toBe(false);
    }
  });
});
