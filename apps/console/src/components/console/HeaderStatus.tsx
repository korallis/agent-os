"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn, MicroLabel } from "@agent-os/ui";
import { healthResponseSchema } from "@agent-os/protocol";

type DaemonState = "checking" | "up" | "down";

/**
 * Console header: breadcrumb + live daemon/brain chips (§7.1 header row).
 * Red is reserved for hard failures per the design mandate — a down daemon
 * qualifies.
 */
export function HeaderStatus() {
  const pathname = usePathname();
  const [daemon, setDaemon] = useState<DaemonState>("checking");

  useEffect(() => {
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
      clearInterval(timer);
    };
  }, []);

  const section = pathname.split("/")[1] ?? "fleet";

  return (
    <header className="h-14 border-b border-rule flex items-center justify-between px-6">
      <MicroLabel className="text-black/60">
        Agent OS <span className="text-black/30">▸</span> {section || "fleet"}
      </MicroLabel>
      <div className="flex items-center gap-5">
        <MicroLabel
          className={cn(
            daemon === "up" ? "text-ink" : daemon === "down" ? "text-red-600" : "text-black/40",
          )}
        >
          <span aria-hidden>● </span>
          agentosd {daemon === "up" ? "✓" : daemon === "down" ? "✗ down" : "…"}
        </MicroLabel>
        <MicroLabel className="text-black/30">● brain — phase 3</MicroLabel>
      </div>
    </header>
  );
}
