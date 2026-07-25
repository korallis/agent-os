"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";
import {
  effectiveConfigResponseSchema,
  type ConfigLayer,
  type EffectiveConfigResponse,
} from "@agent-os/protocol";
import { SettingsModal, Divider, type SettingsTab } from "@/components/settings/SettingsModal";
import { SafetyToggles } from "./SafetyToggles";
import { PromptDiff } from "./PromptDiff";
import { BalancerPanel } from "./BalancerPanel";

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
 * Settings-modal language. Live from `/v1/config/effective`: every key shows
 * its value and the layer that supplied it.
 *
 * The ◆ diff-from-default mark is computed by comparing the effective value
 * against the SHIPPED value, not by asking whether some layer mentions the key.
 * A global file that happens to restate a default is not a deviation, and
 * marking it as one would train the Captain to ignore the mark.
 */
export function PoliciesModal() {
  const [data, setData] = useState<EffectiveConfigResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  /** domain → flattened shipped defaults, for the ◆ comparison. */
  const [shipped, setShipped] = useState<Record<string, Record<string, string>>>({});

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

  // Shipped defaults per domain — fetched once the domain list is known so the
  // ◆ mark compares values rather than inferring deviation from the layer name.
  const domainList = data !== null ? Object.keys(data.config) : [];
  const domainKey = domainList.join(",");
  useEffect(() => {
    if (domainList.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, Record<string, string>> = {};
      await Promise.all(
        domainList.map(async (name) => {
          try {
            const res = await fetch(`/api/agentos/config/shipped/${name}`, { cache: "no-store" });
            if (!res.ok) return;
            const body = (await res.json()) as { value?: unknown };
            if (body.value === null || typeof body.value !== "object") return;
            next[name] = Object.fromEntries(
              leafEntries(body.value as Record<string, unknown>, "").map((row) => [
                row.path,
                row.display,
              ]),
            );
          } catch {
            // A missing shipped view means we cannot claim a deviation; the ◆
            // simply does not render, which is the honest fallback.
          }
        }),
      );
      if (!cancelled) setShipped(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [domainKey]);

  const domains = data !== null ? Object.keys(data.config) : [];
  const domain = activeDomain ?? domains[0] ?? null;

  const SAFETY_TAB = "safety";
  const PROMPTS_TAB = "prompts";
  const tabs: SettingsTab[] = [
    ...domains.map((name) => ({ label: name, icon: "st-workspace.svg" })),
    { label: SAFETY_TAB, icon: "st-workspace.svg" },
    { label: PROMPTS_TAB, icon: "st-workspace.svg" },
  ];

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

  if (domain === "balancer") {
    return (
      <SettingsModal
        heading="Policies"
        tabs={tabs}
        activeTab={domain}
        title="Auto-balancer"
        subtitle="Spread work across your roster by remaining quota window."
        footer={footer}
        onTabSelect={setActiveDomain}
      >
        <BalancerPanel />
      </SettingsModal>
    );
  }

  if (domain === "safety" || domain === "prompts") {
    return (
      <SettingsModal
        heading="Policies"
        tabs={tabs}
        activeTab={domain}
        title={domain === "safety" ? "Safety policies" : "Prompt templates"}
        subtitle={
          domain === "safety"
            ? "The invariants that keep the fleet honest — overridable, never by accident."
            : "Three-way diff between what shipped at install, what ships now, and your copy."
        }
        footer={footer}
        onTabSelect={setActiveDomain}
      >
        {domain === "safety" ? <SafetyToggles /> : <PromptDiff />}
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
          const shippedValue = shipped[domain]?.[row.path];
          // Only claim a deviation when the shipped value is known AND differs.
          const differsFromDefault = shippedValue !== undefined && shippedValue !== row.display;
          return (
            <div key={row.path} className="flex flex-col gap-4">
              {index > 0 && <Divider />}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg-2">
                    {differsFromDefault && (
                      <span
                        aria-label="differs from shipped default"
                        title={`Shipped default: ${shippedValue}`}
                        className="text-teal-brand"
                      >
                        ◆
                      </span>
                    )}
                    {row.path}
                  </span>
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
                  {differsFromDefault && (
                    <> ◆ differs from shipped default (<span className="font-mono">{shippedValue}</span>).</>
                  )}
                </span>
              </div>
            </div>
          );
        })}
    </SettingsModal>
  );
}
