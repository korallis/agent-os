"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@agent-os/ui";

const PAGES = [
  { href: "/fleet", label: "Fleet" },
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/runs", label: "Runs" },
  { href: "/providers", label: "Providers" },
  { href: "/analytics", label: "Analytics" },
  { href: "/policies", label: "Policies" },
  { href: "/settings", label: "Settings" },
] as const;

/** Left-rail navigation — the 8 console surfaces (master plan §7). */
export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav className="flex-1 py-4" aria-label="Console">
      <ul>
        {PAGES.map((page) => {
          const active = pathname.startsWith(page.href);
          return (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 px-5 py-2.5 text-xs font-mono uppercase tracking-[0.2em] transition-colors",
                  active
                    ? "bg-ink text-white"
                    : "text-black/50 hover:text-ink hover:bg-black/[0.03]",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-1 w-1 rounded-full",
                    active ? "bg-white" : "bg-black/20",
                  )}
                  aria-hidden
                />
                {page.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
