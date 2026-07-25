import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PI_CONFIG_DIR_ENV_CANDIDATES, PI_PINNED_VERSION, } from "@agent-os/protocol";
import { readAuthStorePresenceUnion } from "../security/auth-store.js";
import { scrubEnv } from "../security/env-scrub.js";
export function managedPiHome(agentosHome) {
    return join(agentosHome, "pi");
}
/** Locate `pi` on PATH (or PI_BINARY override). */
export function findPiBinary() {
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
        if (existsSync(path))
            return path;
    }
    return null;
}
export function detectPiVersion(binary) {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0)
        return null;
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
export function detectConfigDirEnv() {
    // Prefer PI_CONFIG_DIR when present in the environment of a real Pi that
    // documents it; otherwise leave null (shared ~/.pi with broker serialization).
    for (const name of PI_CONFIG_DIR_ENV_CANDIDATES) {
        if (name === "XDG_CONFIG_HOME")
            continue; // too broad to claim isolation
        // Convention accepted when the var is set on the host or we opt in via AGENTOS_PI_CONFIG_DIR_ENV.
        if (process.env.AGENTOS_PI_CONFIG_DIR_ENV === name)
            return name;
        if (process.env[name] !== undefined)
            return name;
    }
    // Default: use PI_CONFIG_DIR for managed isolation; Phase 2 verification gate
    // records whether the installed Pi honors it.
    return "PI_CONFIG_DIR";
}
export function detectPi(agentosHome) {
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
/**
 * Builds a PiSpawnSpec. Never uses shell. Records absolute binary path.
 */
export function buildPiSpawnSpec(options) {
    if (options.detection.binary === null) {
        throw new Error("Pi binary not found — run onboarding / install pinned Pi");
    }
    const extraAllow = {
        AGENTOS_SESSION_ID: options.sessionId,
        AGENTOS_SOCKET: options.socketPath,
        AGENTOS_ROLE: options.role,
    };
    // AGENTOS_HOME: Brain (layout) + every non-Brain seat (default-deny fence root).
    // The signing key is never placed in env — only the home path for path compare.
    if (options.role === "brain" ||
        options.role === "validator" ||
        options.role === "builder") {
        extraAllow.AGENTOS_HOME = options.agentosHome;
    }
    if ((options.role === "builder" || options.role === "validator") &&
        options.gateWorkspace !== undefined) {
        extraAllow.AGENTOS_GATE_WORKSPACE = options.gateWorkspace;
    }
    if ((options.role === "builder" || options.role === "validator") &&
        options.seatWorkspace !== undefined) {
        extraAllow.AGENTOS_SEAT_WORKSPACE = options.seatWorkspace;
    }
    if (options.sessionDir !== undefined) {
        // Extension captures side output under AGENTOS_SESSION_DIR/outputs/.
        extraAllow.AGENTOS_SESSION_DIR = options.sessionDir;
        // Pi's native session store (docs/environment-variables.md); pairs with --session-dir.
        extraAllow.PI_CODING_AGENT_SESSION_DIR = options.sessionDir;
    }
    if (options.detection.configDirEnv !== null) {
        extraAllow[options.detection.configDirEnv] = options.detection.managedHome;
    }
    const scrubbed = scrubEnv(process.env, {
        grantProviderKey: options.grantProviderKey ?? null,
        extraAllow,
        assertSingle: true,
    });
    const args = [];
    if (options.sessionDir !== undefined) {
        // Pi session storage precedence: --session-dir, then PI_CODING_AGENT_SESSION_DIR.
        args.push("--session-dir", options.sessionDir);
    }
    if (options.thinking !== undefined && options.thinking.length > 0) {
        args.push("--thinking", options.thinking);
    }
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
export function listDetectedProviders(agentosHome) {
    const configDirEnv = detectConfigDirEnv();
    const managedHome = configDirEnv !== null ? managedPiHome(agentosHome) : null;
    return readAuthStorePresenceUnion(managedHome);
}
export function installHintForPi() {
    return `npm i -g @earendil-works/pi-coding-agent@${PI_PINNED_VERSION}`;
}
