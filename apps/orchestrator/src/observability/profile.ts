import type { ObservabilityConfig, OrchestratorEvent, WakeClass } from "@agent-os/protocol";

export type ObservabilityProfile = ObservabilityConfig["profiles"][string];

/**
 * Resolve the active visibility profile. Falls back to `quiet` (then any
 * shipped profile) so a mistyped activeProfile never leaves the daemon
 * without filtering rules.
 */
export function resolveActiveProfile(config: ObservabilityConfig): {
  name: string;
  profile: ObservabilityProfile;
} {
  const named = config.profiles[config.activeProfile];
  if (named !== undefined) {
    return { name: config.activeProfile, profile: named };
  }
  const quiet = config.profiles.quiet;
  if (quiet !== undefined) {
    return { name: "quiet", profile: quiet };
  }
  const first = Object.entries(config.profiles)[0];
  if (first === undefined) {
    return {
      name: "quiet",
      profile: {
        surface: [
          "task.",
          "captain.",
          "brain.down",
          "pipeline.unavailable",
          "pipeline.run_updated",
          "quota.",
        ],
        streamPipelineLogs: false,
        pipelineLogChars: 0,
        wakeOn: ["captain.escalation"],
      },
    };
  }
  return { name: first[0], profile: first[1] };
}

/**
 * Whether an event type is allowed onto the Console live (SSE) path under the
 * active profile's `surface` list. `"*"` is the explicit wildcard; every other
 * entry is a prefix match so `"task."` covers the family and `"brain.down"`
 * covers only that exact type (and any longer form that starts with it).
 */
export function eventMatchesSurface(eventType: string, surface: readonly string[]): boolean {
  for (const entry of surface) {
    if (entry === "*") return true;
    if (eventType.startsWith(entry)) return true;
  }
  return false;
}

/** Same prefix rules as surface — used for wakeOn. */
export function eventMatchesWakeOn(eventType: string, wakeOn: readonly string[]): boolean {
  return eventMatchesSurface(eventType, wakeOn);
}

/**
 * Map a wakeOn-matched event to a wake class, or null when the event must not
 * wake the Brain. Informational escalations are notices, not decisions —
 * under the quiet default they must not cost Brain tokens.
 */
export function wakeClassForEvent(event: OrchestratorEvent): WakeClass | null {
  switch (event.type) {
    case "pipeline.unavailable":
      return "GATE_FAILED";
    case "scout.write_violation":
      return "SECURITY";
    case "captain.escalation":
      if (event.payload.severity === "info") return null;
      return event.payload.severity === "critical" ? "BLOCKED" : "NEEDS_INPUT";
    default:
      return "STATUS";
  }
}
