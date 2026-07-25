import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { interpolateTemplate } from "@agent-os/fusion-core";
const MANIFEST_FILE = ".installed.json";
export function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
export class PromptResolutionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
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
    shippedDir;
    globalDir;
    sink = () => undefined;
    constructor(shippedDir, globalDir) {
        this.shippedDir = shippedDir;
        this.globalDir = globalDir;
    }
    onEvent(sink) {
        this.sink = sink;
    }
    /** Every shipped template ref, e.g. `fusion/fusion.md`. */
    listShippedRefs() {
        return listMarkdownRefs(this.shippedDir);
    }
    /**
     * Copy shipped templates into the global layer verbatim so they are editable,
     * recording the shipped hash each was installed from. Returns newly installed refs.
     */
    installDefaults() {
        const installed = [];
        const manifest = this.readManifest();
        for (const ref of this.listShippedRefs()) {
            const target = join(this.globalDir, ref);
            if (existsSync(target))
                continue;
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
    resolve(ref, projectDir) {
        assertSafeRef(ref);
        const candidates = [];
        if (projectDir !== undefined) {
            candidates.push({ layer: "project", path: join(projectDir, ref) });
        }
        candidates.push({ layer: "global", path: join(this.globalDir, ref) });
        candidates.push({ layer: "shipped", path: join(this.shippedDir, ref) });
        for (const candidate of candidates) {
            if (!existsSync(candidate.path))
                continue;
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
    render(ref, vars, projectDir) {
        const info = this.resolve(ref, projectDir);
        const template = readFileSync(info.path, "utf8");
        const rendered = interpolateTemplate(template, vars, ref);
        return { info, rendered, renderedHash: sha256(rendered) };
    }
    /** Every resolvable ref with its layer and customization state. */
    list(projectDir) {
        const refs = new Set(this.listShippedRefs());
        for (const ref of listMarkdownRefs(this.globalDir))
            refs.add(ref);
        if (projectDir !== undefined) {
            for (const ref of listMarkdownRefs(projectDir))
                refs.add(ref);
        }
        return [...refs].sort().map((ref) => this.resolve(ref, projectDir));
    }
    /**
     * Three-way diff data for an upgrade: `shippedAtInstall` is the hash of the
     * shipped bytes this copy was installed from (original text is not retained),
     * plus full text for shipped-now and the Captain's current copy.
     */
    threeWayDiff(ref) {
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
    isCustomized(ref, layer, contentHash) {
        if (layer === "shipped")
            return false;
        if (layer === "project")
            return true;
        const installedHash = this.readManifest()[ref]?.shippedHash;
        if (installedHash === undefined)
            return true;
        return contentHash !== installedHash;
    }
    /** True when the shipped template moved since this copy was installed. */
    hasUpstreamChanged(ref) {
        const installedHash = this.readManifest()[ref]?.shippedHash;
        if (installedHash === undefined)
            return false;
        const shippedPath = join(this.shippedDir, ref);
        if (!existsSync(shippedPath))
            return false;
        return sha256(readFileSync(shippedPath, "utf8")) !== installedHash;
    }
    manifestPath() {
        return join(this.globalDir, MANIFEST_FILE);
    }
    readManifest() {
        const path = this.manifestPath();
        if (!existsSync(path))
            return {};
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            return {};
        }
    }
    writeManifest(manifest) {
        mkdirSync(this.globalDir, { recursive: true, mode: 0o700 });
        writeFileSync(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, {
            mode: 0o600,
        });
    }
}
/** Template refs are relative paths under a pack root — never traversal. */
function assertSafeRef(ref) {
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
function listMarkdownRefs(root) {
    if (!existsSync(root))
        return [];
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.name.endsWith(".md")) {
                out.push(relative(root, full).split(sep).join("/"));
            }
        }
    };
    walk(root);
    return out.sort();
}
