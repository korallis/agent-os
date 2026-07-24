"use client";

import { useEffect, useState } from "react";
import { healthResponseSchema } from "@agent-os/protocol";
import { Icon } from "./Icon";

type DaemonState = "checking" | "up" | "down";

/**
 * Standard page topbar from the Figma dashboard: title + chevron, ⌘K
 * search, notification bell, date chip, admin identity. The bell's red
 * dot is wired live — it shows only while agentosd is unreachable (red is
 * reserved for hard failures per the design mandate).
 */
export function Topbar({ title }: { title: string }) {
  const [daemon, setDaemon] = useState<DaemonState>("checking");
  const [today, setToday] = useState("");

  useEffect(() => {
    const updateDate = () =>
      setToday(
        new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      );
    const raf = requestAnimationFrame(updateDate);
    const dateTimer = setInterval(updateDate, 60_000);
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const response = await fetch("/api/agentos/health", { cache: "no-store" });
        const parsed = healthResponseSchema.safeParse(await response.json());
        if (!cancelled) setDaemon(response.ok && parsed.success ? "up" : "down");
      } catch {
        if (!cancelled) setDaemon("down");
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearInterval(dateTimer);
      clearInterval(timer);
    };
  }, []);

  return (
    <header className="h-16 shrink-0 border-b border-line-2 flex items-center justify-between px-8">
      <div className="flex items-center gap-1.5">
        <h1 className="text-lg font-bold text-fg-1">{title}</h1>
        <Icon src="chevron-down-lg.svg" className="size-[18px]" />
      </div>
      <div className="flex items-center gap-3.5">
        <div className="hidden lg:flex items-center gap-2 h-[38px] w-[301px] rounded-[10px] bg-panel border border-line-1 px-3.5">
          <Icon src="search.svg" className="size-5" />
          <span className="flex-1 text-[13px] text-fg-2">
            Search agents, tasks, knowledge...
          </span>
          <span className="rounded-[5px] bg-panel-2 border border-teal-brand/25 px-[7px] py-[3px] text-[10px] font-semibold text-fg-2">
            ⌘K
          </span>
        </div>
        <button
          type="button"
          aria-label={daemon === "down" ? "agentosd unreachable" : "Notifications"}
          title={daemon === "down" ? "agentosd unreachable" : "agentosd healthy"}
          className="relative size-[38px] rounded-[10px] bg-panel border border-line-1 flex items-center justify-center"
        >
          <Icon src="bell.svg" className="size-4" />
          {daemon === "down" && (
            <span className="absolute top-1.5 right-2 size-2 rounded-full bg-danger" />
          )}
        </button>
        <div className="hidden md:flex items-center gap-2.5 h-[38px] rounded-[10px] bg-panel border border-line-1 px-4">
          <Icon src="calendar.svg" className="size-4" />
          <span className="text-[13px] font-medium text-fg-1">
            Today, {today || "—"}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="size-9 rounded-full overflow-hidden bg-panel-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- exact Figma asset */}
            <img src="/figma/avatar-admin.jpg" alt="" className="size-full object-cover" />
          </span>
          <span className="flex flex-col">
            <span className="text-[13px] font-semibold text-fg-1 leading-tight">Admin</span>
            <span className="text-[11px] text-fg-3 leading-tight">@admin</span>
          </span>
        </div>
      </div>
    </header>
  );
}
