import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { interpolateTemplate } from "@agent-os/fusion-core";
import type { OrchestratorEvent, PromptLayer, PromptTemplateInfo } from "@agent-os/protocol";

export type PromptEventSink = (event: OrchestratorEvent) => void;

/** Manifest of the shipped bytes a template was installed from (§2.6 three-way diff). */
interface InstallManifest {
  [ref: string]: { shippedHash: string; installedAt: string };
}

const MANIFEST_FILE = ".installed.json";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class PromptResolutionError extends Error {
  constructor(
    readonly code: "PROMPT_NOT_FOUND" | "PROMPT_REF_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PromptResolutionError";
  }
}

/**
 * Layered prompt packs (master plan §2.6, §6.3).
 *
 * Resolution order is shipped → global (`~/.agentos/prompts/`) → project
 * (`.agentos/prompts/`, trust-gated by the caller). Templates are files first
 * and a UI second: "tune by editing files, not code".
 *
 * Customization is detected against the shipped bytes recorded at install time,
 * so an upstream template change can be offered as a three-way diff
 * (shipped-at-install / shipped-now / yours) rather than silently overwriting
 * the Captain's edits.
 */
export class PromptService {
  private sink: PromptEventSink = () => undefined;

  constructor(
    private readonly shippedDir: string,
    private readonly globalDir: string,
  ) {}

  onEvent(sink: PromptEventSink): void {
    this.sink = sink;
  }

  /** Every shipped template ref, e.g. `fusion/fusion.md`. */
  listShippedRefs(): string[] {
    return listMarkdownRefs(this.shippedDir);
  }

  /**
   * Copy shipped templates into the global layer verbatim so they are editable,
   * recording the shipped hash each was installed from. Returns newly installed refs.
   */
  installDefaults(): string[] {
    const installed: string[] = [];
    const manifest = this.readManifest();
    for (const ref of this.listShippedRefs()) {
      const target = join(this.globalDir, ref);
      if (existsSync(target)) continue;
      const shipped = readFileSync(join(this.shippedDir, ref), "utf8");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, shipped, { mode: 0o600 });
      manifest[ref] = { shippedHash: sha256(shipped), installedAt: new Date().toISOString() };
      installed.push(ref);
    }
    if (installed.length > 0) {
      this.writeManifest(manifest);
      this.sink({ type: "prompt.installed", payload: { refs: installed } });
    }
    return installed;
  }

  /**
   * Resolve a template ref through the layers. `projectDir` is the project's
   * `.agentos/prompts` root and is only consulted when the caller has already
   * established trust.
   */
  resolve(ref: string, projectDir?: string): PromptTemplateInfo {
    assertSafeRef(ref);
    const candidates: Array<{ layer: PromptLayer; path: string }> = [];
    if (projectDir !== undefined) {
      candidates.push({ layer: "project", path: join(projectDir, ref) });
    }
    candidates.push({ layer: "global", path: join(this.globalDir, ref) });
    candidates.push({ layer: "shipped", path: join(this.shippedDir, ref) });

    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) continue;
      const content = readFileSync(candidate.path, "utf8");
      const contentHash = sha256(content);
      return {
        ref,
        layer: candidate.layer,
        path: candidate.path,
        contentHash,
        customized: this.isCustomized(ref, candidate.layer, contentHash),
        upstreamChanged: this.hasUpstreamChanged(ref),
      };
    }
    throw new PromptResolutionError("PROMPT_NOT_FOUND", `no prompt template for ref "${ref}"`);
  }

  /**
   * Render a resolved template. Undefined `{{VAR}}` references are a typed
   * error rather than a silently empty string — a half-rendered instruction is
   * worse than a refused one.
   */
  render(
    ref: string,
    vars: Record<string, string>,
    projectDir?: string,
  ): { info: PromptTemplateInfo; rendered: string; renderedHash: string } {
    const info = this.resolve(ref, projectDir);
    const template = readFileSync(info.path, "utf8");
    const rendered = interpolateTemplate(template, vars, ref);
    return { info, rendered, renderedHash: sha256(rendered) };
  }

  /** Every resolvable ref with its layer and customization state. */
  list(projectDir?: string): PromptTemplateInfo[] {
    const refs = new Set(this.listShippedRefs());
    for (const ref of listMarkdownRefs(this.globalDir)) refs.add(ref);
    if (projectDir !== undefined) {
      for (const ref of listMarkdownRefs(projectDir)) refs.add(ref);
    }
    return [...refs].sort().map((ref) => this.resolve(ref, projectDir));
  }

  /**
   * Three-way diff data for an upgrade: the shipped bytes this template was
   * installed from, the shipped bytes now, and the Captain's current copy.
   */
  threeWayDiff(ref: string): {
    ref: string;
    shippedAtInstall: string | null;
    shippedNow: string | null;
    yours: string | null;
    customized: boolean;
    upstreamChanged: boolean;
  } {
    assertSafeRef(ref);
    const manifest = this.readManifest();
    const shippedPath = join(this.shippedDir, ref);
    const globalPath = join(this.globalDir, ref);
    const shippedNow = existsSync(shippedPath) ? readFileSync(shippedPath, "utf8") : null;
    const yours = existsSync(globalPath) ? readFileSync(globalPath, "utf8") : null;
    const installedHash = manifest[ref]?.shippedHash ?? null;
    return {
      ref,
      // The installed bytes themselves are not retained; the hash is what
      // proves whether upstream moved. Surface it honestly rather than
      // reconstructing text we do not have.
      shippedAtInstall: installedHash,
      shippedNow,
      yours,
      customized: yours !== null && installedHash !== null && sha256(yours) !== installedHash,
      upstreamChanged: this.hasUpstreamChanged(ref),
    };
  }

  private isCustomized(ref: string, layer: PromptLayer, contentHash: string): boolean {
    if (layer === "shipped") return false;
    if (layer === "project") return true;
    const installedHash = this.readManifest()[ref]?.shippedHash;
    if (installedHash === undefined) return true;
    return contentHash !== installedHash;
  }

  /** True when the shipped template moved since this copy was installed. */
  private hasUpstreamChanged(ref: string): boolean {
    const installedHash = this.readManifest()[ref]?.shippedHash;
    if (installedHash === undefined) return false;
    const shippedPath = join(this.shippedDir, ref);
    if (!existsSync(shippedPath)) return false;
    return sha256(readFileSync(shippedPath, "utf8")) !== installedHash;
  }

  private manifestPath(): string {
    return join(this.globalDir, MANIFEST_FILE);
  }

  private readManifest(): InstallManifest {
    const path = this.manifestPath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
    } catch {
      return {};
    }
  }

  private writeManifest(manifest: InstallManifest): void {
    mkdirSync(this.globalDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

/** Template refs are relative paths under a pack root — never traversal. */
function assertSafeRef(ref: string): void {
  if (ref.length === 0 || ref.length > 200 || !ref.endsWith(".md")) {
    throw new PromptResolutionError("PROMPT_REF_INVALID", `invalid prompt ref "${ref}"`);
  }
  const segments = ref.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    throw new PromptResolutionError("PROMPT_REF_INVALID", `invalid prompt ref "${ref}"`);
  }
  // Belt and braces: the resolved ref must stay under a single relative root.
  const resolved = resolve("/root", ref);
  if (!resolved.startsWith(`/root${sep}`)) {
    throw new PromptResolutionError("PROMPT_REF_INVALID", `invalid prompt ref "${ref}"`);
  }
}

function listMarkdownRefs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}
