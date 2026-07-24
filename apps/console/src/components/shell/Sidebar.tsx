"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@agent-os/ui";
import { Icon } from "./Icon";

/**
 * The 8 console surfaces (master plan §7) mapped onto the Figma sidebar.
 * The design ships five nav slots plus settings; providers and policies
 * extend the rail with glyphs from the same file (Settings tab icons).
 */
const NAV = [
  { href: "/fleet", icon: "nav-home.svg", label: "Fleet" },
  { href: "/tasks", icon: "nav-box.svg", label: "Tasks" },
  { href: "/projects", icon: "nav-agents.svg", label: "Projects" },
  { href: "/runs", icon: "nav-activity.svg", label: "Runs" },
  { href: "/analytics", icon: "nav-network.svg", label: "Analytics" },
  { href: "/providers", icon: "st-plug.svg", label: "Providers" },
  { href: "/policies", icon: "st-workspace.svg", label: "Policies" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <aside className="w-16 shrink-0 border-r border-line-2 flex flex-col items-center py-5 gap-4 sticky top-0 h-screen">
      <Link
        href="/fleet"
        aria-label="AgentOS home"
        className="h-14 w-full flex items-center justify-center"
      >
        <Icon src="logo.svg" className="size-7" alt="AgentOS" />
      </Link>
      <nav aria-label="Console" className="flex-1 w-full">
        <ul className="flex flex-col items-center gap-1.5 pt-4">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={isActive(item.href) ? "page" : undefined}
                title={item.label}
                className={cn(
                  "flex items-center justify-center size-11 rounded-xl transition-colors",
                  isActive(item.href) ? "bg-line-1" : "hover:bg-line-1/50",
                )}
              >
                <Icon
                  src={item.icon}
                  className="size-5"
                  tint={isActive(item.href) ? "#f5f5f5" : "#999999"}
                  alt=""
                />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Link
        href="/settings"
        aria-label="Settings"
        aria-current={isActive("/settings") ? "page" : undefined}
        title="Settings"
        className={cn(
          "flex items-center justify-center size-11 rounded-xl transition-colors",
          isActive("/settings") ? "bg-line-1" : "hover:bg-line-1/50",
        )}
      >
        <Icon
          src="nav-settings.svg"
          className="size-5"
          tint={isActive("/settings") ? "#f5f5f5" : "#666666"}
          alt=""
        />
      </Link>
    </aside>
  );
}
