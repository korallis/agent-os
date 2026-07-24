import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import {
  onboardingStateSchema,
  PI_PINNED_VERSION,
  type DoctorCheck,
  type OnboardingState,
  type OnboardingStep,
  type OrchestratorEvent,
  type PiProviderId,
  type ClaudeBillingMode,
} from "@agent-os/protocol";
import { detectPi, installHintForPi, listDetectedProviders } from "../pi/manager.js";
import { assertNoAmbientAnthropicKey, EnvHygieneError } from "../security/env-scrub.js";
import { spawnSync } from "node:child_process";

/**
 * Resumable onboarding wizard state (master plan §4.10).
 * Persisted to ~/.agentos/onboarding.json5.
 */

function emptyState(): OnboardingState {
  const now = new Date().toISOString();
  return {
    version: 1,
    step: "doctor",
    doctor: [],
    providers: [],
    completedAt: null,
    updatedAt: now,
  };
}

export class OnboardingService {
  private state: OnboardingState;
  private sink: (event: OrchestratorEvent) => void = () => undefined;

  constructor(private readonly home: string) {
    this.state = this.load();
  }

  onEvent(sink: (event: OrchestratorEvent) => void): void {
    this.sink = sink;
  }

  getState(): OnboardingState {
    return this.state;
  }

  private path(): string {
    return join(this.home, "onboarding.json5");
  }

  private load(): OnboardingState {
    const path = this.path();
    if (!existsSync(path)) return emptyState();
    try {
      const raw = JSON5.parse(readFileSync(path, "utf8"));
      const parsed = onboardingStateSchema.safeParse(raw);
      return parsed.success ? parsed.data : emptyState();
    } catch {
      return emptyState();
    }
  }

  private save(previous: OnboardingStep | null = null): void {
    this.state = { ...this.state, updatedAt: new Date().toISOString() };
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(), JSON5.stringify(this.state, null, 2), { mode: 0o600 });
    if (previous !== null && previous !== this.state.step) {
      this.sink({
        type: "onboarding.step",
        payload: { step: this.state.step, previous },
      });
    }
  }

  refreshDoctor(): OnboardingState {
    const previous = this.state.step;
    const pi = detectPi(this.home);
    const doctor: DoctorCheck[] = [
      checkTool("node", process.version.replace(/^v/, ""), ">=24", null),
      {
        id: "pi",
        ok: pi.binary !== null && pi.versionMatchesPin,
        version: pi.version,
        required: PI_PINNED_VERSION,
        detail:
          pi.binary === null
            ? "Pi not installed"
            : pi.versionMatchesPin
              ? "pinned version present"
              : `found ${pi.version ?? "unknown"}, want ${PI_PINNED_VERSION}`,
        installHint: installHintForPi(),
      },
      whichCheck("tmux", "tmux", "3.3+"),
      whichCheck("git", "git", "2.40+"),
      whichCheck("uv", "uv", null),
      whichCheck("gh", "gh", null),
    ];
    this.state = { ...this.state, doctor, step: "doctor" };
    // Advance when all required pass (gh is optional warning).
    const requiredOk = doctor.filter((d) => d.id !== "gh").every((d) => d.ok);
    if (requiredOk) {
      this.state = { ...this.state, step: this.state.providers.some((p) => p.selected) ? this.state.step : "providers" };
      if (this.state.step === "doctor") this.state = { ...this.state, step: "providers" };
    }
    this.save(previous);
    return this.state;
  }

  setProviders(providers: PiProviderId[]): OnboardingState {
    const previous = this.state.step;
    const detected = new Set(listDetectedProviders(this.home).map((p) => p.provider));
    const all: PiProviderId[] = [
      "anthropic",
      "openai",
      "xai",
      "openrouter",
      "github-copilot",
      "kimi-coding",
      "vercel-ai-gateway",
    ];
    const selected = new Set(providers);
    this.state = {
      ...this.state,
      step: "providers",
      providers: all.map((provider) => {
        const existing = this.state.providers.find((p) => p.provider === provider);
        return {
          provider,
          selected: selected.has(provider),
          detected: detected.has(provider),
          authVerified: existing?.authVerified ?? detected.has(provider),
          claudeBillingMode: existing?.claudeBillingMode ?? null,
          claudeSdk: existing?.claudeSdk ?? null,
        };
      }),
    };
    this.state = { ...this.state, step: "auth" };
    this.save(previous);
    return this.state;
  }

  verifyAuth(provider: PiProviderId): OnboardingState {
    const previous = this.state.step;
    const detected = new Set(listDetectedProviders(this.home).map((p) => p.provider));
    this.state = {
      ...this.state,
      providers: this.state.providers.map((p) =>
        p.provider === provider
          ? { ...p, authVerified: detected.has(provider) || p.authVerified, detected: detected.has(provider) }
          : p,
      ),
    };
    const claude = this.state.providers.find((p) => p.provider === "anthropic" && p.selected);
    if (claude?.selected === true) {
      this.state = { ...this.state, step: "claude-billing" };
    } else if (this.state.providers.filter((p) => p.selected).every((p) => p.authVerified)) {
      this.state = { ...this.state, step: "probes" };
    }
    this.save(previous);
    return this.state;
  }

  /**
   * Advance to probes step after auto-enabling selected+verified providers (R5.1).
   */
  enableProbes(): OnboardingState {
    const previous = this.state.step;
    this.state = { ...this.state, step: "probes" };
    this.save(previous);
    return this.state;
  }

  setClaudeBilling(mode: ClaudeBillingMode): OnboardingState {
    const previous = this.state.step;
    this.state = {
      ...this.state,
      step: "claude-billing",
      providers: this.state.providers.map((p) =>
        p.provider === "anthropic"
          ? {
              ...p,
              claudeBillingMode: mode,
              claudeSdk:
                mode === "subscription-sdk"
                  ? (p.claudeSdk ?? {
                      claudeCodeLogin: false,
                      sdkInstalled: false,
                      noAmbientApiKey: false,
                      isolationDefaults: false,
                      catalogHealthcheck: false,
                    })
                  : null,
            }
          : p,
      ),
    };
    this.save(previous);
    return this.state;
  }

  /**
   * Verify Claude SDK subscription path. Blocks completion until all sub-steps pass.
   */
  verifyClaudeSdk(fixture?: {
    claudeCodeLogin?: boolean;
    sdkInstalled?: boolean;
    catalogHealthcheck?: boolean;
  }): OnboardingState {
    const previous = this.state.step;
    let noAmbientApiKey = true;
    try {
      assertNoAmbientAnthropicKey();
    } catch (error) {
      if (error instanceof EnvHygieneError) noAmbientApiKey = false;
    }

    // In CI/fixtures, allow injecting verification results.
    const claudeCodeLogin = fixture?.claudeCodeLogin ?? existsSync(join(process.env.HOME ?? "", ".claude"));
    const sdkInstalled = fixture?.sdkInstalled ?? false;
    const catalogHealthcheck = fixture?.catalogHealthcheck ?? sdkInstalled;
    const isolationDefaults = true;

    this.state = {
      ...this.state,
      providers: this.state.providers.map((p) => {
        if (p.provider !== "anthropic" || p.claudeBillingMode !== "subscription-sdk") return p;
        return {
          ...p,
          claudeSdk: {
            claudeCodeLogin,
            sdkInstalled,
            noAmbientApiKey,
            isolationDefaults,
            catalogHealthcheck,
          },
          authVerified:
            claudeCodeLogin && sdkInstalled && noAmbientApiKey && isolationDefaults && catalogHealthcheck,
        };
      }),
    };

    const claude = this.state.providers.find((p) => p.provider === "anthropic");
    const sdk = claude?.claudeSdk;
    if (
      sdk &&
      sdk.claudeCodeLogin &&
      sdk.sdkInstalled &&
      sdk.noAmbientApiKey &&
      sdk.isolationDefaults &&
      sdk.catalogHealthcheck
    ) {
      this.state = { ...this.state, step: "probes" };
    }
    this.save(previous);
    return this.state;
  }

  complete(): OnboardingState {
    const previous = this.state.step;
    const claude = this.state.providers.find(
      (p) => p.provider === "anthropic" && p.selected && p.claudeBillingMode === "subscription-sdk",
    );
    if (claude !== undefined) {
      const sdk = claude.claudeSdk;
      if (
        sdk === null ||
        !sdk.claudeCodeLogin ||
        !sdk.sdkInstalled ||
        !sdk.noAmbientApiKey ||
        !sdk.isolationDefaults ||
        !sdk.catalogHealthcheck
      ) {
        throw new OnboardingBlockedError(
          "Claude subscription-sdk path incomplete — catalog + healthcheck required",
        );
      }
    }
    const now = new Date().toISOString();
    this.state = { ...this.state, step: "complete", completedAt: now };
    this.save(previous);
    this.sink({ type: "onboarding.completed", payload: { at: now } });
    return this.state;
  }

  restart(): OnboardingState {
    const previous = this.state.step;
    this.state = emptyState();
    this.save(previous);
    return this.refreshDoctor();
  }
}

export class OnboardingBlockedError extends Error {
  readonly code = "ONBOARDING_BLOCKED" as const;
  constructor(message: string) {
    super(message);
    this.name = "OnboardingBlockedError";
  }
}

function whichCheck(id: DoctorCheck["id"], bin: string, required: string | null): DoctorCheck {
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  let version: string | null = null;
  if (result.status === 0) {
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    const text = `${v.stdout} ${v.stderr}`.trim();
    const match = text.match(/(\d+\.\d+(\.\d+)?)/);
    version = match?.[1] ?? null;
  }
  const present = result.status === 0;
  const ok =
    present &&
    (required === null || (version !== null && satisfiesVersionConstraint(version, required)));
  return {
    id,
    ok,
    version,
    required,
    detail: !present
      ? `${bin} not found`
      : ok
        ? "found"
        : `need ${required}, found ${version ?? "unknown"}`,
    installHint: ok
      ? null
      : bin === "uv"
        ? "curl -LsSf https://astral.sh/uv/install.sh | sh"
        : bin === "tmux"
          ? "brew install tmux"
          : `install ${bin}`,
  };
}

function checkTool(
  id: DoctorCheck["id"],
  version: string,
  required: string,
  installHint: string | null,
): DoctorCheck {
  const ok = satisfiesVersionConstraint(version, required);
  return {
    id,
    ok,
    version,
    required,
    detail: ok ? "runtime" : `need ${required}, found ${version}`,
    installHint: ok ? installHint : (installHint ?? `install ${id} ${required}`),
  };
}

/**
 * Evaluate version constraints: ">=24", ">24", "3.3+", "2.40+", or major-only exact.
 */
function satisfiesVersionConstraint(version: string, required: string): boolean {
  const cleaned = version.replace(/^v/i, "").trim();
  const versionParts = parseVersionParts(cleaned);
  if (versionParts === null) return false;

  const plus = required.match(/^(\d+(?:\.\d+)*)\+$/);
  if (plus !== null) {
    const minParts = parseVersionParts(plus[1] ?? "");
    if (minParts === null) return false;
    return compareVersionParts(versionParts, minParts) >= 0;
  }

  const ge = required.match(/^>=\s*(\d+(?:\.\d+)*)/);
  if (ge !== null) {
    const minParts = parseVersionParts(ge[1] ?? "");
    if (minParts === null) return false;
    return compareVersionParts(versionParts, minParts) >= 0;
  }
  const gt = required.match(/^>\s*(\d+(?:\.\d+)*)/);
  if (gt !== null) {
    const minParts = parseVersionParts(gt[1] ?? "");
    if (minParts === null) return false;
    return compareVersionParts(versionParts, minParts) > 0;
  }
  const exact = required.match(/^(\d+(?:\.\d+)*)$/);
  if (exact !== null) {
    const want = parseVersionParts(exact[1] ?? "");
    if (want === null) return false;
    return compareVersionParts(versionParts, want) === 0;
  }
  return true;
}

function parseVersionParts(version: string): number[] | null {
  const parts = version
    .split(".")
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
  return parts.length > 0 ? parts : null;
}

function compareVersionParts(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}
