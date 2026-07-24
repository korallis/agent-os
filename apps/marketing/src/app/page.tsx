"use client";

import { useRef } from "react";
import { motion, useInView, useScroll, useTransform } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import {
  OrchestrationVisual,
  MemoryVisual,
  ReasoningVisual,
  SecurityVisual,
  IntegrationsVisual,
  CountUp,
} from "@/components/sections/FeatureVisuals";

/* ─── Scroll-reveal wrapper ─── */
function Reveal({
  children,
  className,
  delay = 0,
  direction = "up",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: "up" | "left" | "right" | "none";
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  const initial: Record<string, number> = { opacity: 0 };
  if (direction === "up") initial.y = 40;
  if (direction === "left") initial.x = -40;
  if (direction === "right") initial.x = 40;

  const animate: Record<string, number> = { opacity: 1 };
  if (direction === "up") animate.y = 0;
  if (direction === "left") animate.x = 0;
  if (direction === "right") animate.x = 0;

  return (
    <motion.div
      ref={ref}
      initial={initial}
      animate={inView ? animate : initial}
      transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1], delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ─── Text line reveal ─── */
function TextReveal({
  text,
  className,
  as: Tag = "h2",
  delay = 0,
  stagger = 0.08,
}: {
  text: string;
  className?: string;
  as?: "h1" | "h2" | "h3" | "p";
  delay?: number;
  stagger?: number;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const lines = text.split("\n");

  return (
    <Tag className={className}>
      <span ref={ref} className="block">
        {lines.map((line, i) => (
          <span key={i} className="block overflow-hidden pb-[0.15em]">
            <motion.span
              className="block"
              initial={{ y: "120%" }}
              animate={inView ? { y: "0%" } : { y: "120%" }}
              transition={{
                duration: 0.9,
                ease: [0.22, 1, 0.36, 1],
                delay: delay + i * stagger,
              }}
            >
              {line}
            </motion.span>
          </span>
        ))}
      </span>
    </Tag>
  );
}

/* ─── Arrow button (Enerblock-style) ─── */
function ArrowLink({
  href,
  children,
  variant = "dark",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "dark" | "light" | "outline";
}) {
  const base = "inline-flex items-center justify-between gap-6 rounded-full px-6 py-3.5 text-sm font-medium transition-all duration-300 group";
  const variants = {
    dark: `${base} bg-ink text-white hover:bg-ink/90`,
    light: `${base} bg-white text-ink hover:bg-white/90`,
    outline: `${base} border border-ink/20 text-ink hover:border-ink/40`,
  };

  return (
    <Link href={href} className={variants[variant]}>
      <span>{children}</span>
      <svg
        className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1.5"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
      </svg>
    </Link>
  );
}

/* ─── Parallax wrapper ─── */
function ParallaxSection({
  children,
  className,
  offset = 60,
}: {
  children: React.ReactNode;
  className?: string;
  offset?: number;
}) {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [offset, -offset]);

  return (
    <div ref={ref} className={className} style={{ overflow: "hidden" }}>
      <motion.div style={{ y }}>{children}</motion.div>
    </div>
  );
}

/* ─── Mask reveal left-to-right ─── */
function MaskRevealLeft({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ clipPath: "inset(0 100% 0 0)" }}
      whileInView={{ clipPath: "inset(0 0% 0 0)" }}
      transition={{ duration: 1.2, ease: [0.25, 0.46, 0.45, 0.94] }}
      viewport={{ once: true, margin: "100px" }}
    >
      {children}
    </motion.div>
  );
}

/* ─── Counter animation — uses CountUp from FeatureVisuals ─── */

/* ═══════════════════════════════════════════════
   SECTION: HERO (with video)
   ═══════════════════════════════════════════════ */
function HeroSection() {
  return (
    <section className="min-h-screen grid grid-cols-1 lg:grid-cols-2 border-b border-rule">
      {/* Left: Content */}
      <div className="relative flex flex-col justify-between p-6 md:p-12 xl:p-16 min-h-[60vh] lg:min-h-screen border-b lg:border-b-0 lg:border-r border-rule">
        <div className="h-20" />

        <div className="py-8 lg:py-0">
          <TextReveal
            text={"Next-Gen\nAI Agents"}
            as="h1"
            className="text-display-xl font-bold text-ink"
            delay={0.3}
            stagger={0.12}
          />
        </div>

        <div className="pb-8 lg:pb-12">
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.9, ease: [0.25, 0.1, 0.25, 1] }}
            className="text-lg lg:text-xl text-ink/50 max-w-md leading-relaxed mb-8"
          >
            The future of work is autonomous and intelligent.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.1 }}
            className="flex items-center gap-4"
          >
            <ArrowLink href="/contact" variant="dark">Get started</ArrowLink>
            <ArrowLink href="/platform" variant="outline">Explore</ArrowLink>
          </motion.div>
        </div>
      </div>

      {/* Right: Video Panel — Mask Reveal */}
      <div className="relative overflow-hidden min-h-[50vh] lg:min-h-0 bg-ink">
        {/* Mask reveal container */}
        <motion.div
          initial={{ clipPath: "inset(50% 50% 50% 50% round 24px)" }}
          animate={{ clipPath: "inset(0% 0% 0% 0% round 0px)" }}
          transition={{ duration: 1.4, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0"
        >
          {/* Video with subtle zoom-out as mask opens */}
          <motion.div
            initial={{ scale: 1.3 }}
            animate={{ scale: 1 }}
            transition={{ duration: 2, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0"
          >
            <video
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              className="absolute inset-0 w-full h-full object-cover"
              src="/hero-video.mp4"
            />
          </motion.div>
        </motion.div>

        {/* Grid overlay lines — appear after mask opens */}
        <div className="absolute inset-0 pointer-events-none z-10">
          {/* Top labels row */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.4 }}
            className="flex justify-between items-center px-6 lg:px-8 h-14 border-b border-white/15"
          >
            <span className="text-xs font-mono text-white/80 uppercase tracking-[0.2em]">Platform</span>
            <span className="text-xs font-mono text-white/80 uppercase tracking-[0.2em]">Est. 2025</span>
          </motion.div>

          {/* Vertical center line */}
          <motion.div
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.8, delay: 1.6 }}
            className="absolute top-14 bottom-14 left-1/2 w-px bg-white/15 origin-top"
          />
          {/* Horizontal center line */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.8, delay: 1.7 }}
            className="absolute top-1/2 left-0 right-0 h-px bg-white/15 origin-left"
          />

          {/* Bottom row */}
          <div className="absolute bottom-0 left-0 right-0 h-14 border-t border-white/15 flex items-center justify-center">
            <motion.span
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 1.8 }}
              className="text-xs font-mono text-white/60 uppercase tracking-[0.3em]"
            >
              Agent OS
            </motion.span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   SECTION: VISION (split image + text)
   ═══════════════════════════════════════════════ */
function VisionSection() {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 border-b border-rule">
      {/* Left: AI Image with mask reveal */}
      <MaskRevealLeft>
        <div className="relative min-h-[50vh] lg:min-h-[90vh] border-b lg:border-b-0 lg:border-r border-rule overflow-hidden">
          <motion.div
            className="absolute inset-0"
            initial={{ scale: 1.15 }}
            whileInView={{ scale: 1 }}
            transition={{ duration: 1.6, ease: [0.25, 0.46, 0.45, 0.94] }}
            viewport={{ once: true, margin: "-60px" }}
          >
            <Image
              src="https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&h=1600&fit=crop&q=80"
              alt="Artificial intelligence neural network"
              fill
              className="object-cover"
              sizes="50vw"
              priority
            />
          </motion.div>
          <div className="absolute inset-0 bg-gradient-to-t from-white/40 via-transparent to-transparent" />
        </div>
      </MaskRevealLeft>

      {/* Right: Content */}
      <div className="flex flex-col">
        <div className="flex-1 flex flex-col justify-center p-8 md:p-12 xl:p-16">
          <Reveal>
            <TextReveal
              text={"Autonomous intelligence\nand adaptive control\nto execute with precision"}
              as="h2"
              className="text-display-md font-bold text-ink mb-8"
              stagger={0.06}
            />
          </Reveal>

          <Reveal delay={0.3}>
            <p className="text-lg text-ink/50 leading-relaxed max-w-lg">
              Scalable, contextual, and human-controlled processes.
            </p>
          </Reveal>
        </div>

        {/* Bottom cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 border-t border-rule">
          {[
            {
              label: "Platform",
              desc: "A unified AI infrastructure that integrates reasoning, memory, tools, and execution — giving agents the intelligence to act autonomously.",
              href: "/platform",
            },
            {
              label: "Agents",
              desc: "Specialized AI workers that collaborate, share context, and divide tasks. Each agent is built for a specific domain and workflow.",
              href: "/agents",
            },
          ].map((card, i) => (
            <Reveal key={card.label} delay={0.1 * i} className={i === 0 ? "border-b sm:border-b-0 sm:border-r border-rule" : ""}>
              <div className="p-8 md:p-10 flex flex-col justify-between min-h-[280px]">
                <div>
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="text-xs font-mono text-ink uppercase tracking-[0.2em]">{card.label}</h3>
                    <span className="w-2 h-2 bg-ink" />
                  </div>
                  <p className="text-sm text-ink/50 leading-relaxed">{card.desc}</p>
                </div>
                <div className="mt-8">
                  <ArrowLink href={card.href} variant="outline">Learn more</ArrowLink>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   SECTION: SYSTEM (dark with blueprint)
   ═══════════════════════════════════════════════ */
const architectureLayers = [
  {
    label: "Interface Layer",
    desc: "APIs, SDKs, and UI components",
    color: "#3b82f6",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    label: "Agent Layer",
    desc: "Autonomous task execution",
    color: "#8b5cf6",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
    ),
  },
  {
    label: "Reasoning Engine",
    desc: "Chain-of-thought processing",
    color: "#f59e0b",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
  },
  {
    label: "Memory & Context",
    desc: "Persistent knowledge storage",
    color: "#10b981",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
  },
  {
    label: "Tool Execution",
    desc: "External system integration",
    color: "#ec4899",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384 3.217 1.03-5.985L2.25 7.86l6.01-.873L11.42 1.5l3.18 5.487 6.01.873-4.816 4.542 1.03 5.985z" />
      </svg>
    ),
  },
];

function SystemSection() {
  return (
    <section className="border-b border-rule bg-white">
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* Left: Text */}
        <div className="p-8 md:p-12 xl:p-16 flex flex-col justify-between min-h-[60vh] border-b lg:border-b-0 lg:border-r border-rule">
          <div>
            <Reveal>
              <span className="text-[10px] font-mono text-ink/30 uppercase tracking-[0.2em] block mb-6">Architecture</span>
            </Reveal>
            <Reveal>
              <TextReveal
                text={"The intelligent agent\nsystem that reduces\ncomplexity and provides\ncertainty"}
                as="h2"
                className="text-display-md font-bold text-ink"
                stagger={0.06}
              />
            </Reveal>
          </div>

          <Reveal delay={0.3}>
            <p className="text-base text-ink/50 leading-relaxed max-w-md mt-8 lg:mt-0">
              Integrates reasoning, memory, tools, and permissions within a unified framework.
              It connects design, orchestration, and execution to reduce deviation in timelines,
              costs, and outcomes — turning complex workflows into planned operations.
            </p>
          </Reveal>
        </div>

        {/* Right: Architecture diagram */}
        <div className="relative flex items-center justify-center p-8 md:p-12 xl:p-16">
          <div className="w-full max-w-sm space-y-0">
            {architectureLayers.map((layer, i) => (
              <Reveal key={i} delay={0.1 * i}>
                <div className="relative">
                  {/* Connector line */}
                  {i > 0 && (
                    <div className="flex justify-center -mt-px">
                      <div className="w-px h-6 bg-ink/10" />
                    </div>
                  )}
                  {/* Layer card */}
                  <motion.div
                    whileHover={{ x: 4 }}
                    transition={{ duration: 0.2 }}
                    className="group relative flex items-center gap-4 rounded-3xl border border-ink/[0.08] bg-white p-5 hover:border-ink/20 transition-all duration-300"
                  >
                    <div
                      className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors duration-300"
                      style={{
                        backgroundColor: `${layer.color}12`,
                        border: `1px solid ${layer.color}25`,
                        color: layer.color,
                      }}
                    >
                      {layer.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-ink">{layer.label}</p>
                      <p className="text-xs text-ink/40 mt-0.5">{layer.desc}</p>
                    </div>
                    <span className="text-[10px] font-mono text-ink/20 tabular-nums">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </motion.div>
                </div>
              </Reveal>
            ))}

            {/* Version badge */}
            <Reveal delay={0.6}>
              <div className="flex items-center justify-end gap-3 mt-6 pt-6 border-t border-ink/[0.06]">
                <div className="text-right">
                  <p className="text-[10px] font-mono text-ink/30 uppercase tracking-[0.15em]">Agent OS Architecture</p>
                  <p className="text-[10px] font-mono text-ink/20 uppercase tracking-[0.15em]">Version 1.0</p>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   SECTION: FEATURES (Bento grid)
   ═══════════════════════════════════════════════ */
const bentoFeatures = [
  /* ── Row 1: two cards ── */
  {
    key: "orchestration",
    title: "Multi-Agent Orchestration",
    desc: "Deploy specialized agents that collaborate seamlessly, sharing context and goals.",
    visual: <OrchestrationVisual />,
    span: "lg:col-span-6",
    border: "border-b lg:border-r border-rule",
  },
  {
    key: "memory",
    title: "Contextual Memory",
    desc: "Persistent context across sessions with long-term, working, and shared knowledge bases.",
    visual: <MemoryVisual />,
    span: "lg:col-span-6",
    border: "border-b border-rule",
  },
  /* ── Row 2: three equal cards ── */
  {
    key: "reasoning",
    title: "Adaptive Reasoning",
    desc: "Dynamic reasoning chains that adapt to complexity.",
    visual: <ReasoningVisual />,
    span: "lg:col-span-4",
    border: "border-b lg:border-b-0 lg:border-r border-rule",
  },
  {
    key: "security",
    title: "Enterprise Security",
    desc: "Role-based access, audit trails, and sandboxed execution.",
    visual: <SecurityVisual />,
    span: "lg:col-span-4",
    border: "border-b lg:border-b-0 lg:border-r border-rule",
  },
  {
    key: "integrations",
    title: "Universal Integrations",
    desc: "500+ pre-built connectors to your existing tools.",
    visual: <IntegrationsVisual />,
    span: "lg:col-span-4",
    border: "",
  },
];

function FeaturesSection() {
  return (
    <section className="border-b border-rule">
      {/* Section header */}
      <div className="p-8 md:p-12 xl:p-16 border-b border-rule">
        <Reveal>
          <span className="text-xs font-mono text-ink/40 uppercase tracking-[0.3em] block mb-4">
            Capabilities
          </span>
        </Reveal>
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <Reveal delay={0.1}>
            <TextReveal
              text={"Key features\nand benefits"}
              as="h2"
              className="text-display-md font-bold text-ink"
              stagger={0.08}
            />
          </Reveal>
          <Reveal delay={0.3}>
            <p className="text-base text-ink/50 leading-relaxed max-w-md lg:text-right">
              Every component is designed for production-grade autonomous operation with enterprise reliability.
            </p>
          </Reveal>
        </div>
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12">
        {bentoFeatures.map((feature) => (
          <div
            key={feature.key}
            className={`${feature.span} ${feature.border} relative flex flex-col group`}
          >
            {/* Text overlay at top */}
            <div className="relative z-20 p-6 md:p-8">
              <Reveal>
                <h3 className="text-lg md:text-xl font-bold text-ink mb-1.5">
                  {feature.title}
                </h3>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="text-sm text-ink/40 leading-relaxed max-w-sm">
                  {feature.desc}
                </p>
              </Reveal>
            </div>

            {/* Visual fills remaining space */}
            <div className="relative z-10 flex-1">
              {feature.visual}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   SECTION: AGENTS (light bg, numbered rows)
   ═══════════════════════════════════════════════ */
const agents = [
  {
    num: "01",
    category: "Research",
    name: "Autonomous research\nthat drives decisions",
    desc: "Scans sources, summarizes insights, and turns messy information into structured decisions. Market research, competitive analysis, and trend scanning — executed automatically.",
    href: "/agents/research",
    image: "/autonomous-research.png",
  },
  {
    num: "02",
    category: "Design",
    name: "Transform requirements\ninto design systems",
    desc: "Converts research and requirements into structured design directions, briefs, and moodboards. Automates design research, asset organization, and quality assurance.",
    href: "/agents",
    image: "/design-agent.png",
  },
  {
    num: "03",
    category: "Sales",
    name: "Personalized outreach\nat enterprise scale",
    desc: "Researches accounts, personalizes messaging, and manages pipeline progression. From first touch to closed deal, every interaction is data-informed and precisely timed.",
    href: "/agents",
    image: "/sales-agent.png",
  },
  {
    num: "04",
    category: "Support",
    name: "Intelligent resolution\nwith full context",
    desc: "Handles tickets with deep context, routes conversations to the right specialist, and resolves issues with knowledge base integration and continuous learning.",
    href: "/agents",
    image: "/support-agent.png",
  },
  {
    num: "05",
    category: "Automation",
    name: "Multi-step execution\nacross every system",
    desc: "Connects your entire tool stack and executes complex multi-step workflows. From triggers to API calls to conditional logic — fully autonomous operation.",
    href: "/agents",
    image: "/automation-agent.png",
  },
];

function AgentsSection() {
  return (
    <section className="bg-surface text-ink">
      {/* Section header */}
      <div className="grid grid-cols-1 lg:grid-cols-2 border-b border-rule">
        <div className="p-8 md:p-12 xl:p-16">
          <Reveal>
            <div className="flex items-center gap-3 mb-6">
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-ink/50">Agents</span>
              <span className="w-2 h-2 bg-ink/20" />
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <TextReveal
              text={"Specialized AI for\nevery workflow"}
              as="h2"
              className="text-display-md font-bold text-ink"
              stagger={0.08}
            />
          </Reveal>
        </div>
        <div className="hidden lg:block border-l border-rule" />
      </div>

      {/* Agent rows */}
      {agents.map((agent, i) => (
        <motion.div
          key={agent.num}
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.05 * i }}
          viewport={{ once: true, margin: "-60px" }}
          className="grid grid-cols-1 md:grid-cols-[100px_1fr_1fr] lg:grid-cols-[120px_1fr_1fr] border-b border-rule group hover:bg-surface-warm transition-colors duration-500"
        >
          {/* Number */}
          <div className="p-6 md:p-8 border-b md:border-b-0 md:border-r border-rule flex items-start">
            <Reveal delay={0.05 * i}>
              <span className="text-sm font-mono text-ink/30">{agent.num} /</span>
            </Reveal>
          </div>

          {/* Visual */}
          <div className="relative overflow-hidden border-b md:border-b-0 md:border-r border-rule min-h-[200px] md:min-h-[300px]">
            <motion.div
              initial={{ scale: 1.1, opacity: 0 }}
              whileInView={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.1 + 0.05 * i }}
              viewport={{ once: true, margin: "-60px" }}
              className="absolute inset-0"
            >
              <Image
                src={agent.image}
                alt={agent.category}
                fill
                className="object-cover"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
            </motion.div>
          </div>

          {/* Content */}
          <div className="p-8 md:p-10 lg:p-12 flex flex-col justify-between min-h-[300px]">
            <div>
              <Reveal delay={0.1 + 0.05 * i}>
                <span className="text-xs font-mono uppercase tracking-[0.2em] text-ink/40 mb-4 block">
                  {agent.category} Agent
                </span>
              </Reveal>
              <Reveal delay={0.15 + 0.05 * i}>
                <TextReveal
                  text={agent.name}
                  as="h3"
                  className="text-display-sm font-bold text-ink mb-6"
                  stagger={0.06}
                />
              </Reveal>
              <Reveal delay={0.25 + 0.05 * i}>
                <p className="text-sm text-ink/60 leading-relaxed max-w-md">{agent.desc}</p>
              </Reveal>
            </div>

            <Reveal delay={0.3 + 0.05 * i}>
              <div className="mt-8">
                <ArrowLink href={agent.href} variant="dark">Learn more</ArrowLink>
              </div>
            </Reveal>
          </div>
        </motion.div>
      ))}
    </section>
  );
}

/* ═══════════════════════════════════════════════
   SECTION: CTA (Apple-style, clean dark)
   ═══════════════════════════════════════════════ */
function CTASection() {
  const metrics = [
    { num: 10, suffix: "x", label: "Faster execution" },
    { num: 99.9, suffix: "%", label: "Uptime", decimal: true },
    { num: 500, suffix: "+", label: "Integrations" },
    { num: 24, suffix: "/7", label: "Autonomous" },
  ];

  return (
    <section className="relative py-32 md:py-44 overflow-hidden bg-surface">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full opacity-[0.08] blur-[160px]"
        style={{ background: "radial-gradient(ellipse at center, #3b82f6 0%, #8b5cf6 50%, transparent 70%)" }}
      />

      <div className="relative z-10 section-padding max-container">
        {/* Metrics row */}
        <Reveal>
          <div className="flex items-center justify-center gap-8 md:gap-16 mb-20">
            {metrics.map((m, i) => (
              <div key={m.label} className="text-center">
                <p className="text-3xl md:text-4xl font-bold text-ink mb-1">
                  <CountUp value={m.num} suffix={m.suffix} delay={0.1 + i * 0.12} duration={1.4} />
                </p>
                <motion.p
                  className="text-[12px] text-ink/30 tracking-wide"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.5, delay: 0.3 + i * 0.1 }}
                >
                  {m.label}
                </motion.p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Divider */}
        <div className="w-12 h-px bg-ink/[0.08] mx-auto mb-20" />

        {/* Headline */}
        <div className="text-center max-w-3xl mx-auto">
          <Reveal>
            <TextReveal
              text={"Start building\nwith Agent OS"}
              as="h2"
              className="text-display-lg font-bold text-ink mb-6"
              stagger={0.1}
            />
          </Reveal>

          <Reveal delay={0.3}>
            <p className="text-lg md:text-xl text-ink/40 max-w-xl mx-auto leading-relaxed mb-12">
              Deploy intelligent agents that transform how your team works.
            </p>
          </Reveal>

          <Reveal delay={0.5}>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <ArrowLink href="/contact" variant="dark">Get started</ArrowLink>
              <ArrowLink href="/platform" variant="outline">Explore platform</ArrowLink>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════ */
export default function HomePage() {
  return (
    <main>
      <HeroSection />
      <VisionSection />
      <SystemSection />
      <FeaturesSection />
      <AgentsSection />
      <CTASection />
    </main>
  );
}
