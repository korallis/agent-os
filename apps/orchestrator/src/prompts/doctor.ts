import type { PromptService } from "./service.js";

/**
 * `agentos config doctor` (master plan §11 Phase 8).
 *
 * Reports which shipped prompt templates the Captain has customised and which
 * of those have an upstream update waiting. The point is the intersection: a
 * customised template with a newer shipped version is the only case that needs
 * a decision, and an upgrade must never silently overwrite the Captain's edit.
 */

export interface TemplateDrift {
  ref: string;
  layer: string;
  customized: boolean;
  upstreamChanged: boolean;
  /** True when both hold — the case a three-way diff exists for. */
  needsDecision: boolean;
}

export interface ConfigDoctorReport {
  templates: TemplateDrift[];
  customizedCount: number;
  upstreamChangedCount: number;
  /** Templates the Captain edited AND upstream moved — the real work list. */
  needsDecisionCount: number;
}

export function runConfigDoctor(prompts: PromptService, projectDir?: string): ConfigDoctorReport {
  const templates = prompts.list(projectDir).map((info): TemplateDrift => {
    const needsDecision = info.customized && info.upstreamChanged;
    return {
      ref: info.ref,
      layer: info.layer,
      customized: info.customized,
      upstreamChanged: info.upstreamChanged,
      needsDecision,
    };
  });

  return {
    templates,
    customizedCount: templates.filter((t) => t.customized).length,
    upstreamChangedCount: templates.filter((t) => t.upstreamChanged).length,
    needsDecisionCount: templates.filter((t) => t.needsDecision).length,
  };
}

/** Human-readable lines for the CLI. Silent when nothing has drifted. */
export function formatConfigDoctor(report: ConfigDoctorReport): string[] {
  const lines: string[] = [];
  if (report.customizedCount === 0 && report.upstreamChangedCount === 0) {
    lines.push("config doctor: no prompt templates have drifted from shipped defaults");
    return lines;
  }
  lines.push(
    `config doctor: ${report.customizedCount} customized, ${report.upstreamChangedCount} with upstream updates, ${report.needsDecisionCount} needing a decision`,
  );
  for (const template of report.templates) {
    if (!template.customized && !template.upstreamChanged) continue;
    const marks: string[] = [];
    if (template.customized) marks.push("customized");
    if (template.upstreamChanged) marks.push("upstream-updated");
    lines.push(
      `  ${template.needsDecision ? "!" : "·"} ${template.ref} (${template.layer}) — ${marks.join(", ")}`,
    );
  }
  if (report.needsDecisionCount > 0) {
    lines.push(
      "  ! = your edit and an upstream change — review the three-way diff before upgrading; upgrade never overwrites your copy",
    );
  }
  return lines;
}
