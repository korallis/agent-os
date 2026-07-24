"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import {
  fadeUp,
  staggerContainer,
  staggerContainerSlow,
} from "@agent-os/ui";
import AnimatedHeadline from "@/components/ui/AnimatedHeadline";
import { MagneticButton } from "@agent-os/ui";
import { GlassCard } from "@agent-os/ui";
import PageHero from "@/components/sections/PageHero";
import { CountUp } from "@/components/sections/FeatureVisuals";
import { cn } from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const architectureLayers = [
  {
    title: "Memory Layer",
    description:
      "Persistent, contextual memory that spans conversations, sessions, and agents. Every interaction builds a richer understanding of your workflows.",
    icon: "🧠",
    accent: "#8b5cf6",
  },
  {
    title: "Reasoning Engine",
    description:
      "Multi-step reasoning that plans, evaluates, and adapts. Agents don't just respond — they think through problems before acting.",
    icon: "💡",
    accent: "#3b82f6",
  },
  {
    title: "Tool Execution",
    description:
      "Direct integration with your tools and APIs. Agents read, write, query, and push data across your entire stack in real time.",
    icon: "🔧",
    accent: "#22d3ee",
  },
  {
    title: "Human Approval",
    description:
      "Configurable approval gates that ensure humans stay in the loop. Define when agents can act autonomously and when they must ask.",
    icon: "✋",
    accent: "#10b981",
  },
  {
    title: "Analytics",
    description:
      "Full observability into agent behavior, decisions, performance, and resource usage. Every action is tracked and auditable.",
    icon: "📊",
    accent: "#f59e0b",
  },
  {
    title: "Permissions",
    description:
      "Granular access controls defining what each agent can see, touch, and modify. Role-based security at every layer of the system.",
    icon: "🔒",
    accent: "#ef4444",
  },
];

const controlFeatures = [
  {
    icon: "⚡",
    title: "Agents Can Act",
    description:
      "Deploy agents that execute tasks end-to-end — from research to reporting, outreach to operations — without constant hand-holding.",
  },
  {
    icon: "🛡️",
    title: "Humans Stay in Control",
    description:
      "Every workflow can include approval checkpoints. You define the boundaries; agents respect them unconditionally.",
  },
  {
    icon: "📋",
    title: "Every Action Is Logged",
    description:
      "Full audit trail of every decision, tool call, data access, and output. Complete transparency at every level.",
  },
  {
    icon: "✅",
    title: "Every Workflow Can Require Approval",
    description:
      "Set approval gates at any step. Critical decisions always pass through a human before execution.",
  },
];

const howItWorksSteps = [
  {
    num: "01",
    title: "Define Your Workflow",
    description:
      "Start by mapping out what you need — triggers, agents, tools, and approval gates. Use our visual builder or the SDK to design multi-step flows.",
    detail: "Drag-and-drop builder or code-first with full TypeScript SDK",
    accent: "#3b82f6",
  },
  {
    num: "02",
    title: "Connect Your Stack",
    description:
      "Plug in the tools your team already uses. Slack, GitHub, Notion, Salesforce, custom APIs — agents speak your stack natively.",
    detail: "500+ integrations, custom webhooks, and OAuth support",
    accent: "#8b5cf6",
  },
  {
    num: "03",
    title: "Set Boundaries",
    description:
      "Define what each agent can access, when it needs approval, and what data it can touch. Granular permissions at every layer.",
    detail: "Role-based access, approval gates, and data policies",
    accent: "#10b981",
  },
  {
    num: "04",
    title: "Deploy & Monitor",
    description:
      "Launch agents into production with full observability. Watch decisions in real time, review audit logs, and optimize performance.",
    detail: "Real-time dashboards, alerts, and performance analytics",
    accent: "#f59e0b",
  },
];

const platformStats = [
  { value: 99.9, suffix: "%", label: "Uptime SLA", decimals: 1 },
  { value: 50, prefix: "<", suffix: "ms", label: "Avg Latency", decimals: 0 },
  { value: 500, suffix: "+", label: "Integrations", decimals: 0 },
  { value: 10, suffix: "M+", label: "Tasks Executed", decimals: 0 },
];

const securityFeatures = [
  {
    title: "SOC 2 Type II",
    description: "Independently audited controls for security, availability, and confidentiality.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    color: "#10b981",
  },
  {
    title: "GDPR Compliant",
    description: "Full data residency controls, right to erasure, and processing agreements.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
    color: "#3b82f6",
  },
  {
    title: "End-to-End Encryption",
    description: "AES-256 encryption at rest and TLS 1.3 in transit. Zero-knowledge architecture.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
    color: "#8b5cf6",
  },
  {
    title: "Role-Based Access",
    description: "Granular permissions for every agent, user, and workflow. Least-privilege by default.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
    color: "#f59e0b",
  },
  {
    title: "Audit Logging",
    description: "Immutable logs of every agent decision, tool call, and data access with full context.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
    color: "#ec4899",
  },
  {
    title: "Data Isolation",
    description: "Tenant-level data isolation with dedicated encryption keys and network boundaries.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
    color: "#ef4444",
  },
];

const developerFeatures = [
  { title: "TypeScript SDK", detail: "Fully typed client with IntelliSense support" },
  { title: "REST & GraphQL", detail: "Choose the API style that fits your stack" },
  { title: "Webhook Events", detail: "Real-time notifications for every agent action" },
  { title: "CLI Tools", detail: "Deploy and manage agents from your terminal" },
  { title: "SSO & OAuth", detail: "Enterprise auth out of the box" },
  { title: "Rate Limiting", detail: "Built-in throttling with configurable quotas" },
];

/* ------------------------------------------------------------------ */
/*  Sections                                                           */
/* ------------------------------------------------------------------ */

function CoreLayersSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32 relative">
      <div className="section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-20"
        >
          <motion.p
            variants={fadeUp}
            className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
          >
            Architecture
          </motion.p>
          <motion.h2
            variants={fadeUp}
            className="text-display-md font-bold text-ink mb-4"
          >
            Six Layers. One System.
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="text-lg text-ink/50 max-w-2xl mx-auto"
          >
            Every layer works together to give agents the ability to reason, act,
            and stay accountable.
          </motion.p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-black/[0.04] rounded-3xl overflow-hidden border border-ink/[0.06]">
          {architectureLayers.map((layer, i) => (
            <motion.div
              key={layer.title}
              initial={{ opacity: 0, y: 30 }}
              animate={
                inView
                  ? { opacity: 1, y: 0 }
                  : { opacity: 0, y: 30 }
              }
              transition={{
                duration: 0.6,
                delay: i * 0.08,
                ease: [0.25, 0.46, 0.45, 0.94],
              }}
              className="group relative bg-white p-8 md:p-10 transition-colors duration-500 hover:bg-surface"
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 transition-transform duration-500 group-hover:scale-110"
                style={{ backgroundColor: `${layer.accent}15`, border: `1px solid ${layer.accent}25` }}
              >
                <span className="text-2xl">{layer.icon}</span>
              </div>

              <h3 className="text-lg font-semibold text-ink mb-3">
                {layer.title}
              </h3>
              <p className="text-[14px] text-ink/40 leading-relaxed">
                {layer.description}
              </p>

              <div
                className="absolute bottom-0 left-8 right-8 h-px opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                style={{ background: `linear-gradient(90deg, transparent, ${layer.accent}40, transparent)` }}
              />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  How It Works — numbered step flow                                  */
/* ------------------------------------------------------------------ */

function HowItWorksSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32 border-t border-rule">
      <div className="section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-20"
        >
          <motion.p
            variants={fadeUp}
            className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
          >
            How It Works
          </motion.p>
          <motion.h2 variants={fadeUp} className="text-display-md font-bold mb-4">
            <span className="text-ink">From idea to production</span>{" "}
            <span className="text-ink/35">in four steps.</span>
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="text-lg text-ink/50 max-w-2xl mx-auto"
          >
            Go from concept to deployed agents in minutes, not months. Every step
            is designed for speed without sacrificing control.
          </motion.p>
        </motion.div>

        <div className="max-w-4xl mx-auto space-y-0">
          {howItWorksSteps.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, x: -20 }}
              animate={inView ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ duration: 0.5, delay: 0.15 + i * 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="flex gap-6 md:gap-10"
            >
              {/* Step rail */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-lg"
                  style={{ backgroundColor: step.accent }}
                >
                  {step.num}
                </div>
                {i < howItWorksSteps.length - 1 && (
                  <div className="w-px flex-1 my-2" style={{ backgroundColor: step.accent + "25" }} />
                )}
              </div>

              {/* Step content */}
              <div className="flex-1 pb-12 md:pb-16">
                <h3 className="text-xl md:text-2xl font-bold text-ink mb-3">
                  {step.title}
                </h3>
                <p className="text-ink/50 leading-relaxed mb-4 max-w-lg">
                  {step.description}
                </p>
                <div
                  className="inline-flex items-center gap-2 text-[13px] font-medium px-4 py-2 rounded-full"
                  style={{
                    color: step.accent,
                    backgroundColor: step.accent + "10",
                    border: `1px solid ${step.accent}20`,
                  }}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: step.accent }} />
                  {step.detail}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Platform Stats                                                     */
/* ------------------------------------------------------------------ */

function PlatformStatsSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-16 md:py-20 border-t border-b border-rule bg-surface">
      <div className="section-padding max-container">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
          {platformStats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="text-center"
            >
              <div className="text-display-md font-bold mb-2">
                <CountUp
                  value={stat.value}
                  suffix={stat.suffix}
                  prefix={stat.prefix || ""}
                  decimals={stat.decimals}
                  delay={0.1 + i * 0.12}
                  duration={1.4}
                  className="gradient-text"
                />
              </div>
              <div className="text-sm text-ink/40">{stat.label}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Developer Experience                                               */
/* ------------------------------------------------------------------ */

function DeveloperExperienceSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32">
      <div className="section-padding max-container">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Text column */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate={inView ? "visible" : "hidden"}
          >
            <motion.p
              variants={fadeUp}
              className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
            >
              Developer Experience
            </motion.p>
            <motion.h2 variants={fadeUp} className="text-display-sm font-bold mb-6">
              <span className="text-ink">Build with code.</span>{" "}
              <span className="text-ink/35">Ship with confidence.</span>
            </motion.h2>
            <motion.p
              variants={fadeUp}
              className="text-lg text-ink/50 leading-relaxed mb-10"
            >
              A fully typed TypeScript SDK, comprehensive REST APIs, and CLI tools
              that let you define, test, and deploy agent workflows entirely in code.
              No vendor lock-in, no black boxes.
            </motion.p>

            <motion.div variants={fadeUp} className="space-y-0">
              {developerFeatures.map((feat, i) => (
                <div
                  key={feat.title}
                  className="flex items-center gap-4 py-3 border-l-2 pl-5"
                  style={{ borderColor: i === 0 ? "#3b82f6" : "rgba(0,0,0,0.06)" }}
                >
                  <span className={cn("text-[14px]", i === 0 ? "font-semibold text-ink/70" : "text-ink/40")}>
                    {feat.title}
                  </span>
                  <span className="text-[12px] text-ink/25 font-mono hidden md:inline">
                    {feat.detail}
                  </span>
                </div>
              ))}
            </motion.div>
          </motion.div>

          {/* Code preview visual */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="bg-[#0a0a0a] rounded-3xl p-6 md:p-8 overflow-hidden"
          >
            {/* Window chrome */}
            <div className="flex items-center gap-2 mb-6">
              <div className="w-3 h-3 rounded-full bg-white/10" />
              <div className="w-3 h-3 rounded-full bg-white/10" />
              <div className="w-3 h-3 rounded-full bg-white/10" />
              <span className="text-[11px] font-mono text-white/20 ml-3">agent-workflow.ts</span>
            </div>

            {/* Code content */}
            <pre className="text-[13px] md:text-[14px] font-mono leading-relaxed overflow-x-auto">
              <code>
                <span className="text-violet-400">import</span>
                <span className="text-white/60">{" { "}</span>
                <span className="text-cyan-300">Agent</span>
                <span className="text-white/60">{", "}</span>
                <span className="text-cyan-300">Workflow</span>
                <span className="text-white/60">{" } "}</span>
                <span className="text-violet-400">from</span>
                <span className="text-emerald-400">{" '@agent-os/sdk'"}</span>
                <span className="text-white/30">;</span>
                {"\n\n"}
                <span className="text-violet-400">const</span>
                <span className="text-white/80">{" researcher "}</span>
                <span className="text-white/30">= </span>
                <span className="text-violet-400">new</span>
                <span className="text-cyan-300">{" Agent"}</span>
                <span className="text-white/30">{"({"}</span>
                {"\n"}
                <span className="text-white/40">{"  name: "}</span>
                <span className="text-emerald-400">{"'Research Agent'"}</span>
                <span className="text-white/30">,</span>
                {"\n"}
                <span className="text-white/40">{"  tools: "}</span>
                <span className="text-white/30">[</span>
                <span className="text-emerald-400">{"'web'"}</span>
                <span className="text-white/30">{", "}</span>
                <span className="text-emerald-400">{"'notion'"}</span>
                <span className="text-white/30">{", "}</span>
                <span className="text-emerald-400">{"'slack'"}</span>
                <span className="text-white/30">],</span>
                {"\n"}
                <span className="text-white/40">{"  memory: "}</span>
                <span className="text-amber-300">true</span>
                <span className="text-white/30">,</span>
                {"\n"}
                <span className="text-white/40">{"  approval: "}</span>
                <span className="text-emerald-400">{"'on-send'"}</span>
                <span className="text-white/30">,</span>
                {"\n"}
                <span className="text-white/30">{"})"}</span>
                <span className="text-white/30">;</span>
                {"\n\n"}
                <span className="text-violet-400">const</span>
                <span className="text-white/80">{" flow "}</span>
                <span className="text-white/30">= </span>
                <span className="text-violet-400">new</span>
                <span className="text-cyan-300">{" Workflow"}</span>
                <span className="text-white/30">{"({"}</span>
                {"\n"}
                <span className="text-white/40">{"  trigger: "}</span>
                <span className="text-emerald-400">{"'slack.message'"}</span>
                <span className="text-white/30">,</span>
                {"\n"}
                <span className="text-white/40">{"  steps: "}</span>
                <span className="text-white/30">[</span>
                <span className="text-white/60">researcher</span>
                <span className="text-white/30">],</span>
                {"\n"}
                <span className="text-white/30">{"})"}</span>
                <span className="text-white/30">;</span>
                {"\n\n"}
                <span className="text-white/60">flow</span>
                <span className="text-white/30">.</span>
                <span className="text-amber-300">deploy</span>
                <span className="text-white/30">();</span>
                {"\n"}
                <span className="text-white/20">{"// → Agent deployed ✓"}</span>
              </code>
            </pre>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Security & Compliance                                              */
/* ------------------------------------------------------------------ */

function SecuritySection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32 border-t border-rule">
      <div className="section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-20"
        >
          <motion.p
            variants={fadeUp}
            className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
          >
            Security & Compliance
          </motion.p>
          <motion.h2 variants={fadeUp} className="text-display-md font-bold mb-4">
            <span className="text-ink">Enterprise-grade trust.</span>{" "}
            <span className="text-ink/35">Built into every layer.</span>
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="text-lg text-ink/50 max-w-2xl mx-auto"
          >
            Security isn&apos;t a feature — it&apos;s the foundation. Every agent action
            is encrypted, logged, permissioned, and auditable.
          </motion.p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-black/[0.04] rounded-3xl overflow-hidden border border-ink/[0.06]">
          {securityFeatures.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 24 }}
              animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              className="bg-white p-8 md:p-10 group hover:bg-surface transition-colors duration-300"
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                style={{ backgroundColor: feature.color + "10", color: feature.color }}
              >
                {feature.icon}
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{feature.title}</h3>
              <p className="text-[14px] text-ink/40 leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Agent Lifecycle — explaining how agents work under the hood        */
/* ------------------------------------------------------------------ */

function AgentLifecycleSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  const phases = [
    {
      phase: "Perceive",
      description: "Agents receive triggers from your stack — a Slack message, a webhook, a schedule firing. Context is loaded from memory and the current session.",
      items: ["Event ingestion", "Context retrieval", "Memory hydration"],
      accent: "#3b82f6",
    },
    {
      phase: "Reason",
      description: "The reasoning engine plans a multi-step approach, evaluates strategies, and selects the optimal path. Chain-of-thought is fully traceable.",
      items: ["Strategy planning", "Tool selection", "Risk assessment"],
      accent: "#8b5cf6",
    },
    {
      phase: "Act",
      description: "Agents execute against your tools — reading data, writing documents, sending messages, calling APIs. Each action is permissioned and logged.",
      items: ["Tool execution", "API calls", "Data operations"],
      accent: "#f59e0b",
    },
    {
      phase: "Learn",
      description: "Results are evaluated, memory is updated, and performance metrics are tracked. Every cycle makes the next one smarter.",
      items: ["Result evaluation", "Memory update", "Performance logging"],
      accent: "#10b981",
    },
  ];

  return (
    <section ref={ref} className="py-20 md:py-32 border-t border-rule bg-surface">
      <div className="section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-20"
        >
          <motion.p
            variants={fadeUp}
            className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
          >
            Agent Lifecycle
          </motion.p>
          <motion.h2 variants={fadeUp} className="text-display-md font-bold mb-4">
            <span className="text-ink">Perceive. Reason. Act. Learn.</span>
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="text-lg text-ink/50 max-w-2xl mx-auto"
          >
            Every agent follows a continuous loop — receiving context, planning an
            approach, executing with precision, and improving from the result.
          </motion.p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {phases.map((phase, i) => (
            <motion.div
              key={phase.phase}
              initial={{ opacity: 0, y: 30 }}
              animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
              transition={{ duration: 0.5, delay: 0.15 + i * 0.1 }}
              className="bg-white rounded-2xl p-7 border border-black/[0.06]"
            >
              {/* Phase number + name */}
              <div className="flex items-center gap-3 mb-5">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                  style={{ backgroundColor: phase.accent }}
                >
                  {String(i + 1).padStart(2, "0")}
                </div>
                <h3 className="text-lg font-bold text-ink">{phase.phase}</h3>
              </div>

              <p className="text-[14px] text-ink/45 leading-relaxed mb-6">
                {phase.description}
              </p>

              {/* Items */}
              <div className="space-y-2">
                {phase.items.map((item) => (
                  <div key={item} className="flex items-center gap-2.5">
                    <div
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: phase.accent }}
                    />
                    <span className="text-[13px] text-ink/40">{item}</span>
                  </div>
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
/*  Why Agent OS — comparison/value props                              */
/* ------------------------------------------------------------------ */

function WhyAgentOSSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  const comparisons = [
    {
      challenge: "Agents that hallucinate and go off-script",
      solution: "Bounded autonomy with approval gates and permission scopes",
    },
    {
      challenge: "No visibility into what agents are doing",
      solution: "Full audit trail with real-time decision tracing",
    },
    {
      challenge: "Building from scratch with raw LLM APIs",
      solution: "Production-ready SDK with memory, tools, and orchestration",
    },
    {
      challenge: "Data scattered across disconnected tools",
      solution: "500+ native integrations with unified data layer",
    },
    {
      challenge: "Scaling agents without breaking things",
      solution: "Enterprise infrastructure with 99.9% uptime SLA",
    },
  ];

  return (
    <section ref={ref} className="py-20 md:py-32 border-t border-rule">
      <div className="section-padding max-container">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
          {/* Text column */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate={inView ? "visible" : "hidden"}
          >
            <motion.p
              variants={fadeUp}
              className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
            >
              Why Agent OS
            </motion.p>
            <motion.h2 variants={fadeUp} className="text-display-sm font-bold mb-6">
              <span className="text-ink">The problem with AI agents today</span>{" "}
              <span className="text-ink/35">and how we solve it.</span>
            </motion.h2>
            <motion.p variants={fadeUp} className="text-lg text-ink/50 leading-relaxed mb-8">
              Most agent frameworks give you raw building blocks and wish you luck.
              Agent OS gives you a complete operating system — memory, reasoning,
              permissions, tools, and execution — so you can deploy agents that
              actually work in production.
            </motion.p>
            <motion.div variants={fadeUp}>
              <Link
                href="/contact"
                className="inline-flex items-center justify-center px-7 py-3.5 text-[15px] font-semibold text-white bg-ink hover:bg-ink/90 rounded-full transition-colors"
              >
                Talk to Us
              </Link>
            </motion.div>
          </motion.div>

          {/* Comparison cards */}
          <div className="space-y-4">
            {comparisons.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: 16 }}
                animate={inView ? { opacity: 1, x: 0 } : { opacity: 0, x: 16 }}
                transition={{ duration: 0.4, delay: 0.2 + i * 0.08 }}
                className="bg-[#f8f8f8] rounded-2xl p-5 border border-black/[0.04]"
              >
                <div className="flex items-start gap-3 mb-2">
                  <div className="w-5 h-5 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-red-400 text-[10px]">✕</span>
                  </div>
                  <span className="text-[14px] text-ink/40 line-through decoration-ink/15">
                    {item.challenge}
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-[14px] text-ink/70 font-medium">
                    {item.solution}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Controlled Autonomy — existing section                             */
/* ------------------------------------------------------------------ */

function ControlledAutonomySection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32 relative overflow-hidden">
      {/* Background accent */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full opacity-20 blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(59,130,246,0.3) 0%, rgba(139,92,246,0.15) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-16"
        >
          <motion.p
            variants={fadeUp}
            className="text-electric text-sm font-medium tracking-wider uppercase mb-4"
          >
            Philosophy
          </motion.p>
          <AnimatedHeadline
            text={"Built for\nControlled Autonomy"}
            as="h2"
            className="text-display-md font-bold gradient-text mb-4"
          />
          <motion.p
            variants={fadeUp}
            className="text-xl text-ink/50 max-w-2xl mx-auto"
          >
            Agents should be powerful enough to act on their own, but
            transparent enough that you never lose oversight.
          </motion.p>
        </motion.div>

        <motion.div
          variants={staggerContainerSlow}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto"
        >
          {controlFeatures.map((feature) => (
            <motion.div key={feature.title} variants={fadeUp}>
              <GlassCard className="p-8 h-full">
                <span className="text-4xl mb-5 block">{feature.icon}</span>
                <h3 className="text-xl font-bold text-ink mb-3">
                  {feature.title}
                </h3>
                <p className="text-ink/50 text-sm leading-relaxed">
                  {feature.description}
                </p>
              </GlassCard>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  CTA                                                                */
/* ------------------------------------------------------------------ */

function CTASection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-40 relative overflow-hidden">
      <div className="absolute inset-0 bg-surface" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-electric/5 blur-[100px]" />

      <div className="relative z-10 section-padding max-container text-center">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
        >
          <motion.h2
            variants={fadeUp}
            className="text-display-md font-bold text-ink mb-6"
          >
            See the Platform in Action
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="text-xl text-ink/50 max-w-xl mx-auto mb-10"
          >
            Experience intelligent agents running on a system built for trust,
            speed, and control.
          </motion.p>
          <motion.div variants={fadeUp} className="flex flex-wrap items-center justify-center gap-4">
            <MagneticButton href="/contact" variant="primary" size="lg">
              Request a Demo
            </MagneticButton>
            <MagneticButton href="/agents" variant="secondary" size="lg">
              Explore Agents
            </MagneticButton>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function PlatformPage() {
  return (
    <main>
      <PageHero
        badge="Platform"
        title={"The Operating System\nfor AI Agents"}
        subtitle="Memory, reasoning, permissions, tools, and execution — connected in one intelligent layer."
      >
        <MagneticButton href="#architecture" variant="primary" size="lg">
          Explore the Architecture
        </MagneticButton>
        <MagneticButton href="/workflows" variant="secondary" size="lg">
          See Workflows
        </MagneticButton>
      </PageHero>

      <div id="architecture">
        <CoreLayersSection />
      </div>
      <HowItWorksSection />
      <PlatformStatsSection />
      <DeveloperExperienceSection />
      <AgentLifecycleSection />
      <SecuritySection />
      <WhyAgentOSSection />
      <ControlledAutonomySection />
      <CTASection />
    </main>
  );
}
