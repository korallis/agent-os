import { z } from "zod";

/**
 * Pi harness pin + managed-home contracts (master plan §2.1, §4.5, §4.7).
 * Exact pin — weekly canary may report newer, upgrades are deliberate.
 */

/** Exact pinned version of `@earendil-works/pi-coding-agent`. */
export const PI_PINNED_VERSION = "0.82.0";

/**
 * Env vars Pi may honor for relocating its config dir (R2-Q1 verification).
 * Agent OS tries these in order when spawning managed Pi processes.
 */
export const PI_CONFIG_DIR_ENV_CANDIDATES = [
  "PI_CONFIG_DIR",
  "PI_HOME",
  "XDG_CONFIG_HOME",
] as const;

export const piSpawnSpecSchema = z.strictObject({
  /** Absolute path to the `pi` binary. */
  binary: z.string().min(1),
  /** Exact version string expected (or observed). */
  version: z.string().min(1),
  /** Managed Pi home under AGENTOS_HOME/pi when isolation works. */
  managedHome: z.string().min(1),
  /** Env var name used for config-dir isolation, or null if shared ~/.pi. */
  configDirEnv: z.string().nullable(),
  /** Full argv after the binary (never shell-joined). */
  args: z.array(z.string()),
  cwd: z.string().min(1),
  /** Redacted env manifest keys (values never stored here). */
  envKeys: z.array(z.string()),
});
export type PiSpawnSpec = z.infer<typeof piSpawnSpecSchema>;

export const piAuthBrokerModeSchema = z.enum([
  "concurrent",
  "login-serialized",
  "strict-serial",
]);
export type PiAuthBrokerMode = z.infer<typeof piAuthBrokerModeSchema>;
