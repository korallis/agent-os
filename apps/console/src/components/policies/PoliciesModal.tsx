"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import {
  effectiveConfigResponseSchema,
  type ConfigLayer,
  type EffectiveConfigResponse,
} from "@agent-os/protocol";
import { SettingsModal, Divider, type SettingsTab } from "@/components/settings/SettingsModal";

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

const LAYER_PILL: Record<ConfigLayer, string> = {
  shipped: "bg-panel-2 text-fg-3",
  global: "bg-ok/[0.08] text-ok",
  project: "bg-teal-brand/[0.08] text-teal-brand",
  task: "bg-teal-brand/[0.08] text-teal-brand",
};

/**
 * Policies (§7.5) — the effective Policy Pack chain rendered in the Figma
 * Settings-modal language. Live from `/v1/config/effective`: every key
 * shows its value and the layer that supplied it. The layered editor and
 * three-way prompt diffs land in Phase 6; files are the truth today.
 */
export function PoliciesModal() {
  const [data, setData] = useState<EffectiveConfigResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);

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

  const domains = data !== null ? Object.keys(data.config) : [];
  const domain = activeDomain ?? domains[0] ?? null;

  const tabs: SettingsTab[] = domains.map((name) => ({
    label: name,
    icon: "st-workspace.svg",
  }));

  const footer = (
    <>
      <span className="mr-auto pl-8 text-xs text-fg-3">
        Files are the truth — edit{" "}
        <span className="font-mono text-[11px]">~/.agentos/config/*.json5</span>; valid
        changes hot-reload, invalid changes are rejected wholesale.
      </span>
      <span className="flex items-center h-[38px] rounded-lg bg-panel-2 border border-line-2 px-5 text-[13px] font-medium text-fg-2">
        Read-only
      </span>
    </>
  );

  if (failed) {
    return (
      <SettingsModal
        heading="Policies"
        tabs={[{ label: "unavailable", icon: "st-workspace.svg" }]}
        activeTab="unavailable"
        title="Policy Pack"
        subtitle="Effective configuration across layers."
        footer={footer}
      >
        <p className="text-[13px] text-danger">
          agentosd unreachable — effective config unavailable. Start the daemon:{" "}
          <span className="font-mono text-xs">agentos start</span>
        </p>
      </SettingsModal>
    );
  }

  if (data === null || domain === null) {
    return (
      <SettingsModal
        heading="Policies"
        tabs={[{ label: "loading…", icon: "st-workspace.svg" }]}
        activeTab="loading…"
        title="Policy Pack"
        subtitle="Effective configuration across layers."
        footer={footer}
      >
        <p className="text-[13px] text-fg-3">loading effective config…</p>
      </SettingsModal>
    );
  }

  const domainEntries = Object.entries(data.config) as [string, Record<string, unknown>][];
  const value = domainEntries.find(([name]) => name === domain)?.[1] ?? {};
  const rows = leafEntries(value, "");

  return (
    <SettingsModal
      heading="Policies"
      tabs={tabs}
      activeTab={domain}
      title={`${domain.charAt(0).toUpperCase()}${domain.slice(1)}`}
      subtitle={`Effective values for ${domain}.json5 — shipped → global → project → task.`}
      footer={footer}
      onTabSelect={setActiveDomain}
    >
        {rows.map((row, index) => {
          const layer = data.sources[`${domain}.${row.path}`] ?? "shipped";
          return (
            <div key={row.path} className="flex flex-col gap-4">
              {index > 0 && <Divider />}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-fg-2">{row.path}</span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 rounded-[20px] px-2.5 py-1 text-[11px] font-semibold",
                      LAYER_PILL[layer],
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-[3px]",
                        layer === "shipped" ? "bg-fg-3" : layer === "global" ? "bg-ok" : "bg-teal-brand",
                      )}
                    />
                    {layer}
                  </span>
                </div>
                <div className="flex h-[42px] items-center rounded-[10px] bg-shell border border-line-2 px-[15px]">
                  <span className="font-mono text-xs text-fg-1 truncate">{row.display}</span>
                </div>
                <span className="text-xs text-fg-3">
                  Supplied by the {layer} layer{layer === "shipped" ? " (default)" : ""}.
                </span>
              </div>
            </div>
          );
        })}
    </SettingsModal>
  );
}
