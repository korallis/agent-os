import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { configDomainSchemas, CONFIG_DOMAINS, } from "@agent-os/protocol";
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Deep merge: objects merge recursively; arrays and scalars replace. */
function deepMerge(base, overlay) {
    const out = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        const existing = out[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            out[key] = deepMerge(existing, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/** Enumerates dotted leaf paths of a nested plain object. */
export function leafPaths(value, prefix = "") {
    const paths = [];
    for (const [key, child] of Object.entries(value)) {
        const path = prefix.length > 0 ? `${prefix}.${key}` : key;
        if (isPlainObject(child)) {
            paths.push(...leafPaths(child, path));
        }
        else {
            paths.push(path);
        }
    }
    return paths;
}
export function issuesFromZodError(error) {
    return error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
    }));
}
/**
 * Resolves one domain across its layer stack. Layer application is
 * transactional: candidate = merge(current, layer); schema failure rejects
 * the layer entirely (nothing partially applied, §11 Phase 1 gate).
 */
export function resolveDomain(domain, layers, projectPolicy = { trusted: false }) {
    const schema = configDomainSchemas[domain];
    const rejections = [];
    const shippedParsed = schema.safeParse(layers.shipped);
    if (!shippedParsed.success) {
        throw new Error(`shipped defaults for domain "${domain}" are invalid: ${JSON.stringify(issuesFromZodError(shippedParsed.error))}`);
    }
    let current = shippedParsed.data;
    const sources = {};
    for (const path of leafPaths(current))
        sources[path] = "shipped";
    const ordered = [];
    if (layers.global !== undefined)
        ordered.push({ layer: "global", value: layers.global });
    if (layers.project !== undefined)
        ordered.push({ layer: "project", value: layers.project });
    if (layers.task !== undefined)
        ordered.push({ layer: "task", value: layers.task });
    for (const { layer, value } of ordered) {
        if (layer === "project" && !projectPolicy.trusted) {
            rejections.push({
                domain,
                layer,
                issues: [
                    {
                        path: "",
                        message: "project .agentos/ layer refused: repo is not trust-acknowledged (Phase 1 trust-gating stub)",
                    },
                ],
            });
            continue;
        }
        if (!isPlainObject(value)) {
            rejections.push({
                domain,
                layer,
                issues: [{ path: "", message: "layer file must contain a JSON5 object" }],
            });
            continue;
        }
        const candidate = deepMerge(current, value);
        const parsed = schema.safeParse(candidate);
        if (!parsed.success) {
            rejections.push({ domain, layer, issues: issuesFromZodError(parsed.error) });
            continue;
        }
        current = parsed.data;
        for (const path of leafPaths(value))
            sources[path] = layer;
    }
    return { value: current, sources, rejections };
}
/** Loads `<dir>/<domain>.json5`; returns null when absent; throws on parse error. */
export function loadLayerFile(dir, domain) {
    const path = join(dir, `${domain}.json5`);
    if (!existsSync(path))
        return null;
    const raw = readFileSync(path, "utf8");
    const value = JSON5.parse(raw);
    return { value, contentHash: sha256(raw), raw };
}
export function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
export function resolveAll(options) {
    const rejections = [];
    const sources = {};
    const config = {};
    for (const domain of CONFIG_DOMAINS) {
        const shipped = loadLayerFile(options.shippedDir, domain);
        if (shipped === null) {
            throw new Error(`missing shipped default for domain "${domain}" in ${options.shippedDir}`);
        }
        const layers = { shipped: shipped.value };
        if (options.globalOverrides !== undefined && Object.hasOwn(options.globalOverrides, domain)) {
            layers.global = options.globalOverrides[domain];
        }
        else {
            try {
                const global = loadLayerFile(options.globalDir, domain);
                if (global !== null)
                    layers.global = global.value;
            }
            catch (error) {
                rejections.push({
                    domain,
                    layer: "global",
                    issues: [{ path: "", message: `JSON5 parse error: ${error.message}` }],
                });
            }
        }
        if (options.projectDir !== undefined) {
            try {
                const project = loadLayerFile(options.projectDir, domain);
                if (project !== null)
                    layers.project = project.value;
            }
            catch (error) {
                rejections.push({
                    domain,
                    layer: "project",
                    issues: [{ path: "", message: `JSON5 parse error: ${error.message}` }],
                });
            }
        }
        const taskOverride = options.taskOverrides?.[domain];
        if (taskOverride !== undefined)
            layers.task = taskOverride;
        const resolved = resolveDomain(domain, layers, options.projectPolicy ?? { trusted: false });
        rejections.push(...resolved.rejections);
        config[domain] = resolved.value;
        for (const [path, layer] of Object.entries(resolved.sources)) {
            sources[`${domain}.${path}`] = layer;
        }
    }
    return { config: config, sources, rejections };
}
