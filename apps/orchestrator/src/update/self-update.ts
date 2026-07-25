import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Signed self-update with rollback (master plan §11 Phase 8).
 *
 * Agent OS runs with the Captain's full permissions and holds their provider
 * credentials, so an unsigned update path would be the single worst hole in the
 * product. Three rules:
 *
 *   1. A release is applied ONLY if its detached signature verifies against a
 *      public key baked into the installed binary — never a key fetched with
 *      the release, which would let an attacker supply both halves.
 *   2. The previous version is retained before swapping, so a bad update is
 *      recoverable without network access.
 *   3. Verification failure is terminal for that release, not a warning that
 *      proceeds anyway.
 *
 * The signature covers the version label together with the payload digest so a
 * CDN/MITM cannot swap `version` independently of a legitimate payload. The
 * version is also validated as a path token and re-checked under versionsDir
 * before any write — defence in depth against path traversal.
 */

export interface ReleaseManifest {
  version: string;
  /** sha256 of the release archive, hex. */
  sha256: string;
  /**
   * Base64 detached signature over the canonical signed message
   * (`version + "\\n" + sha256`), not the digest alone.
   */
  signature: string;
}

export type UpdateOutcome =
  | { ok: true; version: string; previousRetained: string }
  | { ok: false; reason: string; code: UpdateFailureCode };

export type UpdateFailureCode =
  | "DIGEST_MISMATCH"
  | "SIGNATURE_INVALID"
  | "NO_PUBLIC_KEY"
  | "VERSION_UNSAFE"
  | "APPLY_FAILED";

/** Single path segment only: letters, digits, dot, underscore, hyphen. */
const SAFE_VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

export class SelfUpdater {
  constructor(
    private readonly root: string,
    /** PEM public key compiled into the install — never supplied by a release. */
    private readonly publicKeyPem: string | null,
  ) {}

  private versionsDir(): string {
    const dir = join(this.root, "versions");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private currentPath(): string {
    return join(this.root, "current");
  }

  private previousPath(): string {
    return join(this.root, "previous");
  }

  /** sha256 of the payload, hex. */
  static digest(payload: Buffer): string {
    return createHash("sha256").update(payload).digest("hex");
  }

  /**
   * Canonical bytes the release signature covers: version label + digest.
   * Swapping either field invalidates the signature.
   */
  static signedMessage(version: string, sha256: string): Buffer {
    return Buffer.from(`${version}\n${sha256}`, "utf8");
  }

  /**
   * True when `version` is a single safe filesystem token (no separators,
   * no `..`, no absolute paths). Independent of signature verification.
   */
  static isSafeVersionToken(version: string): boolean {
    if (version.length === 0 || version.length > 128) return false;
    if (version === "." || version === "..") return false;
    if (version.includes("/") || version.includes("\\") || version.includes("\0")) return false;
    if (version.includes("..")) return false;
    return SAFE_VERSION_TOKEN.test(version);
  }

  /**
   * Resolve `${versionsDir}/${version}.tar` and assert it stays under versionsDir.
   * Callers must use the returned path for writes — never re-join unchecked.
   */
  static resolveVersionArchive(
    versionsDir: string,
    version: string,
  ): { ok: true; path: string } | { ok: false; code: "VERSION_UNSAFE"; reason: string } {
    if (!SelfUpdater.isSafeVersionToken(version)) {
      return {
        ok: false,
        code: "VERSION_UNSAFE",
        reason: `version ${JSON.stringify(version)} is not a safe path token`,
      };
    }
    const versionsRoot = resolve(versionsDir);
    const target = resolve(versionsRoot, `${version}.tar`);
    const prefix = versionsRoot.endsWith(sep) ? versionsRoot : `${versionsRoot}${sep}`;
    if (!target.startsWith(prefix)) {
      return {
        ok: false,
        code: "VERSION_UNSAFE",
        reason: `version path escapes versions directory`,
      };
    }
    return { ok: true, path: target };
  }

  /**
   * Verify a release without applying it. Split out so the check is testable on
   * its own and cannot be accidentally skipped by a caller.
   */
  verify(manifest: ReleaseManifest, payload: Buffer): { ok: true } | { ok: false; code: UpdateFailureCode; reason: string } {
    if (this.publicKeyPem === null || this.publicKeyPem.length === 0) {
      return {
        ok: false,
        code: "NO_PUBLIC_KEY",
        reason: "no update public key is compiled into this install — refusing to self-update",
      };
    }
    // Path safety is independent of crypto: refuse traversal tokens before we
    // even look at the signature, so a bypassed verify cannot write them later.
    if (!SelfUpdater.isSafeVersionToken(manifest.version)) {
      return {
        ok: false,
        code: "VERSION_UNSAFE",
        reason: `version ${JSON.stringify(manifest.version)} is not a safe path token`,
      };
    }
    const actual = SelfUpdater.digest(payload);
    if (actual !== manifest.sha256) {
      return {
        ok: false,
        code: "DIGEST_MISMATCH",
        reason: `release digest ${actual} does not match manifest ${manifest.sha256}`,
      };
    }
    try {
      // Ed25519 signs in one shot with a null algorithm — createVerify()'s
      // streaming interface rejects Ed25519 keys outright.
      const key = createPublicKey(this.publicKeyPem);
      const valid = verifySignature(
        null,
        SelfUpdater.signedMessage(manifest.version, manifest.sha256),
        key,
        Buffer.from(manifest.signature, "base64"),
      );
      if (!valid) {
        return {
          ok: false,
          code: "SIGNATURE_INVALID",
          reason: "release signature did not verify against the installed public key",
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: "SIGNATURE_INVALID",
        reason: error instanceof Error ? error.message : "signature verification failed",
      };
    }
    return { ok: true };
  }

  /**
   * Apply a verified release, retaining the current version for rollback.
   * Refuses outright when verification fails — never "warn and continue".
   */
  apply(manifest: ReleaseManifest, payload: Buffer): UpdateOutcome {
    const verified = this.verify(manifest, payload);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason, code: verified.code };
    }
    // Defence in depth: re-resolve and assert containment even after verify,
    // so a future ordering mistake cannot write outside the update root.
    const archive = SelfUpdater.resolveVersionArchive(this.versionsDir(), manifest.version);
    if (!archive.ok) {
      return { ok: false, reason: archive.reason, code: archive.code };
    }
    try {
      writeFileSync(archive.path, payload, { mode: 0o600 });

      // Retain the outgoing version BEFORE swapping, so rollback never depends
      // on the network or on the release we are about to trust.
      let retained = "none";
      if (existsSync(this.currentPath())) {
        retained = readFileSync(this.currentPath(), "utf8").trim();
        writeFileSync(this.previousPath(), retained, { mode: 0o600 });
      }
      writeFileSync(this.currentPath(), `${manifest.version}\n`, { mode: 0o600 });
      return { ok: true, version: manifest.version, previousRetained: retained };
    } catch (error) {
      return {
        ok: false,
        code: "APPLY_FAILED",
        reason: error instanceof Error ? error.message : "apply failed",
      };
    }
  }

  currentVersion(): string | null {
    if (!existsSync(this.currentPath())) return null;
    const value = readFileSync(this.currentPath(), "utf8").trim();
    return value.length > 0 ? value : null;
  }

  previousVersion(): string | null {
    if (!existsSync(this.previousPath())) return null;
    const value = readFileSync(this.previousPath(), "utf8").trim();
    return value.length > 0 ? value : null;
  }

  /** Roll back to the retained version. Fails loudly when there is none. */
  rollback(): { ok: boolean; version: string | null; reason: string | null } {
    const previous = this.previousVersion();
    if (previous === null) {
      return { ok: false, version: null, reason: "no retained previous version to roll back to" };
    }
    const archive = SelfUpdater.resolveVersionArchive(this.versionsDir(), previous);
    if (!archive.ok || !existsSync(archive.path)) {
      return {
        ok: false,
        version: previous,
        reason: `retained version ${previous} is recorded but its archive is missing`,
      };
    }
    const current = this.currentVersion();
    writeFileSync(this.currentPath(), `${previous}\n`, { mode: 0o600 });
    if (current !== null) {
      // The rolled-back-from version becomes the new rollback target, so a
      // Captain can bounce between the two without a network round trip.
      writeFileSync(this.previousPath(), `${current}\n`, { mode: 0o600 });
    } else {
      rmSync(this.previousPath(), { force: true });
    }
    return { ok: true, version: previous, reason: null };
  }

  /** Test/packaging helper: stage an initial version without a signature. */
  seedCurrent(version: string, payload: Buffer): void {
    const archive = SelfUpdater.resolveVersionArchive(this.versionsDir(), version);
    if (!archive.ok) {
      throw new Error(archive.reason);
    }
    writeFileSync(archive.path, payload, { mode: 0o600 });
    writeFileSync(this.currentPath(), `${version}\n`, { mode: 0o600 });
  }
}

/** Atomic-ish rename helper retained for packaging use. */
export function replaceFile(from: string, to: string): void {
  renameSync(from, to);
}
