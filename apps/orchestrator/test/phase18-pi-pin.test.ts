import { describe, expect, it } from "vitest";
import {
  PI_PINNED_VERSION,
  piVersionIsPatchDrift,
  piVersionSatisfiesPin,
} from "@agent-os/protocol";

/**
 * Lives in the orchestrator package because that is where vitest is already
 * wired; the subject under test is @agent-os/protocol.
 *
 * Regression guard for the defect that made Agent OS unusable on the Captain's
 * own machine.
 *
 * The pin was enforced with `version === PI_PINNED_VERSION`. With `0.82.0`
 * pinned and `0.82.1` installed — which is what `pi --version` reported — the
 * `pi` doctor check went red, `requiredOk` went false, and onboarding pinned
 * itself at `step: "doctor"` with no way forward. The product could not get
 * past its own first-run screen, and nothing caught it: the existing gate only
 * asserted the constant equalled itself, so a drifted install could never turn
 * it red.
 *
 * The first test below fails against exact-equality enforcement. That is the
 * point of it.
 */

describe("Pi version pin", () => {
  it("accepts the exact pinned version", () => {
    expect(piVersionSatisfiesPin(PI_PINNED_VERSION)).toBe(true);
  });

  it("accepts a newer PATCH — the case that wedged onboarding", () => {
    // 0.82.0 pinned, 0.82.1 installed. Under `===` this was false and the
    // wizard could never advance.
    expect(piVersionSatisfiesPin("0.82.1")).toBe(true);
    expect(piVersionSatisfiesPin("0.82.99")).toBe(true);
  });

  it("reports a compatible-but-different patch as drift, so the UI can say so", () => {
    expect(piVersionIsPatchDrift("0.82.1")).toBe(true);
    // The exact tested version is not drift.
    expect(piVersionIsPatchDrift(PI_PINNED_VERSION)).toBe(false);
    // Neither is something that does not satisfy the pin at all.
    expect(piVersionIsPatchDrift("0.83.0")).toBe(false);
  });

  it("rejects an OLDER patch than the pin", () => {
    // Downgrades are not compatible: the pin records the minimum tested build.
    expect(piVersionSatisfiesPin("0.81.9")).toBe(false);
  });

  it("rejects a different MINOR or MAJOR — those can move the extension API", () => {
    // The substrate depends on pi.on / pi.registerTool / pi.sendMessage and
    // agent_settled. A patch cannot move those; a minor or major can, so the
    // check must still fail closed there.
    expect(piVersionSatisfiesPin("0.83.0")).toBe(false);
    expect(piVersionSatisfiesPin("0.81.0")).toBe(false);
    expect(piVersionSatisfiesPin("1.82.0")).toBe(false);
  });

  it("fails closed on absent or unparseable versions", () => {
    // An unrecognised version string is not evidence of compatibility, and
    // this check decides whether the substrate drives an unknown harness.
    expect(piVersionSatisfiesPin(null)).toBe(false);
    expect(piVersionSatisfiesPin("")).toBe(false);
    expect(piVersionSatisfiesPin("not-a-version")).toBe(false);
    expect(piVersionSatisfiesPin("0.82")).toBe(false);
    expect(piVersionSatisfiesPin("v0.82.0")).toBe(false);
  });

  it("tolerates prerelease and build suffixes on an otherwise compatible patch", () => {
    expect(piVersionSatisfiesPin("0.82.1-rc.1")).toBe(true);
    expect(piVersionSatisfiesPin("0.82.1+build.7")).toBe(true);
  });
});
