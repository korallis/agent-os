import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import {
  configDomainSchemas,
  CONFIG_DOMAINS,
  type AgentOsConfig,
  type ConfigDomain,
  type ConfigLayer,
  type ConfigValidationIssue,
} from "@agent-os/protocol";

/**
 * Layered config resolution — the Policy Packs foundation (master plan §2.6).
 *
 * Precedence: shipped → global → project (trust-gated) → task; highest wins.
 * Each layer file is applied ALL-OR-NOTHING: a layer whose merged result
 * fails the domain schema is rejected wholesale with path-precise issues and
 * contributes nothing. Per-leaf source layers are tracked for
 * `/v1/config/effective` (§8.2).
 */

export interface LayerRejection {
  domain: ConfigDomain;
  layer: ConfigLayer;
  issues: ConfigValidationIssue[];
}

export interface ResolvedDomain {
  value: Record<string, unknown>;
  sources: Record<string, ConfigLayer>;
  rejections: LayerRejection[];
}

export interface DomainLayerInputs {
  shipped: unknown;
  global?: unknown;
  project?: unknown;
  task?: unknown;
}

export interface ProjectLayerPolicy {
  /**
   * Phase 1 trust-gating stub (§2.6 layer 3): repos are untrusted, so
   * project layers are REFUSED unless explicitly trusted. Full
   * hash-acknowledgment lands with real project registration (Phase 2+).
   */
  trusted: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: objects merge recursively; arrays and scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Enumerates dotted leaf paths of a nested plain object. */
export function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      paths.push(...leafPaths(child, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

export function issuesFromZodError(error: z.ZodError): ConfigValidationIssue[] {
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
export function resolveDomain(
  domain: ConfigDomain,
  layers: DomainLayerInputs,
  projectPolicy: ProjectLayerPolicy = { trusted: false },
): ResolvedDomain {
  const schema = configDomainSchemas[domain];
  const rejections: LayerRejection[] = [];

  const shippedParsed = schema.safeParse(layers.shipped);
  if (!shippedParsed.success) {
    throw new Error(
      `shipped defaults for domain "${domain}" are invalid: ${JSON.stringify(
        issuesFromZodError(shippedParsed.error),
      )}`,
    );
  }

  let current = shippedParsed.data as Record<string, unknown>;
  const sources: Record<string, ConfigLayer> = {};
  for (const path of leafPaths(current)) sources[path] = "shipped";

  const ordered: { layer: ConfigLayer; value: unknown }[] = [];
  if (layers.global !== undefined) ordered.push({ layer: "global", value: layers.global });
  if (layers.project !== undefined) ordered.push({ layer: "project", value: layers.project });
  if (layers.task !== undefined) ordered.push({ layer: "task", value: layers.task });

  for (const { layer, value } of ordered) {
    if (layer === "project" && !projectPolicy.trusted) {
      rejections.push({
        domain,
        layer,
        issues: [
          {
            path: "",
            message:
              "project .agentos/ layer refused: repo is not trust-acknowledged (Phase 1 trust-gating stub)",
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
    current = parsed.data as Record<string, unknown>;
    for (const path of leafPaths(value)) sources[path] = layer;
  }

  return { value: current, sources, rejections };
}

export interface LayerFile {
  value: unknown;
  contentHash: string;
  raw: string;
}

/** Loads `<dir>/<domain>.json5`; returns null when absent; throws on parse error. */
export function loadLayerFile(dir: string, domain: ConfigDomain): LayerFile | null {
  const path = join(dir, `${domain}.json5`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const value: unknown = JSON5.parse(raw);
  return { value, contentHash: sha256(raw), raw };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ResolveAllOptions {
  shippedDir: string;
  globalDir: string;
  projectDir?: string;
  projectPolicy?: ProjectLayerPolicy;
  taskOverrides?: Partial<Record<ConfigDomain, unknown>>;
  /**
   * When set for a domain, use this as the global layer instead of reading
   * disk (last-good retention when on-disk content is currently invalid).
   */
  globalOverrides?: Partial<Record<ConfigDomain, unknown>>;
}

export interface ResolveAllResult {
  config: AgentOsConfig;
  /** Dotted `domain.path` → source layer, for every leaf key. */
  sources: Record<string, ConfigLayer>;
  rejections: LayerRejection[];
}

export function resolveAll(options: ResolveAllOptions): ResolveAllResult {
  const rejections: LayerRejection[] = [];
  const sources: Record<string, ConfigLayer> = {};
  const config: Record<string, unknown> = {};

  for (const domain of CONFIG_DOMAINS) {
    const shipped = loadLayerFile(options.shippedDir, domain);
    if (shipped === null) {
      throw new Error(`missing shipped default for domain "${domain}" in ${options.shippedDir}`);
    }

    const layers: DomainLayerInputs = { shipped: shipped.value };

    if (options.globalOverrides !== undefined && Object.hasOwn(options.globalOverrides, domain)) {
      layers.global = options.globalOverrides[domain];
    } else {
      try {
        const global = loadLayerFile(options.globalDir, domain);
        if (global !== null) layers.global = global.value;
      } catch (error) {
        rejections.push({
          domain,
          layer: "global",
          issues: [{ path: "", message: `JSON5 parse error: ${(error as Error).message}` }],
        });
      }
    }

    if (options.projectDir !== undefined) {
      try {
        const project = loadLayerFile(options.projectDir, domain);
        if (project !== null) layers.project = project.value;
      } catch (error) {
        rejections.push({
          domain,
          layer: "project",
          issues: [{ path: "", message: `JSON5 parse error: ${(error as Error).message}` }],
        });
      }
    }

    const taskOverride = options.taskOverrides?.[domain];
    if (taskOverride !== undefined) layers.task = taskOverride;

    const resolved = resolveDomain(domain, layers, options.projectPolicy ?? { trusted: false });
    rejections.push(...resolved.rejections);
    config[domain] = resolved.value;
    for (const [path, layer] of Object.entries(resolved.sources)) {
      sources[`${domain}.${path}`] = layer;
    }
  }

  return { config: config as AgentOsConfig, sources, rejections };
}
