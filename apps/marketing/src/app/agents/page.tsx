"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import { CountUp } from "@/components/sections/FeatureVisuals";
import { type ReactNode } from "react";
import {
  SoftBlurIn,
  SpringScaleIn,
  PerCharacterRise,
  LineByLineSlide,
  MaskRevealUp,
  ShortSlideDown,
  AnimatedCard,
  StaggerContainer,
  StaggerItem,
} from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const agents = [
  {
    name: "Research Agent",
    description:
      "Scours the web, internal docs, and databases to surface the insights your team needs — fast. No more hours lost to manual searches.",
    tags: ["Web Search", "Document Analysis", "Summarization", "Citations"],
    href: "/agents/research",
    color: "#3b82f6",
    visual: "research" as const,
  },
  {
    name: "Design Agent",
    description:
      "Generates UI concepts, audits design systems, and translates wireframes into polished components aligned with your brand.",
    tags: ["UI Generation", "Design Systems", "Prototyping", "Brand Audit"],
    href: "/agents/design",
    color: "#8b5cf6",
    visual: "design" as const,
  },
  {
    name: "Sales Agent",
    description:
      "Qualifies leads, drafts outreach sequences, and keeps your pipeline moving while you focus on closing deals.",
    tags: ["Lead Scoring", "Email Sequences", "CRM Sync", "Pipeline Insights"],
    href: "/agents/sales",
    color: "#22d3ee",
    visual: "sales" as const,
  },
  {
    name: "Support Agent",
    description:
      "Handles tier-1 tickets, resolves known issues, and escalates edge cases to humans with full context attached.",
    tags: ["Ticket Triage", "Auto-Resolution", "Escalation", "Knowledge Base"],
    href: "/agents/support",
    color: "#10b981",
    visual: "support" as const,
  },
  {
    name: "Data Agent",
    description:
      "Connects to your warehouse, writes queries, and delivers dashboards and reports your team can actually understand.",
    tags: ["SQL Generation", "Dashboards", "Anomaly Detection", "Reporting"],
    href: "/agents/data",
    color: "#f59e0b",
    visual: "data" as const,
  },
  {
    name: "Automation Agent",
    description:
      "Orchestrates cross-tool workflows, schedules recurring jobs, and eliminates the busywork that slows your team down.",
    tags: ["Workflow Builder", "Scheduling", "Integrations", "Error Handling"],
    href: "/agents/automation",
    color: "#ef4444",
    visual: "automation" as const,
  },
];

const comparisonColumns = [
  {
    label: "Single AI",
    heading: "Single AI Assistant",
    features: [
      "General knowledge only",
      "One conversation thread",
      "Manual handoffs required",
      "Limited context window",
    ],
    accent: false,
  },
  {
    label: "Team",
    heading: "Agent Team",
    features: [
      "Specialized skills per domain",
      "Multiple parallel agents",
      "Better accuracy on tasks",
      "Separate, siloed contexts",
    ],
    accent: false,
  },
  {
    label: "OS",
    heading: "Agent OS",
    features: [
      "Shared persistent memory",
      "Cross-agent collaboration",
      "Unified workflow engine",
      "Human approval gates",
      "Full observability & audit",
    ],
    accent: true,
  },
];

/* ------------------------------------------------------------------ */
/*  Feature Section Data                                               */
/* ------------------------------------------------------------------ */

const agentFeatures = [
  {
    id: "reasoning",
    category: "Intelligence",
    titleDark: "Adaptive reasoning.",
    titleLight: "Not just pattern matching.",
    description:
      "Each agent uses multi-step reasoning to break down complex tasks. They plan ahead, evaluate options, and adapt their approach based on intermediate results — just like an experienced team member would.",
    features: [
      "Chain-of-thought planning before execution",
      "Dynamic strategy selection based on context",
      "Self-evaluation and error correction loops",
      "Confidence scoring on every output",
    ],
    accent: "#3b82f6",
    visual: "reasoning" as const,
  },
  {
    id: "memory",
    category: "Context",
    titleDark: "Persistent memory",
    titleLight: "across every interaction.",
    description:
      "Agents remember past conversations, decisions, and outcomes. They build a richer understanding of your team, your preferences, and your workflows over time — no repeated briefings, no lost context.",
    features: [
      "Long-term memory that spans sessions",
      "Working memory for active task context",
      "Shared memory across agent boundaries",
      "Automatic relevance ranking of past context",
    ],
    accent: "#8b5cf6",
    visual: "memory" as const,
  },
  {
    id: "tools",
    category: "Integrations",
    titleDark: "Connected to your tools.",
    titleLight: "Not just talking about them.",
    description:
      "Agents don't just describe what could be done — they do it. Direct API access to your stack lets them read data, write reports, send messages, update records, and push changes in real time.",
    features: [
      "500+ pre-built tool integrations",
      "Custom API connectors via SDK",
      "OAuth and API key management",
      "Rate limiting and retry logic built-in",
    ],
    accent: "#22d3ee",
    visual: "tools" as const,
  },
  {
    id: "collaboration",
    category: "Teamwork",
    titleDark: "Agents that collaborate.",
    titleLight: "Not just coexist.",
    description:
      "When one agent finishes its part, it passes full context to the next. Research feeds into analysis, analysis feeds into action. Your agent team operates like a well-coordinated unit with shared goals.",
    features: [
      "Automatic context handoff between agents",
      "Parallel execution with synchronization",
      "Conflict resolution when agents disagree",
      "Escalation paths for ambiguous decisions",
    ],
    accent: "#10b981",
    visual: "collaboration" as const,
  },
];

/* ------------------------------------------------------------------ */
/*  Agent Card Visual Components                                       */
/* ------------------------------------------------------------------ */

function ResearchVisual() {
  const sources = [
    { type: "Web", title: "Market Analysis Q4", relevance: 94 },
    { type: "Doc", title: "Competitor Pricing Sheet", relevance: 87 },
    { type: "DB", title: "Customer Survey Results", relevance: 82 },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-4"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="h-7 flex-1 bg-ink/[0.04] rounded-lg flex items-center px-3 gap-2">
          <svg className="w-3.5 h-3.5 text-ink/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <span className="text-[11px] text-ink/30 font-mono">competitor pricing strategy 2024</span>
        </div>
      </motion.div>
      {sources.map((s, i) => (
        <motion.div
          key={s.title}
          className="flex items-center gap-3 bg-white rounded-xl border border-ink/[0.06] px-3 py-2.5"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
        >
          <span className="text-[9px] font-bold uppercase tracking-wider text-blue-500 bg-blue-50 px-2 py-0.5 rounded-md flex-shrink-0">{s.type}</span>
          <span className="text-[12px] font-medium text-ink/70 flex-1 truncate">{s.title}</span>
          <span className="text-[10px] font-mono text-ink/25">{s.relevance}%</span>
        </motion.div>
      ))}
      <motion.div
        className="flex items-center gap-1.5 pt-1"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.3, delay: 0.5 }}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-[10px] text-ink/25">12 sources analyzed · 3 cited</span>
      </motion.div>
    </div>
  );
}

function DesignVisual() {
  const tokens = [
    { label: "Primary", value: "#3B82F6", swatch: "#3b82f6" },
    { label: "Surface", value: "#F8FAFC", swatch: "#f8fafc" },
    { label: "Accent", value: "#8B5CF6", swatch: "#8b5cf6" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-3"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="flex items-center gap-1.5 bg-violet-50 px-2.5 py-1 rounded-full">
          <div className="w-1.5 h-1.5 rounded-full bg-violet-500" />
          <span className="text-[10px] text-violet-600 font-semibold">Design System Audit</span>
        </div>
        <span className="text-[10px] text-ink/20 font-mono">3 issues found</span>
      </motion.div>
      <div className="flex gap-2">
        {tokens.map((t, i) => (
          <motion.div
            key={t.label}
            className="flex-1 bg-white rounded-xl border border-ink/[0.06] p-2.5 text-center"
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.35, delay: 0.2 + i * 0.06 }}
          >
            <div className="w-8 h-8 rounded-lg mx-auto mb-1.5 border border-ink/[0.06]" style={{ backgroundColor: t.swatch }} />
            <span className="text-[10px] font-medium text-ink/50 block">{t.label}</span>
            <span className="text-[9px] font-mono text-ink/20">{t.value}</span>
          </motion.div>
        ))}
      </div>
      <motion.div
        className="bg-white rounded-xl border border-ink/[0.06] p-2.5 flex items-center gap-2"
        initial={{ opacity: 0, y: 6 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.35, delay: 0.4 }}
      >
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-400 to-blue-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-medium text-ink/60 block">Button Component</span>
          <span className="text-[9px] text-ink/25">Updated to match brand spec</span>
        </div>
        <span className="text-[9px] text-emerald-500 font-semibold">✓ Fixed</span>
      </motion.div>
    </div>
  );
}

function SalesVisual() {
  const deals = [
    { name: "Acme Corp", stage: "Qualified", score: 87, value: "$42K" },
    { name: "Globex Inc", stage: "Proposal", score: 72, value: "$28K" },
    { name: "Initech", stage: "Negotiation", score: 65, value: "$65K" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center justify-between mb-3"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
          <span className="text-[10px] text-ink/30 font-semibold">Active Pipeline</span>
        </div>
        <span className="text-[11px] font-bold text-ink/60">$135K</span>
      </motion.div>
      {deals.map((d, i) => (
        <motion.div
          key={d.name}
          className="flex items-center gap-3 bg-white rounded-xl border border-ink/[0.06] px-3 py-2.5"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
        >
          <div className="flex-1 min-w-0">
            <span className="text-[12px] font-medium text-ink/70 block">{d.name}</span>
            <span className="text-[9px] text-ink/25">{d.stage}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-1.5 bg-ink/[0.04] rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-cyan-400"
                initial={{ width: 0 }}
                whileInView={{ width: `${d.score}%` }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.8, delay: 0.4 + i * 0.1 }}
              />
            </div>
            <span className="text-[11px] font-semibold text-ink/50 w-10 text-right">{d.value}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function SupportVisual() {
  const tickets = [
    { id: "#1284", subject: "Login timeout on mobile", status: "resolved", time: "2m" },
    { id: "#1285", subject: "Billing sync error", status: "escalated", time: "—" },
    { id: "#1286", subject: "API rate limit exceeded", status: "resolved", time: "45s" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center justify-between mb-3"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-emerald-50 px-2.5 py-1 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[10px] text-emerald-600 font-semibold">Auto-resolve: ON</span>
          </div>
        </div>
        <span className="text-[10px] text-ink/20 font-mono">3 tickets</span>
      </motion.div>
      {tickets.map((t, i) => (
        <motion.div
          key={t.id}
          className="flex items-center gap-3 bg-white rounded-xl border border-ink/[0.06] px-3 py-2.5"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
        >
          <span className="text-[10px] font-mono text-ink/25 flex-shrink-0">{t.id}</span>
          <span className="text-[12px] font-medium text-ink/60 flex-1 truncate">{t.subject}</span>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md flex-shrink-0 ${
            t.status === "resolved" ? "text-emerald-600 bg-emerald-50" : "text-amber-600 bg-amber-50"
          }`}>{t.status}</span>
          <span className="text-[10px] font-mono text-ink/20 w-6 text-right">{t.time}</span>
        </motion.div>
      ))}
    </div>
  );
}

function DataVisual() {
  return (
    <div className="space-y-3">
      <motion.div
        className="bg-ink/[0.03] rounded-lg p-2.5 mb-3"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <span className="text-[9px] font-mono text-ink/25 block mb-1">Generated SQL</span>
        <code className="text-[11px] font-mono text-amber-600/70 leading-relaxed">
          SELECT region, SUM(revenue)<br />
          FROM orders WHERE date &gt; &apos;2024-01&apos;<br />
          GROUP BY region ORDER BY 2 DESC
        </code>
      </motion.div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "North", value: "$2.4M", pct: 85 },
          { label: "West", value: "$1.8M", pct: 64 },
          { label: "East", value: "$1.2M", pct: 42 },
        ].map((r, i) => (
          <motion.div
            key={r.label}
            className="bg-white rounded-xl border border-ink/[0.06] p-2.5 text-center"
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.35, delay: 0.25 + i * 0.06 }}
          >
            <div className="w-full h-1 bg-ink/[0.04] rounded-full overflow-hidden mb-2">
              <motion.div
                className="h-full rounded-full bg-amber-400"
                initial={{ width: 0 }}
                whileInView={{ width: `${r.pct}%` }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.8, delay: 0.4 + i * 0.1 }}
              />
            </div>
            <span className="text-[12px] font-bold text-ink/70 block">{r.value}</span>
            <span className="text-[9px] text-ink/25">{r.label}</span>
          </motion.div>
        ))}
      </div>
      <motion.div
        className="flex items-center gap-1.5 pt-1"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.3, delay: 0.5 }}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-[10px] text-ink/25">Query executed in 240ms · 3 regions</span>
      </motion.div>
    </div>
  );
}

function AutomationVisual() {
  const nodes = [
    { label: "Trigger", icon: "⚡", status: "done" },
    { label: "Process", icon: "🔧", status: "done" },
    { label: "Review", icon: "👁", status: "active" },
    { label: "Deploy", icon: "🚀", status: "pending" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-3"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <span className="text-[10px] font-semibold text-ink/30">Workflow Run #247</span>
        <span className="text-[9px] text-ink/15 font-mono">· 12s elapsed</span>
      </motion.div>
      <div className="flex items-center gap-1">
        {nodes.map((n, i) => (
          <motion.div
            key={n.label}
            className="flex items-center gap-1 flex-1"
            initial={{ opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.2 + i * 0.08 }}
          >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-base flex-shrink-0 ${
              n.status === "done" ? "bg-emerald-50" :
              n.status === "active" ? "bg-blue-50" :
              "bg-ink/[0.03]"
            }`}>
              {n.status === "done" ? (
                <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              ) : n.status === "active" ? (
                <motion.div className="w-2.5 h-2.5 rounded-full bg-blue-500" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
              ) : (
                <span className="text-sm">{n.icon}</span>
              )}
            </div>
            {i < nodes.length - 1 && (
              <div className={`h-px flex-1 ${n.status === "done" ? "bg-emerald-200" : "bg-ink/[0.06]"}`} />
            )}
          </motion.div>
        ))}
      </div>
      <div className="flex gap-1">
        {nodes.map((n) => (
          <span key={n.label} className="flex-1 text-[9px] text-ink/25 text-center">{n.label}</span>
        ))}
      </div>
      <motion.div
        className="bg-white rounded-xl border border-ink/[0.06] px-3 py-2 flex items-center justify-between"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.3, delay: 0.5 }}
      >
        <span className="text-[10px] text-ink/35">Next scheduled</span>
        <span className="text-[10px] font-mono text-ink/20">in 4h 22m</span>
      </motion.div>
    </div>
  );
}

const agentVisualMap: Record<string, () => ReactNode> = {
  research: ResearchVisual,
  design: DesignVisual,
  sales: SalesVisual,
  support: SupportVisual,
  data: DataVisual,
  automation: AutomationVisual,
};

/* ------------------------------------------------------------------ */
/*  Feature Section Visual Components                                  */
/* ------------------------------------------------------------------ */

function ReasoningFeatureVisual({ accent }: { accent: string }) {
  const steps = [
    { name: "Analyze request", detail: "Intent classification", status: "done" as const },
    { name: "Plan approach", detail: "Multi-step strategy", status: "done" as const },
    { name: "Execute tasks", detail: "3 parallel actions", status: "active" as const },
    { name: "Verify output", detail: "Quality check", status: "pending" as const },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-4"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="flex items-center gap-1.5 bg-blue-50 px-2.5 py-1 rounded-full">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
          <span className="text-[10px] text-blue-600 font-semibold">Reasoning Trace</span>
        </div>
        <span className="text-[10px] text-ink/20 font-mono">92% confidence</span>
      </motion.div>
      {steps.map((s, i) => (
        <motion.div
          key={s.name}
          className="flex items-center gap-3"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.3, delay: 0.2 + i * 0.06 }}
        >
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
            s.status === "done" ? "bg-emerald-50" : s.status === "active" ? "bg-blue-50" : "bg-ink/[0.03]"
          }`}>
            {s.status === "done" ? (
              <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            ) : s.status === "active" ? (
              <motion.div className="w-2 h-2 rounded-full bg-blue-500" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-ink/10" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <span className={`text-[12px] font-medium ${s.status === "pending" ? "text-ink/25" : "text-ink/60"}`}>{s.name}</span>
            <span className={`text-[10px] ml-2 ${s.status === "pending" ? "text-ink/15" : "text-ink/25"}`}>{s.detail}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function MemoryFeatureVisual({ accent }: { accent: string }) {
  const memories = [
    { type: "Long-term", count: "128 docs", fill: 85, color: "#8b5cf6" },
    { type: "Working", count: "24 active", fill: 62, color: "#3b82f6" },
    { type: "Shared", count: "6 agents", fill: 47, color: "#10b981" },
  ];
  return (
    <div className="space-y-4">
      <motion.div
        className="flex items-center justify-between mb-2"
        initial={{ opacity: 0, y: -4 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink/25">Memory Utilization</span>
        <span className="text-[11px] font-bold text-violet-500">67%</span>
      </motion.div>
      {memories.map((m, i) => (
        <motion.div
          key={m.type}
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[12px] font-medium text-ink/50">{m.type}</span>
            <span className="text-[10px] font-mono text-ink/20">{m.count}</span>
          </div>
          <div className="h-2 bg-ink/[0.04] rounded-full overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: m.color, opacity: 0.5 }}
              initial={{ width: 0 }}
              whileInView={{ width: `${m.fill}%` }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 1, delay: 0.4 + i * 0.12 }}
            />
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function ToolsFeatureVisual({ accent }: { accent: string }) {
  const tools = [
    { name: "Slack", status: "connected" },
    { name: "GitHub", status: "connected" },
    { name: "Notion", status: "connected" },
    { name: "Linear", status: "syncing" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-3"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <motion.div className="w-2 h-2 rounded-full bg-emerald-400" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />
        <span className="text-[10px] text-ink/30">4 integrations active</span>
      </motion.div>
      {tools.map((t, i) => (
        <motion.div
          key={t.name}
          className="flex items-center gap-3 bg-white rounded-xl border border-ink/[0.06] px-3 py-2.5"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.06 }}
        >
          <div className="w-7 h-7 rounded-lg bg-ink/[0.03] flex items-center justify-center">
            <span className="text-[13px]">{t.name === "Slack" ? "💬" : t.name === "GitHub" ? "🐙" : t.name === "Notion" ? "📝" : "📋"}</span>
          </div>
          <span className="text-[12px] font-medium text-ink/60 flex-1">{t.name}</span>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
            t.status === "connected" ? "text-emerald-600 bg-emerald-50" : "text-blue-600 bg-blue-50"
          }`}>{t.status}</span>
        </motion.div>
      ))}
    </div>
  );
}

function CollaborationFeatureVisual({ accent }: { accent: string }) {
  const handoffs = [
    { from: "Research", to: "Analysis", context: "14 docs", status: "done" },
    { from: "Analysis", to: "Writer", context: "3 insights", status: "active" },
    { from: "Writer", to: "Review", context: "—", status: "pending" },
  ];
  return (
    <div className="space-y-3">
      <motion.div
        className="flex items-center gap-2 mb-3"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink/25">Agent Handoff Chain</span>
      </motion.div>
      {handoffs.map((h, i) => (
        <motion.div
          key={h.from}
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
        >
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 ${
            h.status === "done" ? "bg-emerald-50 text-emerald-600" : h.status === "active" ? "bg-blue-50 text-blue-600" : "bg-ink/[0.03] text-ink/25"
          }`}>{h.from}</span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <div className={`h-px w-4 ${h.status !== "pending" ? "bg-ink/10" : "bg-ink/[0.04]"}`} />
            <svg className={`w-3 h-3 ${h.status !== "pending" ? "text-ink/15" : "text-ink/[0.06]"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
          </div>
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 ${
            h.status === "done" ? "bg-emerald-50 text-emerald-600" : h.status === "active" ? "bg-blue-50 text-blue-600" : "bg-ink/[0.03] text-ink/25"
          }`}>{h.to}</span>
          <span className={`text-[9px] font-mono ml-auto ${h.status !== "pending" ? "text-ink/20" : "text-ink/10"}`}>{h.context}</span>
        </motion.div>
      ))}
    </div>
  );
}

const featureVisualMap: Record<string, (props: { accent: string }) => ReactNode> = {
  reasoning: ReasoningFeatureVisual,
  memory: MemoryFeatureVisual,
  tools: ToolsFeatureVisual,
  collaboration: CollaborationFeatureVisual,
};

/* ------------------------------------------------------------------ */
/*  Sections                                                           */
/* ------------------------------------------------------------------ */

function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[600px] rounded-full bg-electric/[0.07] blur-[160px]" />
        <div className="absolute right-1/4 bottom-1/4 w-[500px] h-[500px] rounded-full bg-violet-accent/[0.05] blur-[140px]" />
      </div>

      <div className="relative z-10 section-padding max-container w-full text-center">
        <div className="flex flex-col items-center">
          {/* Badge */}
          <SpringScaleIn
            as="span"
            delay={0.1}
            className="inline-flex items-center gap-2 rounded-xl border border-electric/20 bg-electric/[0.06] px-4 py-1.5 text-xs font-medium tracking-widest uppercase text-electric-light mb-8"
          >
            <span className="block w-1.5 h-1.5 rounded-full bg-electric animate-glow-pulse" />
            AI Agents
          </SpringScaleIn>

          {/* Headline */}
          <div className="max-w-5xl">
            <PerCharacterRise
              text="Meet the Agents"
              as="h1"
              className="text-display-xl font-bold text-ink"
              delay={0.15}
            />
            <PerCharacterRise
              text="That Move Work Forward"
              as="h1"
              className="text-display-xl font-bold gradient-text"
              delay={0.4}
            />
          </div>

          {/* Subtitle */}
          <SoftBlurIn
            as="p"
            delay={0.4}
            className="mt-8 max-w-2xl text-lg md:text-xl text-ink/50 leading-relaxed"
          >
            Six specialized AI agents that research, design, sell, support,
            analyze, and automate — so your team can focus on what matters.
          </SoftBlurIn>

          {/* CTAs */}
          <SoftBlurIn
            delay={0.6}
            className="mt-10 flex flex-col sm:flex-row items-center gap-4"
          >
            <Link
              href="#agents"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-3.5 text-sm font-semibold text-white transition-all hover:bg-ink/90"
            >
              Explore All Agents
              <svg
                className="w-4 h-4 transition-transform group-hover:translate-y-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-8 py-3.5 text-sm font-semibold text-ink transition-all hover:bg-surface"
            >
              Talk to Sales
            </Link>
          </SoftBlurIn>
        </div>
      </div>

      {/* Bottom edge */}
      <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-ink/[0.08] to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AgentShowcase() {
  return (
    <section
      id="agents"
      className="py-24 md:py-32 lg:py-40 border-b border-rule-dark"
    >
      <div className="section-padding max-container">
        {/* Section header */}
        <div className="mb-16 md:mb-20">
          <SpringScaleIn
            as="p"
            className="text-electric text-sm font-medium tracking-widest uppercase mb-4"
          >
            The Lineup
          </SpringScaleIn>
          <LineByLineSlide
            as="h2"
            text={"Six agents. One platform.\nInfinite leverage."}
            className="text-display-lg font-bold text-ink max-w-3xl"
          />
        </div>

        {/* Agent grid -- 2 cols on desktop */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          {agents.map((agent, i) => {
            const Visual = agentVisualMap[agent.visual];
            return (
              <AnimatedCard key={agent.name} index={i}>
                <Link href={agent.href} className="block group h-full">
                  <div className="relative h-full rounded-3xl bg-white border border-ink/[0.06] p-8 md:p-10 flex flex-col transition-all duration-300 hover:border-ink/[0.1] hover:shadow-[0_0_40px_rgba(59,130,246,0.06)]">
                    {/* Visual component */}
                    <div className="bg-[#f8f8f8] rounded-2xl border border-black/[0.06] p-5 md:p-6 mb-6">
                      {Visual && <Visual />}
                    </div>

                    {/* Name + description */}
                    <div className="flex-1">
                      <MaskRevealUp
                        as="h3"
                        className="text-2xl md:text-3xl font-bold text-ink mb-3"
                      >
                        {agent.name}
                      </MaskRevealUp>
                      <SoftBlurIn
                        as="p"
                        className="text-ink/50 leading-relaxed text-base md:text-lg max-w-md"
                      >
                        {agent.description}
                      </SoftBlurIn>
                    </div>

                    {/* Tags + link */}
                    <div className="mt-8">
                      <div className="flex flex-wrap gap-2 mb-6">
                        {agent.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-block rounded-lg bg-black/[0.05] border border-ink/[0.08] px-3 py-1 text-xs font-medium text-ink/60"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-electric-light transition-colors group-hover:text-ink">
                        View Agent
                        <svg
                          className="w-4 h-4 transition-transform group-hover:translate-x-1"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M17 8l4 4m0 0l-4 4m4-4H3"
                          />
                        </svg>
                      </span>
                    </div>
                  </div>
                </Link>
              </AnimatedCard>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AgentStatsSection() {
  return (
    <section className="py-24 md:py-32 border-b border-rule-dark">
      <div className="section-padding max-container">
        <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-px bg-black/[0.04] rounded-3xl overflow-hidden border border-black/[0.06]">
          {[
            { num: 6, suffix: "", label: "Specialized Agents" },
            { num: 500, suffix: "+", label: "Tool Integrations" },
            { num: 94, suffix: "%", label: "Avg Accuracy" },
            { num: 10, suffix: "×", label: "Faster Than Manual" },
          ].map((stat, i) => (
            <StaggerItem
              key={stat.label}
              className="p-8 md:p-10 text-center bg-white"
            >
              <div className="text-display-md font-bold mb-2">
                <CountUp
                  value={stat.num}
                  suffix={stat.suffix}
                  delay={0.1 + i * 0.12}
                  duration={1.4}
                  className="gradient-text"
                />
              </div>
              <div className="text-sm text-ink/40">{stat.label}</div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function HowAgentsThinkSection() {
  const steps = [
    {
      num: "01",
      title: "Perceive",
      description: "Agents observe triggers, messages, data changes, and user requests. They parse intent and extract the information needed to act.",
      color: "#3b82f6",
      details: ["Natural language understanding", "Event detection", "Context extraction"],
    },
    {
      num: "02",
      title: "Reason",
      description: "Using multi-step reasoning, agents plan their approach. They break complex tasks into sub-tasks and select the best strategy.",
      color: "#8b5cf6",
      details: ["Chain-of-thought planning", "Strategy selection", "Risk assessment"],
    },
    {
      num: "03",
      title: "Act",
      description: "Agents execute tasks using your tools and integrations. They read data, write outputs, send messages, and update systems in real time.",
      color: "#22d3ee",
      details: ["Tool execution", "API integrations", "Real-time data access"],
    },
    {
      num: "04",
      title: "Learn",
      description: "After every task, agents store context, outcomes, and feedback. They get better at your specific workflows over time.",
      color: "#10b981",
      details: ["Outcome tracking", "Memory updates", "Feedback loops"],
    },
  ];

  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark">
      <div ref={ref} className="section-padding max-container">
        {/* Header */}
        <div className="text-center mb-16 md:mb-20">
          <SpringScaleIn className="mb-4">
            <p className="text-electric text-sm font-medium tracking-wider uppercase">
              Agent Intelligence
            </p>
          </SpringScaleIn>
          <MaskRevealUp as="h2" className="text-display-md md:text-display-lg font-bold mb-6">
            <span className="text-ink">How agents think.</span>{" "}
            <span className="text-ink/35">Four steps to intelligent action.</span>
          </MaskRevealUp>
          <SoftBlurIn as="p" className="text-lg md:text-xl text-ink/50 max-w-2xl mx-auto">
            Every agent follows a consistent cognitive loop — perceive, reason, act, learn —
            getting smarter with every iteration.
          </SoftBlurIn>
        </div>

        {/* 4-step grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 30 }}
              animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
              transition={{ duration: 0.6, delay: i * 0.1, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="relative bg-white rounded-3xl border border-ink/[0.06] p-8"
            >
              {/* Number badge */}
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6 border"
                style={{ backgroundColor: `${step.color}08`, borderColor: `${step.color}20` }}
              >
                <span className="text-xl font-bold font-mono" style={{ color: step.color }}>{step.num}</span>
              </div>

              <h3 className="text-xl font-bold text-ink mb-3">{step.title}</h3>
              <p className="text-sm text-ink/50 leading-relaxed mb-5">{step.description}</p>

              {/* Detail pills */}
              <div className="flex flex-wrap gap-1.5">
                {step.details.map((d) => (
                  <span key={d} className="text-[11px] text-ink/35 bg-ink/[0.03] px-2.5 py-1 rounded-lg">{d}</span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AgentFeatureSection({ feature, index }: { feature: typeof agentFeatures[0]; index: number }) {
  const isReversed = index % 2 !== 0;
  const Visual = featureVisualMap[feature.visual];

  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark">
      <div className="section-padding max-container">
        <div className={`grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center ${isReversed ? "lg:[direction:rtl]" : ""}`}>
          {/* Text side */}
          <div className={isReversed ? "lg:[direction:ltr]" : ""}>
            <SpringScaleIn className="mb-4">
              <span className="text-sm font-medium tracking-wider uppercase" style={{ color: feature.accent }}>
                {feature.category}
              </span>
            </SpringScaleIn>

            <MaskRevealUp as="h2" className="text-3xl md:text-4xl lg:text-[2.75rem] font-bold leading-[1.15] mb-6">
              <span className="text-ink">{feature.titleDark}</span>{" "}
              <span className="text-ink/35">{feature.titleLight}</span>
            </MaskRevealUp>

            <SoftBlurIn as="p" className="text-lg text-ink/50 leading-relaxed mb-8 max-w-lg">
              {feature.description}
            </SoftBlurIn>

            {/* Left-border feature list */}
            <div className="space-y-4">
              {feature.features.map((f, i) => (
                <ShortSlideDown key={f} delay={0.1 + i * 0.06}>
                  <div className={`border-l-2 pl-5 py-1 ${i === 0 ? "" : "border-ink/[0.08]"}`}
                    style={i === 0 ? { borderColor: feature.accent } : undefined}
                  >
                    <span className="text-[15px] text-ink/60 leading-relaxed">{f}</span>
                  </div>
                </ShortSlideDown>
              ))}
            </div>
          </div>

          {/* Visual side */}
          <div className={isReversed ? "lg:[direction:ltr]" : ""}>
            <AnimatedCard hover={false}>
              <div className="bg-[#f8f8f8] rounded-3xl border border-black/[0.06] p-6 md:p-8">
                {Visual && <Visual accent={feature.accent} />}
              </div>
            </AnimatedCard>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function WhyAgentTeams() {
  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark relative">
      {/* Subtle gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white via-surface/40 to-white" />

      <div className="relative z-10 section-padding max-container">
        {/* Section header */}
        <div className="text-center mb-16 md:mb-20">
          <SpringScaleIn
            as="p"
            className="text-violet-accent text-sm font-medium tracking-widest uppercase mb-4"
          >
            The Evolution
          </SpringScaleIn>
          <MaskRevealUp as="h2" className="text-display-md font-bold mx-auto max-w-3xl mb-6">
            <span className="text-ink">Not one assistant.</span>{" "}
            <span className="text-ink/35">A team of agents.</span>
          </MaskRevealUp>
          <SoftBlurIn
            as="p"
            className="mt-2 text-lg text-ink/50 max-w-2xl mx-auto"
          >
            See how Agent OS compares to traditional single-AI setups and
            disconnected agent teams.
          </SoftBlurIn>
        </div>

        {/* 3-column comparison */}
        <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-ink/[0.08] border border-ink/[0.08] rounded-3xl overflow-hidden">
          {comparisonColumns.map((col, i) => (
            <AnimatedCard
              key={col.heading}
              index={i}
              hover={false}
              className={`p-8 md:p-10 lg:p-12 flex flex-col ${
                col.accent ? "bg-electric/[0.04]" : "bg-black/[0.02]"
              }`}
            >
              {/* Level indicator */}
              <div className="flex items-center gap-1.5 mb-6">
                {Array.from({ length: i + 1 }).map((_, j) => (
                  <div
                    key={j}
                    className={`w-2 h-2 rounded-full ${
                      col.accent ? "bg-electric" : "bg-ink/30"
                    }`}
                  />
                ))}
              </div>

              <span
                className={`text-xs font-semibold tracking-widest uppercase mb-2 ${
                  col.accent ? "text-electric" : "text-ink/50"
                }`}
              >
                {col.label}
              </span>

              <h3 className="text-2xl font-bold text-ink mb-4">
                {col.heading}
              </h3>

              <ul className="mt-2 space-y-3 flex-1">
                {col.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2.5 text-sm text-ink/60 leading-relaxed"
                  >
                    <svg
                      className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                        col.accent ? "text-electric" : "text-ink/30"
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              {col.accent && (
                <div className="mt-8">
                  <Link
                    href="/contact"
                    className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-ink/90"
                  >
                    Get Started
                  </Link>
                </div>
              )}
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function BuildYourOwnSection() {
  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark">
      <div className="section-padding max-container">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Text side */}
          <div>
            <SpringScaleIn className="mb-4">
              <span className="text-electric text-sm font-medium tracking-wider uppercase">
                Developer SDK
              </span>
            </SpringScaleIn>

            <MaskRevealUp as="h2" className="text-3xl md:text-4xl lg:text-[2.75rem] font-bold leading-[1.15] mb-6">
              <span className="text-ink">Build custom agents.</span>{" "}
              <span className="text-ink/35">Your logic, our infrastructure.</span>
            </MaskRevealUp>

            <SoftBlurIn as="p" className="text-lg text-ink/50 leading-relaxed mb-8 max-w-lg">
              Use the Agent OS SDK to create agents tailored to your exact use case.
              Define behaviors, connect tools, set guardrails, and deploy in minutes —
              with full TypeScript support and enterprise-grade reliability.
            </SoftBlurIn>

            {/* Left-border feature list */}
            <div className="space-y-4">
              {[
                "Full TypeScript SDK with type-safe APIs",
                "Custom tool definitions and API connectors",
                "Configurable memory, reasoning, and guardrails",
                "One-command deploy to managed infrastructure",
              ].map((f, i) => (
                <ShortSlideDown key={f} delay={0.1 + i * 0.06}>
                  <div className={`border-l-2 pl-5 py-1 ${i === 0 ? "border-electric" : "border-ink/[0.08]"}`}>
                    <span className="text-[15px] text-ink/60 leading-relaxed">{f}</span>
                  </div>
                </ShortSlideDown>
              ))}
            </div>
          </div>

          {/* Code preview */}
          <AnimatedCard hover={false}>
            <div className="bg-[#1a1a2e] rounded-3xl border border-white/[0.06] p-6 md:p-8 overflow-hidden">
              <div className="flex items-center gap-2 mb-5">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-white/10" />
                  <div className="w-3 h-3 rounded-full bg-white/10" />
                  <div className="w-3 h-3 rounded-full bg-white/10" />
                </div>
                <span className="text-[11px] text-white/20 font-mono ml-2">my-agent.ts</span>
              </div>
              <pre className="text-[12px] md:text-[13px] font-mono leading-relaxed overflow-x-auto">
                <code>
                  <span className="text-violet-400">import</span>
                  <span className="text-white/60"> {"{ Agent, Tool }"} </span>
                  <span className="text-violet-400">from</span>
                  <span className="text-emerald-400"> &apos;@agent-os/sdk&apos;</span>
                  {"\n\n"}
                  <span className="text-violet-400">const</span>
                  <span className="text-blue-300"> agent </span>
                  <span className="text-white/40">= </span>
                  <span className="text-violet-400">new</span>
                  <span className="text-yellow-300"> Agent</span>
                  <span className="text-white/40">({"{"}</span>
                  {"\n"}
                  <span className="text-white/30">  name: </span>
                  <span className="text-emerald-400">&apos;analyst&apos;</span>
                  <span className="text-white/40">,</span>
                  {"\n"}
                  <span className="text-white/30">  model: </span>
                  <span className="text-emerald-400">&apos;claude-4&apos;</span>
                  <span className="text-white/40">,</span>
                  {"\n"}
                  <span className="text-white/30">  memory: </span>
                  <span className="text-emerald-400">&apos;persistent&apos;</span>
                  <span className="text-white/40">,</span>
                  {"\n"}
                  <span className="text-white/30">  tools: </span>
                  <span className="text-white/40">[</span>
                  <span className="text-emerald-400">&apos;sql&apos;</span>
                  <span className="text-white/40">, </span>
                  <span className="text-emerald-400">&apos;slack&apos;</span>
                  <span className="text-white/40">, </span>
                  <span className="text-emerald-400">&apos;sheets&apos;</span>
                  <span className="text-white/40">],</span>
                  {"\n"}
                  <span className="text-white/40">{"})"}</span>
                  {"\n\n"}
                  <span className="text-violet-400">await</span>
                  <span className="text-blue-300"> agent</span>
                  <span className="text-white/40">.</span>
                  <span className="text-yellow-300">deploy</span>
                  <span className="text-white/40">()</span>
                </code>
              </pre>
            </div>
          </AnimatedCard>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function CTASection() {
  return (
    <section className="relative py-32 md:py-40 lg:py-48 overflow-hidden">
      {/* Gradient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-electric/[0.08] via-white to-violet-accent/[0.06]" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full bg-electric/[0.06] blur-[180px]" />
      </div>

      <div className="relative z-10 section-padding max-container text-center">
        <div className="flex flex-col items-center">
          <MaskRevealUp as="h2" className="text-display-lg font-bold max-w-3xl mb-6">
            <span className="text-ink">Ready to build</span>{" "}
            <span className="text-ink/35">your agent team?</span>
          </MaskRevealUp>

          <SoftBlurIn
            as="p"
            className="text-lg md:text-xl text-ink/50 max-w-xl"
          >
            Start with one agent. Scale to an intelligent workforce.
          </SoftBlurIn>

          <SoftBlurIn
            delay={0.2}
            className="mt-10 flex flex-col sm:flex-row items-center gap-4"
          >
            <Link
              href="/contact"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-4 text-sm font-semibold text-white transition-all hover:bg-ink/90"
            >
              Get Started
              <svg
                className="w-4 h-4 transition-transform group-hover:translate-x-1"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 8l4 4m0 0l-4 4m4-4H3"
                />
              </svg>
            </Link>
            <Link
              href="/platform"
              className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-8 py-4 text-sm font-semibold text-ink transition hover:bg-surface"
            >
              View Platform
            </Link>
          </SoftBlurIn>
        </div>
      </div>

      {/* Top edge */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-ink/[0.08] to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function AgentsPage() {
  return (
    <main>
      <HeroSection />
      <AgentShowcase />
      <AgentStatsSection />
      <HowAgentsThinkSection />
      {agentFeatures.map((feature, i) => (
        <AgentFeatureSection key={feature.id} feature={feature} index={i} />
      ))}
      <WhyAgentTeams />
      <BuildYourOwnSection />
      <CTASection />
    </main>
  );
}
