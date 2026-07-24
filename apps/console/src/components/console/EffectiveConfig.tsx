"use client";

import { useEffect, useState } from "react";
import { cn, MicroLabel } from "@agent-os/ui";
import {
  effectiveConfigResponseSchema,
  type ConfigLayer,
  type EffectiveConfigResponse,
} from "@agent-os/protocol";

const LAYER_STYLES: Record<ConfigLayer, string> = {
  shipped: "text-black/40 border-black/15",
  global: "text-ink border-ink",
  project: "text-ink border-ink",
  task: "text-ink border-ink",
};

function leafEntries(
  value: Record<string, unknown>,
  prefix: string,
): { path: string; display: string }[] {
  const rows: { path: string; display: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      rows.push(...leafEntries(child as Record<string, unknown>, path));
    } else {
      rows.push({ path, display: Array.isArray(child) ? child.join(", ") : String(child) });
    }
  }
  return rows;
}

/**
 * Read-only effective-config chain view: every key with its source layer
 * (`/v1/config/effective`, §8.2). The full layered editor is Phase 6 (§7.5);
 * this proves the per-key source reporting through the console.
 */
export function EffectiveConfig() {
  const [data, setData] = useState<EffectiveConfigResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentos/config/effective", { cache: "no-store" })
      .then(async (response) => {
        const parsed = effectiveConfigResponseSchema.safeParse(await response.json());
        if (!cancelled) {
          if (response.ok && parsed.success) setData(parsed.data);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <MicroLabel className="text-red-600">
        agentosd unreachable — effective config unavailable
      </MicroLabel>
    );
  }
  if (data === null) {
    return <MicroLabel className="text-black/40">loading effective config…</MicroLabel>;
  }

  const domains = Object.entries(data.config) as [string, Record<string, unknown>][];

  return (
    <div className="space-y-8">
      {domains.map(([domain, value]) => (
        <div key={domain}>
          <div className="flex items-baseline justify-between mb-2">
            <MicroLabel className="text-black/60">{domain}</MicroLabel>
            <MicroLabel className="text-black/30">{domain}.json5</MicroLabel>
          </div>
          <div className="border border-rule divide-y divide-[#e5e5e0]">
            {leafEntries(value, "").map((row) => {
              const layer = data.sources[`${domain}.${row.path}`] ?? "shipped";
              return (
                <div key={row.path} className="px-5 py-2.5 flex items-center gap-4">
                  <span className="font-mono text-xs text-black/70 w-64 shrink-0">{row.path}</span>
                  <span className="font-mono text-xs text-ink flex-1 truncate">{row.display}</span>
                  <span
                    className={cn(
                      "font-mono text-[10px] uppercase tracking-[0.2em] border px-2 py-0.5 shrink-0",
                      LAYER_STYLES[layer],
                    )}
                  >
                    {layer}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
