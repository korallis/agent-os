import type { Metadata } from "next";
import {
  SettingsModal,
  SETTINGS_TABS,
} from "@/components/settings/SettingsModal";
import { ProvidersPanel } from "@/components/providers/ProvidersPanel";

export const metadata: Metadata = { title: "API Providers — AgentOS" };

/**
 * Providers (§7.3 / Figma Settings · API Providers `41:6186`).
 * Live connection + quota probe wiring (Phase 2).
 */
export default function ProvidersPage() {
  return (
    <SettingsModal
      heading="Settings"
      tabs={SETTINGS_TABS}
      activeTab="API Providers"
      title="LLM API Configuration"
      subtitle="Connect and manage your AI model API keys and subscription OAuth."
    >
      <ProvidersPanel />
    </SettingsModal>
  );
}
