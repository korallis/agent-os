"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";

/**
 * Three-way prompt diff (master plan §11 Phase 6, [R3]).
 *
 * The three sides are: what shipped when you installed, what ships now, and
 * your copy. The install-time TEXT is deliberately not retained — only its
 * hash — so this renders the hash for that side rather than reconstructing
 * bytes we do not have. An upgrade never overwrites your copy; this screen
 * exists so you can decide what to take from the newer shipped version.
 */

interface PromptTemplate {
  ref: string;
  layer: string;
  customized: boolean;
  upstreamChanged: boolean;
}

interface ThreeWayDiff {
  ref: string;
  shippedAtInstall: string | null;
  shippedNow: string | null;
  yours: string | null;
  customized: boolean;
  upstreamChanged: boolean;
}

/** Line-level diff, enough to see what moved without a diff library. */
function diffLines(a: string, b: string): Array<{ tone: "same" | "add" | "remove"; text: string }> {
  const left = a.split("\n");
  const right = b.split("\n");
  const rows: Array<{ tone: "same" | "add" | "remove"; text: string }> = [];
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  for (const line of left) {
    if (!rightSet.has(line)) rows.push({ tone: "remove", text: line });
  }
  for (const line of right) {
    rows.push({ tone: leftSet.has(line) ? "same" : "add", text: line });
  }
  return rows;
}

export function PromptDiff() {
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ThreeWayDiff | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [diffFailedRef, setDiffFailedRef] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agentos/prompts", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { templates: PromptTemplate[] };
        if (cancelled) return;
        setTemplates(body.templates);
        // Open on the case that actually needs a decision: edited AND moved.
        const needsDecision = body.templates.find((t) => t.customized && t.upstreamChanged);
        const customized = body.templates.find((t) => t.customized);
        setSelected((needsDecision ?? customized ?? body.templates[0])?.ref ?? null);
      } catch {
        if (!cancelled) setListFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    // Do not clear diff synchronously — treat a mismatched ref as loading so
    // we never cascade a render before the async fetch settles.
    void (async () => {
      try {
        const res = await fetch(`/api/agentos/prompts/diff?ref=${encodeURIComponent(selected)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as ThreeWayDiff;
        if (!cancelled) {
          setDiff(body);
          setDiffFailedRef(null);
        }
      } catch {
        if (!cancelled) {
          setDiff(null);
          setDiffFailedRef(selected);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (listFailed) {
    return <p className="text-[13px] text-danger">Prompt templates unavailable from the daemon.</p>;
  }
  if (templates === null) {
    return <p className="text-[13px] text-fg-3">Loading prompt templates…</p>;
  }
  if (templates.length === 0) {
    return <p className="text-[13px] text-fg-3">No prompt templates are installed.</p>;
  }

  const customizedCount = templates.filter((t) => t.customized).length;
  const needsDecisionCount = templates.filter((t) => t.customized && t.upstreamChanged).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-[14px] font-semibold text-fg-1">Prompt templates</h3>
        <p className="text-[12px] text-fg-3">
          {customizedCount} customized · {needsDecisionCount} with an upstream update waiting.
          Upgrading never overwrites your copy.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {templates.map((template) => (
          <button
            key={template.ref}
            type="button"
            onClick={() => setSelected(template.ref)}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[11px] font-mono transition-colors",
              selected === template.ref
                ? "border-line-2 bg-panel-2 text-fg-1"
                : "border-transparent text-fg-2 hover:text-fg-1",
            )}
          >
            {template.customized && <span className="text-teal-brand">◆ </span>}
            {template.ref}
            {template.customized && template.upstreamChanged && (
              <span className="text-warn"> !</span>
            )}
          </button>
        ))}
      </div>

      {diffFailedRef === selected && selected !== null ? (
        <p className="text-[13px] text-danger">
          Could not load diff for <span className="font-mono">{diffFailedRef}</span>.
        </p>
      ) : diff === null || diff.ref !== selected ? (
        <p className="text-[13px] text-fg-3">Loading diff…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded px-2 py-0.5 bg-panel-2 text-fg-2">
              customized: {String(diff.customized)}
            </span>
            <span className="rounded px-2 py-0.5 bg-panel-2 text-fg-2">
              upstream changed: {String(diff.upstreamChanged)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-fg-3">Shipped at install</span>
              <div className="rounded-[10px] border border-line-1 bg-shell p-3 min-h-[80px]">
                {/* Only the hash is retained — say so instead of showing bytes
                    we never kept. */}
                <p className="font-mono text-[11px] text-fg-2 break-all">
                  {diff.shippedAtInstall ?? "not recorded"}
                </p>
                <p className="mt-1 text-[11px] text-fg-3">
                  Install text is not retained — this hash is what proves whether upstream moved.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-fg-3">Shipped now</span>
              <pre className="rounded-[10px] border border-line-1 bg-shell p-3 min-h-[80px] max-h-[320px] overflow-auto font-mono text-[11px] text-fg-2 whitespace-pre-wrap">
                {diff.shippedNow ?? "(not shipped)"}
              </pre>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-fg-3">Your copy</span>
              <pre className="rounded-[10px] border border-line-1 bg-shell p-3 min-h-[80px] max-h-[320px] overflow-auto font-mono text-[11px] text-fg-1 whitespace-pre-wrap">
                {diff.yours ?? "(none — using shipped)"}
              </pre>
            </div>
          </div>

          {diff.shippedNow !== null && diff.yours !== null && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-fg-3">
                Shipped now → your copy
              </span>
              <div className="rounded-[10px] border border-line-1 bg-shell p-3 max-h-[280px] overflow-auto">
                {diffLines(diff.shippedNow, diff.yours).map((row, index) => (
                  <div
                    key={`${index}-${row.text}`}
                    className={cn(
                      "font-mono text-[11px] whitespace-pre-wrap",
                      row.tone === "add"
                        ? "text-ok"
                        : row.tone === "remove"
                          ? "text-danger"
                          : "text-fg-3",
                    )}
                  >
                    {row.tone === "add" ? "+ " : row.tone === "remove" ? "- " : "  "}
                    {row.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
