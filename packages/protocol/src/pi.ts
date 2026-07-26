import { z } from "zod";

/**
 * Pi harness pin + managed-home contracts (master plan §2.1, §4.5, §4.7).
 *
 * The pin records the version Agent OS is **tested against**. It used to be
 * enforced by exact string equality, which made the product unusable the
 * moment Pi shipped a patch: with `0.82.0` pinned and `0.82.1` installed —
 * the state of the Captain's own machine — `versionMatchesPin` was false, the
 * `pi` doctor check went red, `requiredOk` went false, and onboarding pinned
 * itself at `step: "doctor"` forever. The product could not get past its own
 * first-run screen.
 *
 * An exact pin is only defensible if the product can install that exact
 * version, and it cannot: `piInstallHint()` prints a command and the wizard
 * never runs it. So the pin was a wall with no way over it.
 *
 * The compatibility rule is therefore: same MAJOR.MINOR, PATCH at or above the
 * pin. Patch releases of the harness cannot change the extension API the
 * substrate depends on (`pi.on`, `pi.registerTool`, `pi.sendMessage`,
 * `agent_settled`); a minor or major bump can, and still fails closed.
 */

/**
 * The Pi version Agent OS is tested against.
 *
 * Bump deliberately, together with a canary run. Use {@link piVersionSatisfiesPin}
 * to test an installed version — never `===`, which is what broke onboarding.
 */
export const PI_PINNED_VERSION = "0.82.0";

/** Parsed `major.minor.patch`, or null when the string is not a plain semver. */
function parsePiVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `installed` is compatible with {@link PI_PINNED_VERSION}: identical
 * major and minor, and a patch no older than the pin.
 *
 * Fails closed on anything unparseable — an unrecognised version string is not
 * evidence of compatibility, and this is the check that decides whether the
 * substrate will drive an unknown harness.
 */
export function piVersionSatisfiesPin(installed: string | null): boolean {
  if (installed === null) return false;
  const got = parsePiVersion(installed);
  const want = parsePiVersion(PI_PINNED_VERSION);
  if (got === null || want === null) return false;
  return got[0] === want[0] && got[1] === want[1] && got[2] >= want[2];
}

/** True when the installed version is compatible but not the exact tested pin. */
export function piVersionIsPatchDrift(installed: string | null): boolean {
  return (
    installed !== null &&
    installed !== PI_PINNED_VERSION &&
    piVersionSatisfiesPin(installed)
  );
}

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
