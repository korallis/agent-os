import type { Metadata } from "next";
import {
  SettingsModal,
  Field,
  Divider,
  SETTINGS_TABS,
} from "@/components/settings/SettingsModal";
import { Icon } from "@/components/shell/Icon";

export const metadata: Metadata = { title: "Settings — AgentOS" };

/**
 * Settings (§7.8) — the Figma "Settings: Workspace" screen carrying the
 * Phase 1 infrastructure values: orchestrator home, the config-locked
 * loopback bind, and the daemon token location. Team/billing/profile tabs
 * are pixel-faithful placeholders (multi-user lands post-Phase 6).
 */
export default function SettingsPage() {
  return (
    <SettingsModal
      heading="Settings"
      tabs={SETTINGS_TABS}
      activeTab="Workspace"
      title="Workspace"
      subtitle="Configure your workspace settings and preferences."
    >
      <Field
        label="Workspace Name"
        value="Agent OS"
        helper="The display name for your workspace across all projects."
      />
      <Divider />
      <Field
        label="Orchestrator Home"
        value="~/.agentos"
        muted
        helper="Event log, SQLite projection, config layers, and daemon token live here."
      />
      <Divider />
      <div className="flex gap-5">
        <div className="flex-1">
          <Field
            label="Bind Address"
            value="127.0.0.1:4700 🔒"
            helper="Loopback-only; the host is config-locked by design (§2)."
          />
        </div>
        <div className="flex-1">
          <Field
            label="Daemon Token"
            value="~/.agentos/daemon.token"
            muted
            trailing={<Icon src="st-chevron.svg" className="size-3.5" />}
            helper="0600 perms, re-asserted at every boot. Rotation lands in Phase 6."
          />
        </div>
      </div>
    </SettingsModal>
  );
}
