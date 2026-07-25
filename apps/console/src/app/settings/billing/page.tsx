import type { Metadata } from "next";
import {
  SettingsModal,
  SETTINGS_TABS,
} from "@/components/settings/SettingsModal";
import { BillingView } from "@/components/settings/BillingView";

export const metadata: Metadata = { title: "Billing — AgentOS" };

/** Settings · Billing — Figma frame `41:6309`. */
export default function BillingPage() {
  return (
    <SettingsModal
      heading="Settings"
      tabs={SETTINGS_TABS}
      activeTab="Billing"
      title="Billing & budgets"
      subtitle="How each connection bills, what it has reported, and the ceilings you have set."
    >
      <BillingView />
    </SettingsModal>
  );
}
