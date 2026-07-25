import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 */

export interface ReleaseManifest {
  version: string;
  /** sha256 of the release archive, hex. */
  sha256: string;
  /** Base64 detached signature over the sha256 hex string. */
  signature: string;
}

export type UpdateOutcome =
  | { ok: true; version: string; previousRetained: string }
  | { ok: false; reason: string; code: UpdateFailureCode };

export type UpdateFailureCode =
  | "DIGEST_MISMATCH"
  | "SIGNATURE_INVALID"
  | "NO_PUBLIC_KEY"
  | "APPLY_FAILED";

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

  /** sha256 of the payload, hex — the value the signature actually covers. */
  static digest(payload: Buffer): string {
    return createHash("sha256").update(payload).digest("hex");
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
        Buffer.from(manifest.sha256, "utf8"),
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
    try {
      const versionPath = join(this.versionsDir(), `${manifest.version}.tar`);
      writeFileSync(versionPath, payload, { mode: 0o600 });

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
    const archive = join(this.versionsDir(), `${previous}.tar`);
    if (!existsSync(archive)) {
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
    writeFileSync(join(this.versionsDir(), `${version}.tar`), payload, { mode: 0o600 });
    writeFileSync(this.currentPath(), `${version}\n`, { mode: 0o600 });
  }
}

/** Atomic-ish rename helper retained for packaging use. */
export function replaceFile(from: string, to: string): void {
  renameSync(from, to);
}
