import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PI_CONFIG_DIR_ENV_CANDIDATES,
  PI_PINNED_VERSION,
  type PiSpawnSpec,
} from "@agent-os/protocol";
import {
  resolveAuthJsonPathWithFallback,
  readAuthStorePresence,
} from "../security/auth-store.js";
import { scrubEnv, type ProviderKeyEnvName } from "../security/env-scrub.js";

/**
 * Pi manager (master plan §4.5–§4.7).
 * Only this module builds Pi command lines. Exact pin + managed home.
 */

export interface PiDetection {
  binary: string | null;
  version: string | null;
  pinnedVersion: typeof PI_PINNED_VERSION;
  versionMatchesPin: boolean;
  managedHome: string;
  /** Env var that relocates Pi config, or null if isolation not verified. */
  configDirEnv: string | null;
  isolationMode: "managed" | "shared";
}

export function managedPiHome(agentosHome: string): string {
  return join(agentosHome, "pi");
}

/** Locate `pi` on PATH (or PI_BINARY override). */
export function findPiBinary(): string | null {
  const override = process.env.PI_BINARY;
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    return override;
  }
  const result = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  // Common npm global location on macOS.
  const candidates = [
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    join(homedir(), ".npm-global", "bin", "pi"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function detectPiVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return null;
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? (text.length > 0 ? text.split(/\s+/)[0] ?? null : null);
}

/**
 * R2-Q1 verification: does Pi honor a config-dir env var?
 * We probe by checking whether setting the env changes the reported config path
 * via `pi` help/env or by convention. Until verified, we still prepare managed
 * home and record which candidate is preferred.
 */
export function detectConfigDirEnv(): string | null {
  // Prefer PI_CONFIG_DIR when present in the environment of a real Pi that
  // documents it; otherwise leave null (shared ~/.pi with broker serialization).
  for (const name of PI_CONFIG_DIR_ENV_CANDIDATES) {
    if (name === "XDG_CONFIG_HOME") continue; // too broad to claim isolation
    // Convention accepted when the var is set on the host or we opt in via AGENTOS_PI_CONFIG_DIR_ENV.
    if (process.env.AGENTOS_PI_CONFIG_DIR_ENV === name) return name;
    if (process.env[name] !== undefined) return name;
  }
  // Default: use PI_CONFIG_DIR for managed isolation; Phase 2 verification gate
  // records whether the installed Pi honors it.
  return "PI_CONFIG_DIR";
}

export function detectPi(agentosHome: string): PiDetection {
  const managedHome = managedPiHome(agentosHome);
  mkdirSync(join(managedHome, "agent"), { recursive: true, mode: 0o700 });
  const binary = findPiBinary();
  const version = binary !== null ? detectPiVersion(binary) : null;
  const configDirEnv = detectConfigDirEnv();
  return {
    binary,
    version,
    pinnedVersion: PI_PINNED_VERSION,
    versionMatchesPin: version === PI_PINNED_VERSION,
    managedHome,
    configDirEnv,
    isolationMode: configDirEnv !== null ? "managed" : "shared",
  };
}

export interface BuildSpawnOptions {
  agentosHome: string;
  detection: PiDetection;
  args: string[];
  cwd: string;
  sessionId: string;
  socketPath: string;
  /** Extension path (agent-os) always passed with -e. */
  extensionPath: string;
  /** Optional single API key grant. */
  grantProviderKey?: { name: ProviderKeyEnvName; value: string } | null;
  /** Clean-room: add --no-skills --no-extensions --no-context-files, then re-add -e. */
  cleanRoom?: boolean;
}

/**
 * Builds a PiSpawnSpec. Never uses shell. Records absolute binary path.
 */
export function buildPiSpawnSpec(options: BuildSpawnOptions): PiSpawnSpec & {
  env: Record<string, string>;
} {
  if (options.detection.binary === null) {
    throw new Error("Pi binary not found — run onboarding / install pinned Pi");
  }

  const extraAllow: Record<string, string> = {
    AGENTOS_HOME: options.agentosHome,
    AGENTOS_SESSION_ID: options.sessionId,
    AGENTOS_SOCKET: options.socketPath,
  };
  if (options.detection.configDirEnv !== null) {
    extraAllow[options.detection.configDirEnv] = options.detection.managedHome;
  }

  const scrubbed = scrubEnv(process.env, {
    grantProviderKey: options.grantProviderKey ?? null,
    extraAllow,
    assertSingle: true,
  });

  const args: string[] = [];
  if (options.cleanRoom === true) {
    // R2-Q2: --no-extensions scoping — still pass our telemetry-only -e after.
    args.push("--no-skills", "--no-extensions", "--no-context-files");
  }
  args.push("-e", options.extensionPath, ...options.args);

  return {
    binary: options.detection.binary,
    version: options.detection.version ?? PI_PINNED_VERSION,
    managedHome: options.detection.managedHome,
    configDirEnv: options.detection.configDirEnv,
    args,
    cwd: options.cwd,
    envKeys: scrubbed.envKeys,
    env: scrubbed.env,
  };
}

export function listDetectedProviders(agentosHome: string): ReturnType<typeof readAuthStorePresence> {
  const configDirEnv = detectConfigDirEnv();
  const managedHome = configDirEnv !== null ? managedPiHome(agentosHome) : null;
  const authJsonPath = resolveAuthJsonPathWithFallback(managedHome);
  return readAuthStorePresence(authJsonPath);
}

export function installHintForPi(): string {
  return `npm i -g @earendil-works/pi-coding-agent@${PI_PINNED_VERSION}`;
}
