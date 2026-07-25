import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { BillingView } from "@/components/settings/BillingView";

export const metadata: Metadata = { title: "Billing — AgentOS" };

/** Settings · Billing — Figma frame `41:6309`. */
export default function BillingPage() {
  return (
    <>
      <Topbar title="Billing" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-bold text-fg-1">Billing &amp; budgets</h2>
          <p className="text-[13px] text-fg-2">
            How each connection bills, what it has reported, and the ceilings you have set
          </p>
        </div>
        <BillingView />
      </main>
    </>
  );
}
