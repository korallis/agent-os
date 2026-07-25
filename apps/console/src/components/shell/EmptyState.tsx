import Link from "next/link";
import { cn } from "@agent-os/ui";
import { Icon } from "@/components/shell/Icon";

/**
 * Shared empty / error treatments — Figma frames `37:3731` (Not Found),
 * `37:3760` (Server Error), `37:3792` (No Data), `37:3812` (No Results).
 *
 * One component rather than four pages: the frames differ only in glyph, copy
 * and the action offered, and a single implementation keeps them consistent as
 * the design moves.
 */

export type EmptyStateKind = "not-found" | "server-error" | "no-data" | "no-results";

const PRESETS: Record<
  EmptyStateKind,
  { icon: string; title: string; body: string; tone: "neutral" | "danger" }
> = {
  "not-found": {
    icon: "ls-alert.svg",
    title: "Not found",
    body: "That page or record does not exist in this fleet.",
    tone: "neutral",
  },
  "server-error": {
    icon: "ls-alert.svg",
    title: "agentosd is unreachable",
    body: "The daemon is not responding on 127.0.0.1. Start it with `agentos start`, then retry.",
    tone: "danger",
  },
  "no-data": {
    icon: "info.svg",
    title: "Nothing here yet",
    body: "This view fills in as the fleet runs. Nothing has been recorded so far.",
    tone: "neutral",
  },
  "no-results": {
    icon: "ij-search.svg",
    title: "No results",
    body: "No records match the current filter.",
    tone: "neutral",
  },
};

export function EmptyState({
  kind,
  title,
  body,
  action,
  className,
}: {
  kind: EmptyStateKind;
  /** Override the preset copy when the caller has something more specific. */
  title?: string;
  body?: string;
  action?: { href: string; label: string };
  className?: string;
}) {
  const preset = PRESETS[kind];
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-line-2 bg-panel px-6 py-16 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-2xl border",
          preset.tone === "danger"
            ? "border-danger/30 bg-danger/10"
            : "border-line-1 bg-panel-2",
        )}
      >
        <Icon src={preset.icon} className="size-5" />
      </span>
      <h3
        className={cn(
          "text-[15px] font-semibold",
          preset.tone === "danger" ? "text-danger" : "text-fg-1",
        )}
      >
        {title ?? preset.title}
      </h3>
      <p className="max-w-md text-[13px] leading-5 text-fg-2">{body ?? preset.body}</p>
      {action !== undefined && (
        <Link
          href={action.href}
          className="mt-2 rounded-lg bg-panel-2 border border-line-1 px-4 py-2 text-[13px] font-medium text-fg-1 hover:border-line-2 transition-colors"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
