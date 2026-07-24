"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import { Icon } from "@/components/shell/Icon";
import { useEventStream } from "@/lib/useEventStream";

type Project = {
  id: string;
  name: string;
  path: string;
  mode: string;
  trusted: boolean;
  yolo: boolean;
  updatedAt: string;
  createdAt: string;
};

/**
 * Live Workflows / projects board — `/v1/projects` (Phase 3).
 */
export function ProjectsBoard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { lastEvent } = useEventStream();
  const refreshKey =
    lastEvent !== null && lastEvent.event.type.startsWith("project.")
      ? lastEvent.id
      : "init";

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/projects", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(`daemon ${res.status}`);
          return;
        }
        const body = (await res.json()) as { projects: Project[] };
        setProjects(body.projects);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("daemon unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <main className="flex-1 flex flex-col gap-5 p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[22px] font-bold text-fg-1">Workflows</h2>
          <span className="rounded-md bg-panel-2 px-2.5 py-1 text-xs font-medium text-fg-2">
            {projects.length}
          </span>
          {error !== null && (
            <span className="rounded-md bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
              {error}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.length === 0 ? (
          <div className="col-span-full rounded-2xl border border-line-2 bg-panel p-10 text-center text-sm text-fg-3">
            No projects registered.{" "}
            <code className="text-fg-2">POST /v1/projects</code> with a local git path.
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className="rounded-2xl border border-line-2 bg-panel p-5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-fg-1">{p.name}</h3>
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium",
                    p.trusted ? "text-ok" : "text-warn",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      p.trusted ? "bg-ok" : "bg-warn",
                    )}
                  />
                  {p.trusted ? "Trusted" : "Untrusted"}
                </span>
              </div>
              <p className="text-[12px] text-fg-3 font-mono truncate" title={p.path}>
                {p.path}
              </p>
              <div className="flex items-center gap-2 text-[12px] text-fg-2">
                <span className="rounded-md bg-panel-2 px-2 py-0.5">{p.mode}</span>
                {p.yolo && (
                  <span className="rounded-md bg-warn/10 text-warn px-2 py-0.5">+yolo</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-fg-3 mt-auto pt-2">
                <Icon src="ij-cpu.svg" className="size-3.5" />
                id {p.id.slice(0, 10)}…
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
