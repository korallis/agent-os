/**
 * Parse [A]/[B]/[FUSION] style attribution spans for Console rendering.
 */

export interface AttributedSpan {
  tag: string;
  body: string;
  start: number;
  end: number;
}

const SPAN_RE = /\[([A-Z][A-Z0-9_-]*)\]([\s\S]*?)(?=\[[A-Z][A-Z0-9_-]*\]|$)/g;

export function parseAttributedSpans(markdown: string): AttributedSpan[] {
  const spans: AttributedSpan[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SPAN_RE.source, "g");
  while ((match = re.exec(markdown)) !== null) {
    const tag = match[1];
    const body = match[2];
    if (tag === undefined || body === undefined) continue;
    spans.push({
      tag,
      body: body.trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return spans;
}
