"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@agent-os/ui";

const TABS = [
  { href: "/runs", label: "Live stream", match: (path: string) => path === "/runs" },
  {
    href: "/runs/history",
    label: "History",
    match: (path: string) => path.startsWith("/runs/history"),
  },
] as const;

/** Sub-nav for the Runs area: live stream and pipeline history. */
export function RunsSubnav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Runs" className="flex items-center gap-1">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              active
                ? "bg-panel-2 border border-line-1 text-fg-1"
                : "border border-transparent text-fg-2 hover:text-fg-1 hover:bg-panel-2/60",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
