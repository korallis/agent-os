import type { Metadata } from "next";
import { cn } from "@agent-os/ui";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/shell/Icon";

export const metadata: Metadata = { title: "Token Usage — AgentOS" };

/* Pixel-faithful placeholder analytics from the Figma design — live quota
   probes and usage projections land in Phase 2 (§7.3, §11). */

const STATS = [
  { label: "Total Spend", value: "$23,094", delta: "-37.2%", deltaClass: "text-ok" },
  { label: "Tokens Used", value: "48.2M", delta: "-12.5%", deltaClass: "text-ok" },
  { label: "Avg Cost / Agent", value: "$1,924", delta: "+8.3%", deltaClass: "text-danger" },
  { label: "Budget Used", value: "57.7%", delta: "of $40K", deltaClass: "text-fg-3" },
] as const;

const BARS = [
  { day: "Mar 1", pct: 18 }, { day: "Mar 2", pct: 42 }, { day: "Mar 3", pct: 55 },
  { day: "Mar 4", pct: 62 }, { day: "Mar 5", pct: 58 }, { day: "Mar 6", pct: 70, selected: true },
  { day: "Mar 7", pct: 66 }, { day: "Mar 8", pct: 88 }, { day: "Mar 9", pct: 52 },
  { day: "Mar 10", pct: 60 }, { day: "Mar 11", pct: 72 }, { day: "Mar 12", pct: 48 },
] as const;

const AGENTS = [
  { name: "Coder Agent", dot: "bg-teal-brand", tokens: "14.2M", cost: "$6,840", share: "29.5%", trend: "-5.2%", trendClass: "text-ok" },
  { name: "Writer Agent", dot: "bg-electric", tokens: "11.8M", cost: "$5,420", share: "24.5%", trend: "+3.1%", trendClass: "text-danger" },
  { name: "Research Agent", dot: "bg-[#a855f7]", tokens: "8.6M", cost: "$4,130", share: "17.9%", trend: "-8.7%", trendClass: "text-ok" },
  { name: "QA Agent", dot: "bg-warn", tokens: "6.3M", cost: "$3,024", share: "13.1%", trend: "-2.4%", trendClass: "text-ok" },
  { name: "Data Agent", dot: "bg-teal-brand", tokens: "4.8M", cost: "$2,310", share: "10.0%", trend: "+12.1%", trendClass: "text-danger" },
] as const;

const MODELS = [
  { name: "claude-opus-4", dot: "bg-teal-brand", cost: "$12,480" },
  { name: "claude-sonnet-4", dot: "bg-electric", cost: "$7,240" },
  { name: "claude-haiku-4.5", dot: "bg-[#a855f7]", cost: "$3,374" },
] as const;

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("bg-panel border border-line-2 rounded-2xl", className)}>{children}</div>
  );
}

/**
 * Analytics (§7.7) — the Figma "Token Usage & Billing" screen. Static
 * placeholder figures until Phase 2 quota probes feed real usage.
 */
export default function AnalyticsPage() {
  return (
    <>
      <Topbar title="Token Usage" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-3">← Dashboard</span>
            <div className="flex items-center gap-2.5">
              <Icon src="trend-up.svg" className="size-5" />
              <h2 className="text-[22px] font-bold text-fg-1">Token Usage &amp; Billing</h2>
            </div>
            <p className="text-[13px] text-fg-2">
              Monitor token consumption, costs, and optimization across all agents
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-2 h-9 rounded-lg bg-panel border border-line-1 px-3.5 text-[13px] font-medium text-fg-1">
              <Icon src="calendar.svg" className="size-4" />
              Mar 1 – Mar 12, 2025
              <Icon src="ij-chevron.svg" className="size-3.5" />
            </span>
            <span className="flex items-center h-9 rounded-lg bg-panel border border-line-1 px-4 text-[13px] font-medium text-fg-1">
              Export
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {STATS.map((stat) => (
            <Card key={stat.label} className="p-5 flex flex-col gap-2">
              <span className="text-xs text-fg-2">{stat.label}</span>
              <span className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-fg-1">{stat.value}</span>
                <span className={cn("text-xs font-semibold", stat.deltaClass)}>{stat.delta}</span>
              </span>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
          <div className="flex flex-col gap-4">
            <Card className="p-6 flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-fg-1">Daily Token Consumption</h3>
                <div className="flex gap-0.5 bg-panel-2 border border-line-2 rounded-[10px] p-1">
                  {(["Tokens", "Cost", "Requests"] as const).map((label) => (
                    <span
                      key={label}
                      className={cn(
                        "px-4 py-1.5 rounded-lg text-xs",
                        label === "Tokens"
                          ? "bg-line-2 font-semibold text-fg-1"
                          : "font-medium text-fg-3",
                      )}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-3 h-[180px]">
                {BARS.map((bar) => (
                  <div key={bar.day} className="flex-1 flex flex-col items-center gap-2 h-full justify-end">
                    <div
                      className={cn(
                        "w-full rounded-t-md",
                        "selected" in bar && bar.selected
                          ? "bg-gradient-to-b from-[#3b82f6] to-[#1d4ed8]"
                          : "bg-gradient-to-b from-teal-brand to-teal-brand/40",
                      )}
                      style={{ height: `${bar.pct}%` }}
                    />
                    <span className="text-[10px] text-fg-3">{bar.day}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-fg-1">Usage by Agent</h3>
                <span className="text-xs font-medium text-teal-brand">View All</span>
              </div>
              <div className="flex items-center h-8 text-[11px] text-fg-3 border-b border-line-1">
                <span className="flex-1">Agent</span>
                <span className="w-[100px]">Tokens</span>
                <span className="w-[90px]">Cost</span>
                <span className="w-[80px]">% Share</span>
                <span className="w-[80px]">Trend</span>
              </div>
              {AGENTS.map((agent) => (
                <div key={agent.name} className="flex items-center text-xs">
                  <span className="flex-1 flex items-center gap-2 text-fg-1">
                    <span className={cn("size-2 rounded", agent.dot)} />
                    {agent.name}
                  </span>
                  <span className="w-[100px] text-fg-1">{agent.tokens}</span>
                  <span className="w-[90px] text-fg-1">{agent.cost}</span>
                  <span className="w-[80px] text-fg-2">{agent.share}</span>
                  <span className={cn("w-[80px] font-medium", agent.trendClass)}>{agent.trend}</span>
                </div>
              ))}
            </Card>
          </div>

          <div className="flex flex-col gap-4">
            <Card className="p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-fg-1">Cost by Model</h3>
                <span className="text-[11px] text-fg-3">This Month</span>
              </div>
              <div className="flex items-center justify-center py-2">
                <div
                  className="relative size-[150px] rounded-full"
                  style={{
                    background:
                      "conic-gradient(#2dd4bf 0deg 195deg, #3b82f6 195deg 308deg, #a855f7 308deg 360deg)",
                  }}
                >
                  <div className="absolute inset-[18px] rounded-full bg-panel flex flex-col items-center justify-center">
                    <span className="text-lg font-bold text-fg-1">$23K</span>
                    <span className="text-[10px] text-fg-3">total</span>
                  </div>
                </div>
              </div>
              {MODELS.map((model) => (
                <div key={model.name} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 text-fg-2">
                    <span className={cn("size-2 rounded", model.dot)} />
                    {model.name}
                  </span>
                  <span className="font-medium text-fg-1">{model.cost}</span>
                </div>
              ))}
            </Card>
            <Card className="p-5 flex flex-col gap-4">
              <h3 className="text-[15px] font-semibold text-fg-1">Budget &amp; Limits</h3>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-fg-3">Monthly Budget</span>
                  <span className="text-fg-1">$23,094 / $40,000</span>
                </div>
                <div className="h-1.5 rounded bg-line-2 overflow-hidden">
                  <div className="h-full w-[58%] rounded bg-gradient-to-r from-teal-brand to-electric" />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-fg-3">Daily Rate Limit</span>
                  <span className="text-fg-1">5M / 8M tokens</span>
                </div>
                <div className="h-1.5 rounded bg-line-2 overflow-hidden">
                  <div className="h-full w-[62%] rounded bg-warn" />
                </div>
              </div>
              <div className="rounded-lg bg-warn/[0.06] border border-warn/20 px-3 py-2 text-[11px] text-warn">
                ⚠ Daily limit at 62.5% — consider scaling
              </div>
            </Card>
            <Card className="p-5 flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-[15px] font-semibold text-fg-1">
                <Icon src="info.svg" className="size-4" />
                AI Optimization Tips
              </h3>
              <div className="rounded-lg bg-panel-2 border border-line-1 p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-fg-1">Switch to Haiku for QA</span>
                  <span className="font-semibold text-ok">Save ~$1.2K</span>
                </div>
                <p className="text-[11px] leading-4 text-fg-2">
                  QA Agent&apos;s tasks are well-suited for Haiku. Estimated 40% cost reduction.
                </p>
              </div>
              <div className="rounded-lg bg-panel-2 border border-line-1 p-3 flex items-center justify-between text-xs">
                <span className="font-semibold text-fg-1">Enable prompt caching</span>
                <span className="font-semibold text-ok">Save ~$800</span>
              </div>
            </Card>
          </div>
        </div>
      </main>
    </>
  );
}
