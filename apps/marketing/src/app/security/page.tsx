"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import {
  SoftBlurIn,
  SpringScaleIn,
  PerCharacterRise,
  LineByLineSlide,
  MaskRevealUp,
  MaskRevealImage,
  AnimatedCard,
} from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const securityFeatures = [
  {
    image:
      "https://images.unsplash.com/photo-1633265486064-086b219458ec?w=800&h=500&fit=crop&q=80",
    title: "Role-Based Access",
    description:
      "Define granular permissions per agent, per team, per workflow. Every action respects your org hierarchy.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&h=500&fit=crop&q=80",
    title: "Human Approval",
    description:
      "Set approval gates on sensitive actions. Agents pause and wait for human sign-off before proceeding.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&h=500&fit=crop&q=80",
    title: "Audit Logs",
    description:
      "Every agent decision, API call, and data access is logged with timestamps and full context trails.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&h=500&fit=crop&q=80",
    title: "Data Encryption",
    description:
      "AES-256 at rest, TLS 1.3 in transit. Your data is encrypted end-to-end across every layer of the stack.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=800&h=500&fit=crop&q=80",
    title: "Safe Execution",
    description:
      "Agents run in isolated sandboxes with resource limits. No agent can access systems outside its scope.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&h=500&fit=crop&q=80",
    title: "Workspace Permissions",
    description:
      "Separate environments for teams, projects, and clients. Cross-workspace access requires explicit grants.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800&h=500&fit=crop&q=80",
    title: "Private Memory",
    description:
      "Agent memory is scoped and encrypted. Knowledge from one workspace never leaks into another.",
  },
  {
    image:
      "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&h=500&fit=crop&q=80",
    title: "Compliance Ready",
    description:
      "SOC 2 Type II, GDPR, and HIPAA compliant. Export audit trails and data inventories on demand.",
  },
];

const principles = [
  {
    icon: "👁️",
    title: "Full Visibility",
    description: "See every action in real-time. Nothing happens in the dark.",
  },
  {
    icon: "↩️",
    title: "Reversible Actions",
    description:
      "Every automated action can be undone. Nothing is permanent without your say.",
  },
  {
    icon: "📏",
    title: "Your Rules",
    description:
      "You set the boundaries. Agents operate within your governance framework.",
  },
  {
    icon: "🚫",
    title: "Zero Trust",
    description:
      "Every request is verified. No implicit trust between agents or systems.",
  },
];

const auditLogEntries = [
  {
    time: "2:34 PM",
    agent: "Research",
    action: "Queried external API",
    status: "approved",
  },
  {
    time: "2:33 PM",
    agent: "Sales",
    action: "Sent follow-up email",
    status: "approved",
  },
  {
    time: "2:31 PM",
    agent: "Data",
    action: "Exported CSV report",
    status: "pending",
  },
  {
    time: "2:30 PM",
    agent: "Automation",
    action: "Triggered Slack workflow",
    status: "approved",
  },
  {
    time: "2:28 PM",
    agent: "Support",
    action: "Accessed customer record",
    status: "approved",
  },
  {
    time: "2:25 PM",
    agent: "Design",
    action: "Generated asset batch",
    status: "denied",
  },
  {
    time: "2:22 PM",
    agent: "Research",
    action: "Scraped competitor page",
    status: "approved",
  },
];

/* ------------------------------------------------------------------ */
/*  Sections                                                           */
/* ------------------------------------------------------------------ */

function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full bg-violet-accent/[0.07] blur-[160px]" />
        <div className="absolute right-1/3 bottom-1/4 w-[500px] h-[400px] rounded-full bg-electric/[0.05] blur-[140px]" />
      </div>

      <div className="relative z-10 section-padding max-container w-full text-center">
        <div className="flex flex-col items-center">
          {/* Badge */}
          <SpringScaleIn
            as="span"
            delay={0.1}
            className="inline-flex items-center gap-2 rounded-full border border-violet-accent/20 bg-violet-accent/[0.06] px-4 py-1.5 text-xs font-medium tracking-widest uppercase text-violet-soft mb-8"
          >
            <span className="block w-1.5 h-1.5 rounded-full bg-violet-accent animate-glow-pulse" />
            Security
          </SpringScaleIn>

          {/* Headline */}
          <div className="max-w-4xl">
            <PerCharacterRise
              text="Autonomy"
              as="h1"
              className="text-display-xl font-bold text-ink"
              delay={0.15}
            />
            <PerCharacterRise
              text="With Control"
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
            Agent OS is built with permissions, visibility, approval flows, and
            auditability at the core. Your agents are powerful -- and governed.
          </SoftBlurIn>

          {/* CTAs */}
          <SoftBlurIn delay={0.6} className="mt-10 flex flex-col sm:flex-row items-center gap-4">
            <Link
              href="#security-grid"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-3.5 text-sm font-semibold text-white transition-all hover:bg-ink/90"
            >
              Review Security
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
              Talk to Security Team
            </Link>
          </SoftBlurIn>
        </div>
      </div>

      {/* Bottom edge */}
      <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-black/[0.08] to-transparent" />
    </section>
  );
}

function SecurityGrid() {
  return (
    <section
      id="security-grid"
      className="py-24 md:py-32 lg:py-40 border-b border-rule"
    >
      <div className="section-padding max-container">
        {/* Section header */}
        <div className="mb-16 md:mb-20">
          <SpringScaleIn
            as="p"
            className="text-violet-accent text-sm font-medium tracking-widest uppercase mb-4"
          >
            Security Infrastructure
          </SpringScaleIn>
          <LineByLineSlide
            as="h2"
            text={"Enterprise-grade security\nat every layer."}
            className="text-display-lg font-bold text-ink max-w-4xl"
          />
        </div>

        {/* 2x4 feature grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
          {securityFeatures.map((feature, i) => (
            <AnimatedCard
              key={feature.title}
              index={i}
              className="group rounded-3xl bg-surface border border-ink/[0.06] p-8 md:p-10 transition-all duration-300 hover:bg-black/[0.02] hover:border-ink/[0.1]"
            >
              <MaskRevealImage
                src={feature.image}
                alt={feature.title}
                containerClassName="w-full h-40 rounded-3xl mb-5"
                delay={i * 0.08}
                direction="up"
              />
              <MaskRevealUp as="h3" className="text-xl font-bold text-ink mb-2">
                {feature.title}
              </MaskRevealUp>
              <SoftBlurIn as="p" className="text-sm text-ink/50 leading-relaxed max-w-md">
                {feature.description}
              </SoftBlurIn>
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

function ControlledAutonomy() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section
      ref={ref}
      className="py-24 md:py-32 lg:py-40 border-b border-rule relative"
    >
      {/* Subtle gradient */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white via-surface/40 to-white" />

      <div className="relative z-10 section-padding max-container">
        {/* Section header */}
        <div className="mb-16 md:mb-20">
          <SpringScaleIn
            as="p"
            className="text-electric text-sm font-medium tracking-widest uppercase mb-4"
          >
            Trust Architecture
          </SpringScaleIn>
          <LineByLineSlide
            as="h2"
            text={"Built for\nControlled Autonomy."}
            className="text-display-md font-bold text-ink max-w-3xl"
          />
          <SoftBlurIn
            as="p"
            delay={0.3}
            className="mt-6 text-lg text-ink/50 max-w-2xl"
          >
            Four principles that govern every agent, with a live audit trail you
            can monitor in real time.
          </SoftBlurIn>
        </div>

        {/* Split layout: principles left, audit log right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-black/[0.04] rounded-3xl overflow-hidden border border-ink/[0.06]">
          {/* Left -- Principles */}
          <div className="p-8 md:p-10 lg:p-12 bg-white">
            <SoftBlurIn as="h3" className="text-2xl font-bold text-ink mb-10">
              Four principles that govern every agent.
            </SoftBlurIn>
            <div className="space-y-0">
              {principles.map((p, i) => (
                <motion.div
                  key={p.title}
                  initial={{ opacity: 0, y: 16 }}
                  animate={inView ? { opacity: 1, y: 0 } : {}}
                  transition={{
                    delay: 0.2 + i * 0.1,
                    duration: 0.5,
                    ease: [0.25, 0.46, 0.45, 0.94],
                  }}
                  className="group flex items-start gap-5 py-6 border-b border-ink/[0.06] last:border-b-0 transition-colors"
                >
                  {/* Numbered indicator */}
                  <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-electric/[0.08] border border-electric/[0.15] flex items-center justify-center transition-all duration-300 group-hover:bg-electric/[0.15]">
                    <span className="text-sm font-bold font-mono text-electric">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="pt-1">
                    <h4 className="text-[15px] font-semibold text-ink mb-1.5">
                      {p.title}
                    </h4>
                    <p className="text-[13px] text-ink/40 leading-relaxed">
                      {p.description}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Right -- Live Audit Log */}
          <div className="p-8 md:p-10 lg:p-12 bg-surface">
            <SoftBlurIn className="flex items-center justify-between mb-8">
              <h3 className="text-lg font-semibold text-ink">
                Live Audit Log
              </h3>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/[0.08] border border-emerald-500/[0.15] px-3 py-1.5 text-[11px] font-semibold text-emerald-400">
                <span className="block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-glow-pulse" />
                Streaming
              </span>
            </SoftBlurIn>

            {/* Table header */}
            <div className="grid grid-cols-[56px_80px_1fr_72px] gap-3 text-[11px] font-semibold text-ink/30 uppercase tracking-wider pb-3 border-b border-ink/[0.06]">
              <span>Time</span>
              <span>Agent</span>
              <span>Action</span>
              <span className="text-right">Status</span>
            </div>

            {/* Rows */}
            <div>
              {auditLogEntries.map((entry, i) => (
                <motion.div
                  key={`${entry.time}-${entry.agent}`}
                  initial={{ opacity: 0, x: 12 }}
                  animate={inView ? { opacity: 1, x: 0 } : {}}
                  transition={{
                    delay: 0.4 + i * 0.06,
                    duration: 0.4,
                    ease: [0.25, 0.46, 0.45, 0.94],
                  }}
                  className="grid grid-cols-[56px_80px_1fr_72px] gap-3 py-3.5 text-sm items-center border-b border-ink/[0.04] last:border-b-0 group/row hover:bg-black/[0.02] -mx-3 px-3 rounded-lg transition-colors"
                >
                  <span className="text-ink/30 text-[12px] font-mono">
                    {entry.time}
                  </span>
                  <span className="text-ink font-semibold text-[13px]">{entry.agent}</span>
                  <span className="text-ink/40 text-[13px]">{entry.action}</span>
                  <span className="text-right">
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
                        entry.status === "approved"
                          ? "text-emerald-400"
                          : entry.status === "pending"
                            ? "text-amber-400"
                            : "text-red-400"
                      }`}
                    >
                      <span
                        className={`w-1 h-1 rounded-full ${
                          entry.status === "approved"
                            ? "bg-emerald-400"
                            : entry.status === "pending"
                              ? "bg-amber-400"
                              : "bg-red-400"
                        }`}
                      />
                      {entry.status}
                    </span>
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="relative py-32 md:py-40 lg:py-48 overflow-hidden">
      {/* Gradient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-surface" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full bg-violet-accent/[0.04] blur-[180px]" />
      </div>

      <div className="relative z-10 section-padding max-container text-center">
        <div className="flex flex-col items-center">
          <LineByLineSlide
            as="h2"
            text={"Questions About\nSecurity?"}
            className="text-display-lg font-bold text-ink max-w-3xl"
          />

          <SoftBlurIn
            as="p"
            delay={0.3}
            className="mt-6 text-lg md:text-xl text-ink/50 max-w-xl"
          >
            Our team is ready to walk you through our security architecture,
            compliance certifications, and deployment options.
          </SoftBlurIn>

          <SoftBlurIn delay={0.5} className="mt-10 flex flex-col sm:flex-row items-center gap-4">
            <Link
              href="/contact"
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-4 text-sm font-semibold text-white transition-all hover:bg-ink/90"
            >
              Talk to Security Team
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
              href="/security"
              className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-8 py-4 text-sm font-semibold text-ink transition hover:bg-surface"
            >
              View Documentation
            </Link>
          </SoftBlurIn>
        </div>
      </div>

      {/* Top edge */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function SecurityPage() {
  return (
    <main>
      <HeroSection />
      <SecurityGrid />
      <ControlledAutonomy />
      <CTASection />
    </main>
  );
}
