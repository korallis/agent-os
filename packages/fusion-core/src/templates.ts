/**
 * {{VAR}} prompt template interpolation (master plan §6.3, Phase 4 template gates).
 * Undefined variables are a typed error — never silently empty.
 */

export class TemplateInterpolationError extends Error {
  readonly code = "TEMPLATE_UNDEFINED_VAR" as const;

  constructor(
    readonly variable: string,
    readonly templateRef: string,
  ) {
    super(`undefined template variable {{${variable}}} in ${templateRef}`);
    this.name = "TemplateInterpolationError";
  }
}

const VAR_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Interpolates `{{VAR}}` placeholders. Throws if any variable is missing from `vars`.
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
  templateRef = "inline",
): string {
  const missing = new Set<string>();
  const rendered = template.replace(VAR_RE, (_match, name: string) => {
    if (!(name in vars)) {
      missing.add(name);
      return "";
    }
    return vars[name] ?? "";
  });
  if (missing.size > 0) {
    const first = [...missing][0];
    if (first === undefined) {
      throw new TemplateInterpolationError("?", templateRef);
    }
    throw new TemplateInterpolationError(first, templateRef);
  }
  return rendered;
}
