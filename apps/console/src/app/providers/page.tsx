import type { Metadata } from "next";
import { cn } from "@agent-os/ui";
import {
  SettingsModal,
  Divider,
  SETTINGS_TABS,
} from "@/components/settings/SettingsModal";
import { Icon } from "@/components/shell/Icon";

export const metadata: Metadata = { title: "API Providers — AgentOS" };

function ProviderLogo({ letter, className }: { letter: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-sm font-bold text-black",
        className,
      )}
    >
      {letter}
    </span>
  );
}

/**
 * Providers (§7.6) — the Figma "Settings: API Providers" screen. Provider
 * connect/rotate flows are wired in Phase 2 with the quota ladder; this is
 * the pixel-faithful surface awaiting that wiring.
 */
export default function ProvidersPage() {
  return (
    <SettingsModal
      heading="Settings"
      tabs={SETTINGS_TABS}
      activeTab="API Providers"
      title="LLM API Configuration"
      subtitle="Connect and manage your AI model API keys."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <ProviderLogo letter="G" className="bg-white" />
            <span className="text-[15px] font-semibold text-fg-1">OpenAI</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-[20px] bg-ok/[0.08] px-2.5 py-1 text-[11px] font-semibold text-ok">
            <span className="size-1.5 rounded-[3px] bg-ok" /> Connected
          </span>
        </div>
        <span className="text-[13px] font-medium text-fg-2">API Key</span>
        <div className="flex h-[42px] items-center justify-between rounded-[10px] bg-shell border border-line-2 px-[15px]">
          <span className="text-[13px] text-fg-3">sk-••••••••••••••••••••••a3Fx</span>
          <span className="flex items-center gap-2">
            <Icon src="ap-eye.svg" className="size-3.5" />
            <Icon src="ap-copy-a.svg" className="size-3.5" />
          </span>
        </div>
      </div>
      <Divider />
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <ProviderLogo letter="A" className="bg-[#d4a574]" />
            <span className="text-[15px] font-semibold text-fg-1">Anthropic / Claude</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-[20px] bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-fg-3">
            <span className="size-1.5 rounded-[3px] bg-fg-3" /> Not Connected
          </span>
        </div>
        <span className="text-[13px] font-medium text-fg-2">API Key</span>
        <div className="flex h-[42px] items-center rounded-[10px] bg-shell border border-line-2 px-[15px]">
          <span className="text-[13px] text-fg-3">Enter your Anthropic API key...</span>
        </div>
        <span className="self-start flex items-center h-[33px] rounded-lg bg-panel-2 border border-line-2 px-4 text-[13px] font-medium text-fg-2">
          Connect
        </span>
      </div>
    </SettingsModal>
  );
}
