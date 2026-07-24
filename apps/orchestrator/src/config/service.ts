import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import {
  CONFIG_DOMAINS,
  configDomainSchemas,
  type AgentOsConfig,
  type ConfigDomain,
  type ConfigLayer,
  type ConfigValidationIssue,
  type OrchestratorEvent,
} from "@agent-os/protocol";
import {
  issuesFromZodError,
  loadLayerFile,
  resolveAll,
  resolveDomain,
  sha256,
  type LayerFile,
  type LayerRejection,
} from "./resolver.js";

export type ConfigEventSink = (event: OrchestratorEvent) => void;

export class ConfigWriteError extends Error {
  constructor(
    readonly domain: ConfigDomain,
    readonly layer: ConfigLayer,
    readonly issues: ConfigValidationIssue[],
  ) {
    super(`invalid ${layer} config for domain "${domain}"`);
  }
}

/**
 * Holds the resolved effective config; installs shipped-default templates;
 * hot-reloads the global layer on file change (§2.6 "hot-reload where safe").
 * Invalid edits are rejected wholesale (config.rejected event, previous
 * values retained) — never partially applied.
 */
export class ConfigService {
  private resolved: { config: AgentOsConfig; sources: Record<string, ConfigLayer> };
  private rejections: LayerRejection[] = [];
  private readonly appliedHashes = new Map<ConfigDomain, string>();
  /** Last successfully applied global-layer raw/hash/value per domain. */
  private readonly lastGoodGlobal = new Map<ConfigDomain, LayerFile>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private sink: ConfigEventSink = () => undefined;

  constructor(
    private readonly shippedDir: string,
    private readonly globalDir: string,
  ) {
    const result = resolveAll({ shippedDir, globalDir });
    this.resolved = { config: result.config, sources: result.sources };
    this.rejections = result.rejections;
    this.recordAppliedHashes();
    this.captureLastGoodFromDisk();
  }

  /** Wires the event sink (the daemon's event store) after construction. */
  onEvent(sink: ConfigEventSink): void {
    this.sink = sink;
  }

  private recordAppliedHashes(): void {
    for (const domain of CONFIG_DOMAINS) {
      const file = safeLoad(this.globalDir, domain);
      if (file !== null) this.appliedHashes.set(domain, file.contentHash);
    }
  }

  private captureLastGoodFromDisk(): void {
    for (const domain of CONFIG_DOMAINS) {
      try {
        const file = loadLayerFile(this.globalDir, domain);
        if (file === null) continue;
        if (this.validateGlobal(domain, file.value).length === 0) {
          this.lastGoodGlobal.set(domain, file);
        }
      } catch {
        // Invalid on disk — leave last-good empty until a valid write lands.
      }
    }
  }

  private rememberLastGood(domain: ConfigDomain, file: LayerFile): void {
    this.lastGoodGlobal.set(domain, file);
  }

  /**
   * Installs shipped defaults into the global config dir as commented
   * templates (§2.6: "shipped defaults … installed to ~/.agentos/config/
   * templates on init"). A template parses as `{}` so every key still
   * resolves from the shipped layer until deliberately overridden.
   */
  installDefaults(): ConfigDomain[] {
    const installed: ConfigDomain[] = [];
    for (const domain of CONFIG_DOMAINS) {
      const target = join(this.globalDir, `${domain}.json5`);
      if (existsSync(target)) continue;
      const shippedRaw = readFileSync(join(this.shippedDir, `${domain}.json5`), "utf8");
      const commented = shippedRaw
        .split("\n")
        .map((line) => (line.trim().length > 0 ? `// ${line}` : line))
        .join("\n");
      const template = [
        `// ${domain}.json5 — GLOBAL layer (Policy Packs, master plan §2.6).`,
        "// Shipped defaults are reproduced below for reference; add overrides",
        "// to the object at the bottom. Only keys you set here override the",
        "// shipped layer — everything else keeps its shipped default.",
        "//",
        commented,
        "{",
        "}",
        "",
      ].join("\n");
      writeFileSync(target, template, { mode: 0o600 });
      const contentHash = sha256(template);
      this.appliedHashes.set(domain, contentHash);
      this.rememberLastGood(domain, { value: {}, contentHash, raw: template });
      installed.push(domain);
    }
    if (installed.length > 0) {
      this.reload();
    }
    return installed;
  }

  get config(): AgentOsConfig {
    return this.resolved.config;
  }

  effective(): { config: AgentOsConfig; sources: Record<string, ConfigLayer> } {
    return this.resolved;
  }

  lastRejections(): LayerRejection[] {
    return this.rejections;
  }

  /** Raw parsed value of one layer file (Console layer view). */
  layerValue(layer: ConfigLayer, domain: ConfigDomain): unknown {
    const dir = layer === "shipped" ? this.shippedDir : layer === "global" ? this.globalDir : null;
    if (dir === null) return null;
    try {
      return loadLayerFile(dir, domain)?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Re-resolves all domains from disk, falling back to the last-good global
   * layer for any domain whose on-disk content is currently invalid so that
   * retained overrides survive later reloads of other domains. Emits
   * `config.changed` for every domain whose effective value actually changed
   * (including fallback-to-shipped when a global file is missing).
   */
  private reload(): void {
    const previousByDomain = new Map(
      CONFIG_DOMAINS.map((domain) => [domain, JSON.stringify(this.resolved.config[domain])]),
    );
    const globalOverrides: Partial<Record<ConfigDomain, unknown>> = {};
    const retainedRejections: LayerRejection[] = [];

    for (const domain of CONFIG_DOMAINS) {
      try {
        const file = loadLayerFile(this.globalDir, domain);
        if (file === null) {
          this.lastGoodGlobal.delete(domain);
          this.appliedHashes.delete(domain);
          continue;
        }
        const issues = this.validateGlobal(domain, file.value);
        if (issues.length > 0) {
          retainedRejections.push({ domain, layer: "global", issues });
          const lastGood = this.lastGoodGlobal.get(domain);
          if (lastGood !== undefined) {
            globalOverrides[domain] = lastGood.value;
          }
        } else {
          this.rememberLastGood(domain, file);
          this.appliedHashes.set(domain, file.contentHash);
        }
      } catch (error) {
        retainedRejections.push({
          domain,
          layer: "global",
          issues: [{ path: "", message: `JSON5 parse error: ${(error as Error).message}` }],
        });
        const lastGood = this.lastGoodGlobal.get(domain);
        if (lastGood !== undefined) {
          globalOverrides[domain] = lastGood.value;
        }
      }
    }

    const result = resolveAll({
      shippedDir: this.shippedDir,
      globalDir: this.globalDir,
      globalOverrides,
    });
    this.resolved = { config: result.config, sources: result.sources };

    const retainedDomains = new Set(retainedRejections.map((r) => r.domain));
    this.rejections = [
      ...retainedRejections,
      ...result.rejections.filter((r) => !(r.layer === "global" && retainedDomains.has(r.domain))),
    ];

    for (const domain of CONFIG_DOMAINS) {
      if (JSON.stringify(this.resolved.config[domain]) === previousByDomain.get(domain)) continue;
      const contentHash =
        this.lastGoodGlobal.get(domain)?.contentHash ??
        this.appliedHashes.get(domain) ??
        sha256("");
      this.sink({
        type: "config.changed",
        payload: { domain, layer: "global", hotReloaded: true, contentHash },
      });
    }
  }

  /**
   * Validated global-layer write (§8.2 PUT /v1/config/:layer/:domain).
   * Parses JSON5, applies the layer transactionally against shipped
   * defaults, writes atomically, reloads, emits `config.changed`.
   * @throws ConfigWriteError with path-precise issues; nothing is written.
   */
  writeGlobal(domain: ConfigDomain, json5Text: string): { contentHash: string } {
    let value: unknown;
    try {
      value = JSON5.parse(json5Text);
    } catch (error) {
      throw new ConfigWriteError(domain, "global", [
        { path: "", message: `JSON5 parse error: ${(error as Error).message}` },
      ]);
    }
    const shipped = loadLayerFile(this.shippedDir, domain);
    if (shipped === null) throw new Error(`missing shipped default for "${domain}"`);
    const resolved = resolveDomain(domain, { shipped: shipped.value, global: value });
    const rejection = resolved.rejections.find((r) => r.layer === "global");
    if (rejection !== undefined) {
      throw new ConfigWriteError(domain, "global", rejection.issues);
    }

    const target = join(this.globalDir, `${domain}.json5`);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, json5Text, { mode: 0o600 });
    renameSync(tmp, target);
    const contentHash = sha256(json5Text);
    this.appliedHashes.set(domain, contentHash);
    this.rememberLastGood(domain, { value, contentHash, raw: json5Text });
    this.reload();
    return { contentHash };
  }

  /** Validates a candidate global-layer body without writing (dry run). */
  validateGlobal(domain: ConfigDomain, value: unknown): ConfigValidationIssue[] {
    const schema = configDomainSchemas[domain];
    const shipped = loadLayerFile(this.shippedDir, domain);
    if (shipped === null) throw new Error(`missing shipped default for "${domain}"`);
    const resolved = resolveDomain(domain, { shipped: shipped.value, global: value });
    const rejection = resolved.rejections.find((r) => r.layer === "global");
    if (rejection !== undefined) return rejection.issues;
    const full = schema.safeParse(resolved.value);
    return full.success ? [] : issuesFromZodError(full.error);
  }

  /**
   * Watches the global config dir; external edits hot-reload valid files
   * (config.changed) and reject invalid ones (config.rejected), keeping
   * previous values (§11 Phase 1 config gates).
   */
  startWatching(): void {
    if (this.watcher !== null) return;
    this.watcher = watch(this.globalDir, () => {
      if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        this.handleExternalChange();
      }, 60);
    });
  }

  private handleExternalChange(): void {
    type DomainProbe =
      | { kind: "missing" }
      | { kind: "unparseable"; error: Error }
      | { kind: "present"; file: LayerFile };

    const probes = new Map<ConfigDomain, DomainProbe>();
    for (const domain of CONFIG_DOMAINS) {
      try {
        const file = loadLayerFile(this.globalDir, domain);
        probes.set(domain, file === null ? { kind: "missing" } : { kind: "present", file });
      } catch (error) {
        probes.set(domain, { kind: "unparseable", error: error as Error });
      }
    }

    const deletedDomains = CONFIG_DOMAINS.filter((domain) => {
      const probe = probes.get(domain);
      return (
        probe?.kind === "missing" &&
        (this.lastGoodGlobal.has(domain) || this.appliedHashes.has(domain))
      );
    });
    if (deletedDomains.length > 0) {
      this.reload();
    }

    for (const domain of CONFIG_DOMAINS) {
      const probe = probes.get(domain);
      if (probe === undefined || probe.kind === "missing") continue;

      if (probe.kind === "unparseable") {
        // Unparseable JSON5 — reject, keep previous values.
        if (this.appliedHashes.get(domain) !== "unparseable") {
          this.appliedHashes.set(domain, "unparseable");
          this.sink({
            type: "config.rejected",
            payload: {
              domain,
              layer: "global",
              issues: [
                {
                  path: "",
                  message: `JSON5 parse error: ${probe.error.message}`,
                },
              ],
            },
          });
        }
        continue;
      }

      const { file } = probe;
      if (this.appliedHashes.get(domain) === file.contentHash) continue;

      const issues = this.validateGlobal(domain, file.value);
      this.appliedHashes.set(domain, file.contentHash);
      if (issues.length > 0) {
        this.sink({
          type: "config.rejected",
          payload: { domain, layer: "global", issues },
        });
        continue;
      }
      this.rememberLastGood(domain, file);
      this.reload();
    }
  }

  stop(): void {
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

function safeLoad(dir: string, domain: ConfigDomain): ReturnType<typeof loadLayerFile> {
  try {
    return loadLayerFile(dir, domain);
  } catch {
    return null;
  }
}
