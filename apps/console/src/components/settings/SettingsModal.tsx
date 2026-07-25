"use client";

import Link from "next/link";
import { cn } from "@agent-os/ui";
import { Icon } from "@/components/shell/Icon";

export interface SettingsTab {
  label: string;
  icon: string;
  href?: string;
}

interface SettingsModalProps {
  heading: string;
  tabs: SettingsTab[];
  activeTab: string;
  title: string;
  subtitle: string;
  footer?: React.ReactNode;
  /** When provided, tabs without an href become buttons that report clicks. */
  onTabSelect?: (label: string) => void;
  children: React.ReactNode;
}

/**
 * The Figma Settings modal shell: 960×660 panel on a dimmed backdrop,
 * left tab rail with a 3px active bar, header with ESC affordance, and
 * an action footer. Shared by Settings, Providers, and Policies.
 */
export function SettingsModal({
  heading,
  tabs,
  activeTab,
  title,
  subtitle,
  footer,
  onTabSelect,
  children,
}: SettingsModalProps) {
  return (
    <div className="relative flex-1 min-h-screen">
      <div className="absolute inset-0 bg-black/80" />
      <div className="relative z-10 flex min-h-screen items-center justify-center p-8">
        <div className="flex w-[960px] max-w-full h-[660px] rounded-2xl bg-panel border border-[#3a3a3a] shadow-[0px_16px_48px_-4px_rgba(0,0,0,0.5)] overflow-hidden">
          {/* Tab rail */}
          <div className="w-[220px] shrink-0 bg-shell border-r border-line-1 pt-7">
            <p className="px-5 text-base font-bold text-fg-1 mb-4">{heading}</p>
            <ul>
              {tabs.map((tab) => {
                const active = tab.label === activeTab;
                const row = (
                  <span
                    className={cn(
                      "flex items-center gap-3 h-10 px-5",
                      active && "bg-panel-2 border-l-[3px] border-fg-1 pl-[17px]",
                    )}
                  >
                    <Icon
                      src={tab.icon}
                      className="size-4"
                      tint={active ? "#f5f5f5" : "#999999"}
                    />
                    <span
                      className={cn(
                        "text-[13px]",
                        active ? "font-semibold text-fg-1" : "font-medium text-fg-2",
                      )}
                    >
                      {tab.label}
                    </span>
                  </span>
                );
                return (
                  <li key={tab.label}>
                    {tab.href !== undefined && !active ? (
                      <Link href={tab.href}>{row}</Link>
                    ) : onTabSelect !== undefined && !active ? (
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => onTabSelect(tab.label)}
                      >
                        {row}
                      </button>
                    ) : (
                      row
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {/* Content */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="h-16 shrink-0 border-b border-line-1 flex items-center justify-between px-8">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-lg font-bold text-fg-1">{title}</h2>
                <p className="text-[13px] text-fg-3">{subtitle}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] font-medium text-fg-3 tracking-[1px]">
                  ESC
                </span>
                <Icon src="st-close.svg" className="size-[18px]" />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-8 px-8 pt-7 pb-6">
              {children}
            </div>
            <div className="h-16 shrink-0 border-t border-line-1 flex items-center justify-end gap-3 pr-8">
              {footer ?? (
                <>
                  <span className="flex items-center h-[38px] rounded-lg bg-panel-2 border border-line-2 px-5 text-[13px] font-medium text-fg-2">
                    Cancel
                  </span>
                  <span className="flex items-center h-[38px] rounded-lg bg-fg-1 px-5 text-[13px] font-semibold text-shell">
                    Save Changes
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Field({
  label,
  value,
  helper,
  muted = false,
  trailing,
}: {
  label: string;
  value: string;
  helper?: string;
  muted?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-fg-2">{label}</span>
      <div className="flex h-[42px] items-center justify-between rounded-[10px] bg-shell border border-line-2 px-[15px]">
        <span className={cn("text-[13px]", muted ? "text-fg-3" : "text-fg-1")}>{value}</span>
        {trailing}
      </div>
      {helper !== undefined && <span className="text-xs text-fg-3">{helper}</span>}
    </div>
  );
}

export function Divider() {
  return <div className="h-px bg-line-1" />;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { label: "My Profile", icon: "st-profile.svg" },
  { label: "Workspace", icon: "st-workspace.svg", href: "/settings" },
  { label: "API Providers", icon: "st-plug.svg", href: "/providers" },
  { label: "Team Members", icon: "st-team.svg" },
  { label: "Billing", icon: "st-billing.svg", href: "/settings/billing" },
];
