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
  MaskRevealUp,
  LineByLineSlide,
  ShortSlideDown,
  AnimatedCard,
  StaggerContainer,
  StaggerItem,
} from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Pipeline Data                                                      */
/* ------------------------------------------------------------------ */

const pipelineSteps = [
  { icon: "⚡", label: "Trigger", color: "#f59e0b", desc: "Events that start the flow" },
  { icon: "🤖", label: "Agent", color: "#3b82f6", desc: "AI that reasons and acts" },
  { icon: "🧠", label: "Memory", color: "#8b5cf6", desc: "Context that persists" },
  { icon: "🔧", label: "Tool", color: "#22d3ee", desc: "Integrations agents use" },
  { icon: "✅", label: "Approval", color: "#10b981", desc: "Human checkpoints" },
  { icon: "🎯", label: "Action", color: "#ec4899", desc: "Tasks agents execute" },
  { icon: "📊", label: "Report", color: "#f97316", desc: "Results delivered to you" },
];

/* ------------------------------------------------------------------ */
/*  Workflow Types Data                                                 */
/* ------------------------------------------------------------------ */

const workflowTypes = [
  {
    id: "trigger",
    category: "Event-Driven",
    titleDark: "Set triggers.",
    titleLight: "Agents respond instantly.",
    description:
      "Define events that automatically kick off agent workflows. A new Slack message, a form submission, a webhook, or a calendar invite — any event becomes a launchpad for intelligent action.",
    features: [
      "Webhooks, API events, and third-party triggers",
      "Conditional branching based on event data",
      "Sub-second response times on critical events",
      "Chain multiple triggers for complex scenarios",
    ],
    accent: "#f59e0b",
    visual: "trigger" as const,
  },
  {
    id: "multi-agent",
    category: "Orchestration",
    titleDark: "Multiple agents.",
    titleLight: "One coordinated workflow.",
    description:
      "Orchestrate teams of specialized agents that pass context, share memory, and collaborate on complex tasks. A Research Agent feeds a Design Agent, which briefs a Sales Agent — all automated.",
    features: [
      "Shared memory across agent boundaries",
      "Parallel execution with synchronization",
      "Specialized agents for each domain",
      "Automatic context handoff between steps",
    ],
    accent: "#8b5cf6",
    visual: "multi-agent" as const,
  },
  {
    id: "approval",
    category: "Governance",
    titleDark: "Human checkpoints",
    titleLight: "at critical moments.",
    description:
      "Insert review points anywhere in a workflow. Before an agent sends an email, publishes content, or modifies data, it pauses and waits for your explicit approval. Full control, zero surprises.",
    features: [
      "Configurable approval thresholds",
      "Multi-reviewer support with escalation",
      "Audit trail for every decision",
      "Timeout rules with fallback actions",
    ],
    accent: "#10b981",
    visual: "approval" as const,
  },
  {
    id: "scheduled",
    category: "Scheduling",
    titleDark: "Time-based automation",
    titleLight: "that never sleeps.",
    description:
      "Run workflows on any cadence — daily market scans, weekly competitor reports, monthly analytics summaries. Set the schedule once, and agents deliver results on time, every time.",
    features: [
      "Cron-style scheduling with timezone support",
      "Recurring daily, weekly, and monthly cadences",
      "Missed-run recovery and retry logic",
      "Calendar-aware smart scheduling",
    ],
    accent: "#3b82f6",
    visual: "scheduled" as const,
  },
  {
    id: "hitl",
    category: "Collaboration",
    titleDark: "Agents propose.",
    titleLight: "Humans decide.",
    description:
      "Design collaborative workflows where agents and humans work together in real time. Agents draft, humans refine. Agents research, humans decide. The best of both intelligences, working in concert.",
    features: [
      "Real-time collaborative editing with agents",
      "Inline suggestions with accept/reject controls",
      "Escalation paths for edge cases",
      "Feedback loops that improve agent accuracy",
    ],
    accent: "#ec4899",
    visual: "hitl" as const,
  },
];

/* ------------------------------------------------------------------ */
/*  Hero Section                                                       */
/* ------------------------------------------------------------------ */

function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-white" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full opacity-30 blur-[140px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(59,130,246,0.3) 0%, rgba(139,92,246,0.15) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container text-center py-32 md:py-40">
        {/* Badge */}
        <SpringScaleIn delay={0.1} className="mb-8">
          <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-electric border border-electric/20 rounded-full px-5 py-2 bg-electric/5">
            Workflows
          </span>
        </SpringScaleIn>

        {/* Title */}
        <div className="mb-8 max-w-5xl mx-auto">
          <PerCharacterRise
            text="Design Workflows"
            as="h1"
            className="text-display-xl font-bold text-ink"
            delay={0.15}
          />
          <PerCharacterRise
            text="Agents Can Execute"
            as="h1"
            className="text-display-xl font-bold gradient-text"
            delay={0.4}
          />
        </div>

        {/* Subtitle */}
        <SoftBlurIn delay={0.4} as="p" className="text-xl md:text-2xl text-ink/50 max-w-2xl mx-auto mb-12 leading-relaxed">
          Connect triggers, tools, approvals, and actions into intelligent
          automated flows that run on autopilot.
        </SoftBlurIn>

        {/* CTAs */}
        <SoftBlurIn delay={0.6} className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="#pipeline"
            className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-white bg-ink hover:bg-ink/90 rounded-full transition-colors duration-200"
          >
            See the Pipeline
          </Link>
          <Link
            href="/platform"
            className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-ink/60 border border-ink/10 hover:border-ink/20 hover:text-ink rounded-full transition-all duration-200"
          >
            Explore Platform
          </Link>
        </SoftBlurIn>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-white to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Pipeline Visual Section                                            */
/* ------------------------------------------------------------------ */

function PipelineSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section
      id="pipeline"
      ref={ref}
      className="py-24 md:py-32 border-b border-rule"
    >
      <div className="section-padding max-container">
        {/* Section heading */}
        <div className="text-center mb-16 md:mb-20">
          <SpringScaleIn className="mb-4">
            <p className="text-electric text-sm font-medium tracking-wider uppercase">
              How It Works
            </p>
          </SpringScaleIn>

          <PerCharacterRise
            text="The Agent Pipeline"
            as="h2"
            className="text-display-lg font-bold text-ink mb-6"
          />

          <SoftBlurIn as="p" className="text-xl text-ink/50 max-w-2xl mx-auto">
            Every workflow follows a clear path from trigger to result.
            Seven stages, infinite possibilities.
          </SoftBlurIn>
        </div>

        {/* Pipeline — numbered step grid */}
        <div className="relative">
          {/* Connecting line behind step numbers */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={inView ? { scaleX: 1 } : { scaleX: 0 }}
            transition={{ duration: 1.2, delay: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="absolute top-[42px] left-[10%] right-[10%] h-px bg-gradient-to-r from-transparent via-black/[0.08] to-transparent origin-left hidden lg:block"
          />

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-4 lg:gap-3">
            {pipelineSteps.map((step, i) => (
              <motion.div
                key={step.label}
                initial={{ opacity: 0, y: 24 }}
                animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
                transition={{
                  duration: 0.5,
                  delay: i * 0.07,
                  ease: [0.25, 0.46, 0.45, 0.94],
                }}
                className="group relative flex flex-col items-center text-center"
              >
                {/* Step number */}
                <div
                  className="relative z-10 w-[84px] h-[84px] rounded-xl flex items-center justify-center mb-5 border transition-all duration-500 group-hover:scale-105 group-hover:shadow-lg"
                  style={{
                    backgroundColor: `${step.color}08`,
                    borderColor: `${step.color}20`,
                  }}
                >
                  <span
                    className="text-[28px] font-bold font-mono tracking-tight"
                    style={{ color: step.color }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                {/* Label */}
                <h3 className="text-[15px] font-semibold text-ink mb-1.5">
                  {step.label}
                </h3>
                <p className="text-[12px] text-ink/40 leading-relaxed max-w-[140px]">
                  {step.desc}
                </p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Stats row */}
        <StaggerContainer className="mt-16 md:mt-20 grid grid-cols-2 md:grid-cols-4 gap-px bg-black/[0.04] rounded-3xl overflow-hidden border border-black/[0.06]">
          {[
            { num: 7, suffix: "", prefix: "", label: "Pipeline Stages" },
            { num: 50, suffix: "ms", prefix: "<", label: "Trigger Latency" },
            { num: 500, suffix: "+", prefix: "", label: "Tool Integrations" },
            { num: 99.9, suffix: "%", prefix: "", label: "Uptime SLA" },
          ].map((stat, i) => (
            <StaggerItem
              key={stat.label}
              className="p-8 md:p-10 text-center bg-white"
            >
              <div className="text-display-md font-bold mb-2">
                <CountUp value={stat.num} suffix={stat.suffix} prefix={stat.prefix} delay={0.1 + i * 0.12} duration={1.4} className="gradient-text" />
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
/*  Workflow Visual Components                                         */
/* ------------------------------------------------------------------ */

function TriggerVisual({ accent }: { accent: string }) {
  const sources = [
    { icon: "💬", name: "Slack", detail: "New message" },
    { icon: "🔗", name: "Webhook", detail: "POST /api" },
    { icon: "📅", name: "Calendar", detail: "Event invite" },
  ];
  return (
    <div className="space-y-4">
      <motion.div
        className="text-[11px] font-semibold uppercase tracking-wider text-ink/25"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
      >
        Event Sources
      </motion.div>
      <div className="grid grid-cols-3 gap-3">
        {sources.map((src, i) => (
          <motion.div
            key={src.name}
            className="bg-white rounded-xl p-4 text-center border border-black/[0.04]"
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: 0.1 + i * 0.08 }}
          >
            <div className="text-xl mb-2">{src.icon}</div>
            <div className="text-[12px] font-semibold text-ink/70">{src.name}</div>
            <div className="text-[10px] text-ink/30 mt-0.5 font-mono">{src.detail}</div>
          </motion.div>
        ))}
      </div>

      {/* Connector line */}
      <div className="flex justify-center">
        <motion.div
          className="flex flex-col items-center gap-1"
          initial={{ opacity: 0, scaleY: 0 }}
          whileInView={{ opacity: 1, scaleY: 1 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.4, delay: 0.4 }}
          style={{ transformOrigin: "top" }}
        >
          <div className="w-px h-6" style={{ backgroundColor: accent + "40" }} />
          <div className="w-2 h-2 rotate-45" style={{ backgroundColor: accent + "40" }} />
        </motion.div>
      </div>

      {/* Triggered badge */}
      <motion.div
        className="flex items-center justify-center gap-3 rounded-xl p-4 border"
        style={{ backgroundColor: accent + "08", borderColor: accent + "20" }}
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.55 }}
      >
        <motion.div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: accent }}
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="text-[13px] font-semibold" style={{ color: accent }}>
          Workflow Triggered
        </span>
        <span className="text-[10px] text-ink/20 font-mono ml-auto">2.3s ago</span>
      </motion.div>
    </div>
  );
}

function MultiAgentVisual({ accent }: { accent: string }) {
  const agents = [
    { name: "Research Agent", role: "Gathering market data", status: "done" as const },
    { name: "Analysis Agent", role: "Processing insights", status: "active" as const },
    { name: "Writer Agent", role: "Waiting for input", status: "pending" as const },
  ];
  return (
    <div className="space-y-0">
      <motion.div
        className="text-[11px] font-semibold uppercase tracking-wider text-ink/25 mb-4"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
      >
        Agent Pipeline
      </motion.div>
      {agents.map((agent, i) => (
        <div key={agent.name}>
          <motion.div
            className="bg-white rounded-xl p-4 border border-black/[0.04] flex items-center gap-4"
            initial={{ opacity: 0, x: -16 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: 0.1 + i * 0.12 }}
          >
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{
                backgroundColor:
                  agent.status === "done"
                    ? "#10b98110"
                    : agent.status === "active"
                    ? accent + "15"
                    : "#0a0a0a06",
              }}
            >
              {agent.status === "done" ? (
                <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : agent.status === "active" ? (
                <motion.div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: accent }}
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                />
              ) : (
                <div className="w-2.5 h-2.5 rounded-full bg-ink/10" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-ink/80">{agent.name}</div>
              <div className="text-[11px] text-ink/30 mt-0.5">{agent.role}</div>
            </div>
            <span
              className="text-[10px] font-mono px-2 py-1 rounded-full"
              style={{
                color:
                  agent.status === "done"
                    ? "#10b981"
                    : agent.status === "active"
                    ? accent
                    : "#0a0a0a40",
                backgroundColor:
                  agent.status === "done"
                    ? "#10b98110"
                    : agent.status === "active"
                    ? accent + "10"
                    : "#0a0a0a06",
              }}
            >
              {agent.status === "done" ? "Complete" : agent.status === "active" ? "Running" : "Queued"}
            </span>
          </motion.div>

          {/* Connector */}
          {i < agents.length - 1 && (
            <div className="flex items-center gap-2 pl-8 py-1">
              <div className="w-px h-5" style={{ backgroundColor: accent + "25" }} />
              <span className="text-[9px] text-ink/20 font-mono">context handoff</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ApprovalVisual({ accent }: { accent: string }) {
  return (
    <div className="space-y-4">
      <motion.div
        className="text-[11px] font-semibold uppercase tracking-wider text-ink/25"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
      >
        Pending Approval
      </motion.div>

      {/* Approval card */}
      <motion.div
        className="bg-white rounded-xl p-5 border border-black/[0.04] space-y-4"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div>
          <div className="text-[14px] font-semibold text-ink/80">
            Send quarterly report email
          </div>
          <div className="text-[11px] text-ink/30 mt-1 flex items-center gap-3">
            <span>Agent: <span className="text-ink/50">Analytics Bot</span></span>
            <span className="w-1 h-1 rounded-full bg-ink/15" />
            <span>Risk: <span style={{ color: accent }}>Medium</span></span>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <motion.div
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[12px] font-semibold text-white cursor-pointer"
            style={{ backgroundColor: accent }}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.3 }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Approve
          </motion.div>
          <motion.div
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[12px] font-semibold text-ink/40 border border-ink/10 cursor-pointer"
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.35 }}
          >
            Reject
          </motion.div>
        </div>
      </motion.div>

      {/* Audit trail */}
      <motion.div
        className="space-y-2"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.5 }}
      >
        {[
          { step: "Data collection", status: "Approved", time: "2m ago" },
          { step: "Analysis complete", status: "Approved", time: "1m ago" },
          { step: "Email draft", status: "Pending", time: "Now" },
        ].map((entry) => (
          <div key={entry.step} className="flex items-center gap-3 text-[11px]">
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor: entry.status === "Approved" ? "#10b981" : accent,
              }}
            />
            <span className="text-ink/40 flex-1">{entry.step}</span>
            <span
              className="font-mono"
              style={{
                color: entry.status === "Approved" ? "#10b981" : accent,
              }}
            >
              {entry.status}
            </span>
            <span className="text-ink/20 font-mono">{entry.time}</span>
          </div>
        ))}
      </motion.div>
    </div>
  );
}

function ScheduleVisual({ accent }: { accent: string }) {
  return (
    <div className="space-y-4">
      <motion.div
        className="text-[11px] font-semibold uppercase tracking-wider text-ink/25"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
      >
        Schedule Config
      </motion.div>

      {/* Cron expression */}
      <motion.div
        className="bg-white rounded-xl p-4 border border-black/[0.04]"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="font-mono text-[15px] font-bold text-ink/70 mb-1">
          0 9 * * MON-FRI
        </div>
        <div className="text-[11px] text-ink/30">Every weekday at 9:00 AM UTC</div>
      </motion.div>

      {/* Upcoming runs */}
      <motion.div
        className="space-y-2"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.3 }}
      >
        <div className="text-[11px] font-semibold text-ink/30 mb-3">Upcoming Runs</div>
        {[
          { day: "Mon, Jun 2", time: "9:00 AM", next: true },
          { day: "Tue, Jun 3", time: "9:00 AM", next: false },
          { day: "Wed, Jun 4", time: "9:00 AM", next: false },
        ].map((run, i) => (
          <motion.div
            key={run.day}
            className="flex items-center gap-3 py-2 px-3 rounded-lg"
            style={run.next ? { backgroundColor: accent + "08" } : {}}
            initial={{ opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.35 + i * 0.08 }}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: run.next ? accent : "#0a0a0a15" }}
            />
            <span className={`text-[12px] flex-1 ${run.next ? "font-semibold text-ink/70" : "text-ink/35"}`}>
              {run.day}
            </span>
            <span className="text-[11px] font-mono text-ink/25">{run.time}</span>
          </motion.div>
        ))}
      </motion.div>

      {/* Stats */}
      <motion.div
        className="flex items-center gap-2 pt-2"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.6 }}
      >
        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-[11px] text-ink/30">
          <span className="font-semibold text-ink/50">247</span> successful runs
        </span>
      </motion.div>
    </div>
  );
}

function HITLVisual({ accent }: { accent: string }) {
  return (
    <div className="space-y-4">
      <motion.div
        className="text-[11px] font-semibold uppercase tracking-wider text-ink/25"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
      >
        Agent Suggestion
      </motion.div>

      {/* Draft text with highlighted suggestion */}
      <motion.div
        className="bg-white rounded-xl p-5 border border-black/[0.04] space-y-4"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="text-[13px] text-ink/50 leading-relaxed">
          Based on the analysis, I recommend{" "}
          <span
            className="font-semibold px-1 py-0.5 rounded"
            style={{ color: accent, backgroundColor: accent + "12" }}
          >
            pricing at $49/mo
          </span>{" "}
          for the starter tier. This positions us competitively while maintaining{" "}
          <span
            className="font-semibold px-1 py-0.5 rounded"
            style={{ color: accent, backgroundColor: accent + "12" }}
          >
            healthy margins above 72%
          </span>
          .
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <motion.div
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-semibold text-white"
            style={{ backgroundColor: accent }}
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.35 }}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Accept
          </motion.div>
          <motion.div
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-semibold text-ink/35 border border-ink/10"
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.4 }}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
            </svg>
            Edit
          </motion.div>
          <motion.div
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-semibold text-ink/35 border border-ink/10"
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.3, delay: 0.45 }}
          >
            Reject
          </motion.div>
        </div>
      </motion.div>

      {/* Confidence */}
      <motion.div
        className="flex items-center gap-4"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.55 }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />
          <span className="text-[11px] text-ink/30">
            Confidence: <span className="font-semibold" style={{ color: accent }}>92%</span>
          </span>
        </div>
        <span className="text-[11px] text-ink/20 font-mono">12 data points</span>
      </motion.div>
    </div>
  );
}

const workflowVisualMap: Record<string, (props: { accent: string }) => ReactNode> = {
  trigger: TriggerVisual,
  "multi-agent": MultiAgentVisual,
  approval: ApprovalVisual,
  scheduled: ScheduleVisual,
  hitl: HITLVisual,
};

/* ------------------------------------------------------------------ */
/*  Workflow Type Feature Section (single)                             */
/* ------------------------------------------------------------------ */

function WorkflowFeatureSection({
  workflow,
  index,
  reversed,
}: {
  workflow: (typeof workflowTypes)[number];
  index: number;
  reversed: boolean;
}) {
  const VisualComponent = workflowVisualMap[workflow.visual];

  return (
    <section className="py-24 md:py-32 border-b border-rule">
      <div className="section-padding max-container">
        <div
          className={`grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center ${
            reversed ? "lg:direction-rtl" : ""
          }`}
          style={reversed ? { direction: "rtl" } : undefined}
        >
          {/* Text column */}
          <div style={{ direction: "ltr" }}>
            {/* Category label */}
            <SpringScaleIn className="mb-6">
              <span
                className="inline-block text-xs font-semibold tracking-[0.15em] uppercase rounded-full px-4 py-1.5"
                style={{
                  color: workflow.accent,
                  backgroundColor: `${workflow.accent}12`,
                  border: `1px solid ${workflow.accent}25`,
                }}
              >
                {workflow.category}
              </span>
            </SpringScaleIn>

            {/* Two-tone heading */}
            <MaskRevealUp as="h2" className="mb-6">
              <span className="text-display-sm font-bold leading-[1.1] tracking-tight">
                <span className="text-ink">{workflow.titleDark}</span>{" "}
                <span className="text-ink/35">{workflow.titleLight}</span>
              </span>
            </MaskRevealUp>

            {/* Description */}
            <SoftBlurIn
              as="p"
              delay={0.1}
              className="text-lg text-ink/50 leading-relaxed mb-10"
            >
              {workflow.description}
            </SoftBlurIn>

            {/* Features — left-border accent style */}
            <StaggerContainer className="space-y-0">
              {workflow.features.map((feat, i) => (
                <StaggerItem key={feat}>
                  <div
                    className="flex items-center gap-4 py-3 border-l-2 pl-5"
                    style={{
                      borderColor: i === 0 ? workflow.accent : "rgba(0,0,0,0.06)",
                    }}
                  >
                    <span
                      className={`text-[15px] ${
                        i === 0
                          ? "font-semibold text-ink/70"
                          : "text-ink/40"
                      }`}
                    >
                      {feat}
                    </span>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </div>

          {/* Visual column — custom component */}
          <div style={{ direction: "ltr" }}>
            <motion.div
              className="bg-[#f8f8f8] rounded-3xl border border-black/[0.06] p-6 md:p-8"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.6, delay: 0.15 }}
            >
              {VisualComponent && <VisualComponent accent={workflow.accent} />}
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  CTA Section                                                        */
/* ------------------------------------------------------------------ */

function CTASection() {
  return (
    <section className="py-24 md:py-40 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-surface" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full opacity-10 blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(59,130,246,0.3) 0%, rgba(139,92,246,0.1) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container text-center">
        {/* Heading */}
        <LineByLineSlide
          text={"Build Your First\nWorkflow"}
          as="h2"
          className="text-display-lg font-bold gradient-text mb-6"
        />

        {/* Description */}
        <SoftBlurIn
          delay={0.3}
          as="p"
          className="text-xl md:text-2xl text-ink/50 max-w-xl mx-auto mb-12 leading-relaxed"
        >
          Design intelligent automation in minutes. Connect triggers, agents,
          approvals, and actions into flows that just work.
        </SoftBlurIn>

        {/* Buttons */}
        <SoftBlurIn delay={0.5} className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/contact"
            className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-white bg-ink hover:bg-ink/90 rounded-full transition-colors duration-200"
          >
            Build a Workflow
          </Link>
          <Link
            href="/integrations"
            className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-ink/60 border border-ink/10 hover:border-ink/20 hover:text-ink rounded-full transition-all duration-200"
          >
            See Integrations
          </Link>
        </SoftBlurIn>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function WorkflowsPage() {
  return (
    <main>
      <HeroSection />
      <PipelineSection />

      {/* Workflow Types — each gets its own full section */}
      {workflowTypes.map((wf, i) => (
        <WorkflowFeatureSection
          key={wf.id}
          workflow={wf}
          index={i}
          reversed={i % 2 === 1}
        />
      ))}

      <CTASection />
    </main>
  );
}
