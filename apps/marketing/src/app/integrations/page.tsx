"use client";

import { useRef, useState } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import {
  SoftBlurIn,
  SpringScaleIn,
  PerCharacterRise,
  MaskRevealUp,
  LineByLineSlide,
  ShortSlideDown,
  MaskRevealImage,
  AnimatedCard,
  StaggerContainer,
  StaggerItem,
} from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Integration Data                                                   */
/* ------------------------------------------------------------------ */

type Category =
  | "All"
  | "Communication"
  | "Productivity"
  | "Design"
  | "Engineering"
  | "Sales"
  | "Data"
  | "Automation";

interface Integration {
  name: string;
  icon: string;
  image: string;
  category: Exclude<Category, "All">;
}

const categories: Category[] = [
  "All",
  "Communication",
  "Productivity",
  "Design",
  "Engineering",
  "Sales",
  "Data",
  "Automation",
];

const integrations: Integration[] = [
  { name: "Slack", icon: "\u{1F4AC}", image: "https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=400&h=300&fit=crop&q=80", category: "Communication" },
  { name: "Notion", icon: "\u{1F4DD}", image: "https://images.unsplash.com/photo-1517842645767-c639042777db?w=400&h=300&fit=crop&q=80", category: "Productivity" },
  { name: "Gmail", icon: "\u{1F4E7}", image: "https://images.unsplash.com/photo-1596526131083-e8c633c948d2?w=400&h=300&fit=crop&q=80", category: "Communication" },
  { name: "Google Calendar", icon: "\u{1F4C5}", image: "https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=400&h=300&fit=crop&q=80", category: "Productivity" },
  { name: "Linear", icon: "◼️", image: "https://images.unsplash.com/photo-1531403009284-440f080d1e12?w=400&h=300&fit=crop&q=80", category: "Engineering" },
  { name: "Jira", icon: "\u{1F4CB}", image: "https://images.unsplash.com/photo-1507925921958-8a62f3d1a50d?w=400&h=300&fit=crop&q=80", category: "Engineering" },
  { name: "GitHub", icon: "\u{1F419}", image: "https://images.unsplash.com/photo-1618401471353-b98afee0b2eb?w=400&h=300&fit=crop&q=80", category: "Engineering" },
  { name: "Figma", icon: "\u{1F3A8}", image: "https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400&h=300&fit=crop&q=80", category: "Design" },
  { name: "HubSpot", icon: "\u{1F7E0}", image: "https://images.unsplash.com/photo-1552664730-d307ca884978?w=400&h=300&fit=crop&q=80", category: "Sales" },
  { name: "Salesforce", icon: "☁️", image: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=300&fit=crop&q=80", category: "Sales" },
  { name: "Zapier", icon: "⚡", image: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&h=300&fit=crop&q=80", category: "Automation" },
  { name: "Airtable", icon: "\u{1F4CA}", image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&h=300&fit=crop&q=80", category: "Data" },
  { name: "Google Drive", icon: "\u{1F4C1}", image: "https://images.unsplash.com/photo-1544396821-4dd40b938ad3?w=400&h=300&fit=crop&q=80", category: "Productivity" },
  { name: "Intercom", icon: "\u{1F4AC}", image: "https://images.unsplash.com/photo-1556745757-8d76bdb6984b?w=400&h=300&fit=crop&q=80", category: "Communication" },
  { name: "Stripe", icon: "\u{1F4B3}", image: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400&h=300&fit=crop&q=80", category: "Data" },
  { name: "REST APIs", icon: "\u{1F50C}", image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&h=300&fit=crop&q=80", category: "Automation" },
];

/* ------------------------------------------------------------------ */
/*  Code block lines                                                   */
/* ------------------------------------------------------------------ */

const codeLines = [
  { indent: 0, text: "import", color: "text-violet-soft" },
  { indent: 0, text: " { AgentOS } ", color: "text-ink" },
  { indent: 0, text: "from ", color: "text-violet-soft" },
  { indent: 0, text: "'@agentos/sdk'", color: "text-cyan-soft" },
  { indent: 0, text: ";", color: "text-ink/50" },
  { indent: 0, text: "", color: "" },
  { indent: 0, text: "const ", color: "text-violet-soft" },
  { indent: 0, text: "agent = ", color: "text-ink" },
  { indent: 0, text: "new ", color: "text-violet-soft" },
  { indent: 0, text: "AgentOS", color: "text-electric-light" },
  { indent: 0, text: "({", color: "text-ink" },
  { indent: 1, text: "name: ", color: "text-ink/60" },
  { indent: 0, text: "'custom-integration'", color: "text-cyan-soft" },
  { indent: 0, text: ",", color: "text-ink" },
  { indent: 1, text: "tools: ", color: "text-ink/60" },
  { indent: 0, text: "['slack', 'notion', 'github']", color: "text-cyan-soft" },
  { indent: 0, text: ",", color: "text-ink" },
  { indent: 0, text: "});", color: "text-ink" },
  { indent: 0, text: "", color: "" },
  { indent: 0, text: "agent", color: "text-ink" },
  { indent: 0, text: ".on", color: "text-electric-light" },
  { indent: 0, text: "('trigger', ", color: "text-cyan-soft" },
  { indent: 0, text: "async ", color: "text-violet-soft" },
  { indent: 0, text: "(ctx) => {", color: "text-ink" },
  { indent: 1, text: "const data = ", color: "text-electric-light" },
  { indent: 0, text: "await ", color: "text-violet-soft" },
  { indent: 0, text: "ctx.fetch(", color: "text-ink" },
  { indent: 0, text: "'/api/data'", color: "text-cyan-soft" },
  { indent: 0, text: ");", color: "text-ink" },
  { indent: 1, text: "const summary = ", color: "text-electric-light" },
  { indent: 0, text: "await ", color: "text-violet-soft" },
  { indent: 0, text: "ctx.reason(data);", color: "text-ink" },
  { indent: 1, text: "await ", color: "text-violet-soft" },
  { indent: 0, text: "ctx.tools.slack.send(summary);", color: "text-electric-light" },
  { indent: 0, text: "});", color: "text-ink" },
  { indent: 0, text: "", color: "" },
  { indent: 0, text: "agent", color: "text-ink" },
  { indent: 0, text: ".deploy", color: "text-electric-light" },
  { indent: 0, text: "();", color: "text-cyan-soft" },
];

/* Reassemble into proper display lines for the code block */
const codeDisplayLines = [
  { text: "import { AgentOS } from '@agentos/sdk';", colors: [{ range: [0, 6], color: "text-violet-soft" }, { range: [7, 20], color: "text-ink" }, { range: [21, 25], color: "text-violet-soft" }, { range: [26, 40], color: "text-cyan-soft" }] },
  { text: "" },
  { text: "const agent = new AgentOS({", colors: [{ range: [0, 5], color: "text-violet-soft" }, { range: [14, 17], color: "text-violet-soft" }, { range: [18, 25], color: "text-electric-light" }] },
  { text: "  name: 'custom-integration',", indent: true },
  { text: "  tools: ['slack', 'notion', 'github'],", indent: true },
  { text: "});" },
  { text: "" },
  { text: "agent.on('trigger', async (ctx) => {" },
  { text: "  const data = await ctx.fetch('/api/data');", indent: true },
  { text: "  const summary = await ctx.reason(data);", indent: true },
  { text: "  await ctx.tools.slack.send(summary);", indent: true },
  { text: "});" },
  { text: "" },
  { text: "agent.deploy();" },
];

/* ------------------------------------------------------------------ */
/*  Developer features                                                 */
/* ------------------------------------------------------------------ */

const devFeatures = [
  { icon: "\u{1F4E6}", title: "TypeScript SDK", desc: "Full type safety and IntelliSense" },
  { icon: "\u{1F517}", title: "Webhook Support", desc: "Real-time event triggers via HTTP" },
  { icon: "\u{1F9EA}", title: "Local Testing", desc: "Test agents locally before deploy" },
  { icon: "\u{1F4CA}", title: "Built-in Analytics", desc: "Monitor agent performance live" },
  { icon: "\u{1F512}", title: "Enterprise Auth", desc: "SSO, RBAC, and audit logs" },
  { icon: "⚡", title: "Edge Runtime", desc: "Deploy globally with low latency" },
];

/* ------------------------------------------------------------------ */
/*  Hero Section                                                       */
/* ------------------------------------------------------------------ */

function HeroSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section
      ref={ref}
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
    >
      {/* Background */}
      <div className="absolute inset-0 bg-white" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full opacity-25 blur-[140px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(34,211,238,0.3) 0%, rgba(59,130,246,0.15) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container text-center py-32 md:py-40">
        {/* Badge */}
        {inView && (
          <SpringScaleIn delay={0.1} className="mb-8">
            <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-cyan border border-cyan/20 rounded-full px-5 py-2 bg-cyan/5">
              Integrations
            </span>
          </SpringScaleIn>
        )}

        {/* Title */}
        {inView && (
          <div className="mb-8 max-w-5xl mx-auto">
            <PerCharacterRise
              text="Connect Agents"
              as="h1"
              className="text-display-xl font-bold text-ink"
              delay={0.2}
            />
            <PerCharacterRise
              text="to Every Tool"
              as="h1"
              className="text-display-xl font-bold gradient-text"
              delay={0.45}
            />
          </div>
        )}

        {/* Subtitle */}
        {inView && (
          <SoftBlurIn delay={0.4} className="mb-12">
            <p className="text-xl md:text-2xl text-ink/50 max-w-2xl mx-auto leading-relaxed">
              500+ integrations across communication, design, engineering, sales,
              and data. Your agents work everywhere your team does.
            </p>
          </SoftBlurIn>
        )}

        {/* CTAs */}
        {inView && (
          <SoftBlurIn delay={0.6}>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link
                href="#grid"
                className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-white bg-ink hover:bg-ink/90 rounded-full transition-colors duration-200"
              >
                Browse Integrations
              </Link>
              <Link
                href="/workflows"
                className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-ink/60 border border-ink/10 hover:border-ink/20 hover:text-ink rounded-full transition-all duration-200"
              >
                See Workflows
              </Link>
            </div>
          </SoftBlurIn>
        )}
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-white to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Category Filter + Grid Section                                     */
/* ------------------------------------------------------------------ */

function IntegrationGridSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [activeCategory, setActiveCategory] = useState<Category>("All");

  const filtered =
    activeCategory === "All"
      ? integrations
      : integrations.filter((ig) => ig.category === activeCategory);

  return (
    <section
      id="grid"
      ref={ref}
      className="py-24 md:py-32 border-b border-rule-dark"
    >
      <div className="section-padding max-container">
        {/* Section heading */}
        {inView && (
          <div className="text-center mb-12">
            <SpringScaleIn delay={0.1} className="mb-4">
              <p className="text-electric text-sm font-medium tracking-wider uppercase">
                Ecosystem
              </p>
            </SpringScaleIn>

            <MaskRevealUp as="h2" className="text-display-lg font-bold text-ink mb-6" delay={0.2}>
              Your Entire Stack, Connected
            </MaskRevealUp>

            <SoftBlurIn delay={0.3}>
              <p className="text-xl text-ink/50 max-w-2xl mx-auto">
                Browse integrations by category. Every tool your agents need,
                ready out of the box.
              </p>
            </SoftBlurIn>
          </div>
        )}

        {/* Category tabs */}
        {inView && (
          <SoftBlurIn delay={0.35}>
            <div className="flex flex-wrap justify-center gap-2 mb-12 md:mb-16">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-200 ${
                    activeCategory === cat
                      ? "bg-ink text-white"
                      : "bg-surface text-ink/50 hover:text-ink border border-ink/[0.06] hover:border-ink/[0.12]"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </SoftBlurIn>
        )}

        {/* Integration grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
          {filtered.map((ig, i) => (
            <AnimatedCard
              key={ig.name}
              index={i}
              hover
              className="group"
            >
              <div className="bg-surface border border-ink/[0.06] p-6 md:p-8 flex flex-col items-center text-center hover:border-ink/[0.12] hover:bg-surface transition-all duration-300 min-h-[260px] justify-center">
                <MaskRevealImage
                  src={ig.image}
                  alt={ig.name}
                  containerClassName="w-full h-32 rounded-3xl mb-4"
                  delay={i * 0.05}
                  direction="up"
                />
                <MaskRevealUp as="h3" className="text-base font-semibold text-ink mb-2" delay={i * 0.05 + 0.1}>
                  {ig.name}
                </MaskRevealUp>
                <span className="inline-block text-[11px] font-medium tracking-wide uppercase text-ink/50 bg-black/[0.04] border border-ink/[0.06] rounded-lg px-3 py-1">
                  {ig.category}
                </span>
              </div>
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Developer API Section                                              */
/* ------------------------------------------------------------------ */

function DeveloperAPISection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  const simpleCodeLines = [
    "import { AgentOS } from '@agentos/sdk';",
    "",
    "const agent = new AgentOS({",
    "  name: 'custom-integration',",
    "  tools: ['slack', 'notion', 'github'],",
    "});",
    "",
    "agent.on('trigger', async (ctx) => {",
    "  const data = await ctx.fetch('/api/data');",
    "  const summary = await ctx.reason(data);",
    "  await ctx.tools.slack.send(summary);",
    "});",
    "",
    "agent.deploy();",
  ];

  /* Simple syntax coloring by keyword */
  function colorize(line: string) {
    if (!line.trim()) return <span>{" "}</span>;

    const keywords = ["import", "from", "const", "new", "async", "await"];

    /* String literals */
    const stringRegex = /'[^']*'/g;
    let lastIndex = 0;
    const segments: { text: string; isString: boolean; start: number }[] = [];

    const stringMatches = [...line.matchAll(stringRegex)];
    for (const m of stringMatches) {
      if (m.index !== undefined && m.index > lastIndex) {
        segments.push({
          text: line.slice(lastIndex, m.index),
          isString: false,
          start: lastIndex,
        });
      }
      segments.push({
        text: m[0],
        isString: true,
        start: m.index ?? lastIndex,
      });
      lastIndex = (m.index ?? 0) + m[0].length;
    }
    if (lastIndex < line.length) {
      segments.push({
        text: line.slice(lastIndex),
        isString: false,
        start: lastIndex,
      });
    }
    if (segments.length === 0) {
      segments.push({ text: line, isString: false, start: 0 });
    }

    return (
      <>
        {segments.map((seg, si) => {
          if (seg.isString) {
            return (
              <span key={si} className="text-cyan-soft">
                {seg.text}
              </span>
            );
          }
          /* Highlight keywords */
          const words = seg.text.split(/(\b)/);
          return (
            <span key={si}>
              {words.map((w, wi) => {
                if (keywords.includes(w)) {
                  return (
                    <span key={wi} className="text-violet-soft">
                      {w}
                    </span>
                  );
                }
                if (w.startsWith(".") || w === "AgentOS") {
                  return (
                    <span key={wi} className="text-electric-light">
                      {w}
                    </span>
                  );
                }
                return (
                  <span key={wi} className="text-ink/60">
                    {w}
                  </span>
                );
              })}
            </span>
          );
        })}
      </>
    );
  }

  return (
    <section
      ref={ref}
      className="py-24 md:py-32 border-b border-rule-dark relative overflow-hidden"
    >
      {/* Background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full opacity-15 blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(34,211,238,0.25) 0%, rgba(59,130,246,0.15) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Text side */}
          <div>
            {inView && (
              <>
                {/* Developer API label */}
                <SpringScaleIn delay={0.1} className="mb-6">
                  <span className="inline-block text-xs font-semibold tracking-[0.15em] uppercase text-cyan border border-cyan/20 rounded-full px-4 py-1.5 bg-cyan/5">
                    Developer API
                  </span>
                </SpringScaleIn>

                {/* Built for Developers */}
                <PerCharacterRise
                  text="Built for Developers"
                  as="h2"
                  className="text-display-lg font-bold text-ink mb-6"
                  delay={0.2}
                />

                {/* Description */}
                <SoftBlurIn delay={0.35} className="mb-10">
                  <p className="text-lg text-ink/50 leading-relaxed">
                    Connect any tool, service, or internal system with the Agent OS
                    SDK. Build custom integrations that give your agents access to
                    proprietary data, internal APIs, and specialized workflows.
                    Full TypeScript support, local testing, and edge deployment.
                  </p>
                </SoftBlurIn>

                {/* Feature list */}
                <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {devFeatures.map((feat) => (
                    <StaggerItem key={feat.title}>
                      <div className="flex items-start gap-3 p-3 rounded-3xl bg-surface border border-ink/[0.04]">
                        <span className="text-2xl flex-shrink-0">{feat.icon}</span>
                        <div>
                          <h4 className="text-sm font-semibold text-ink">
                            {feat.title}
                          </h4>
                          <p className="text-xs text-ink/50">{feat.desc}</p>
                        </div>
                      </div>
                    </StaggerItem>
                  ))}
                </StaggerContainer>
              </>
            )}
          </div>

          {/* Code block */}
          {inView && (
            <AnimatedCard delay={0.3} className="relative">
              {/* Background image behind code block */}
              <div className="absolute inset-0 overflow-hidden opacity-10">
                <MaskRevealImage
                  src="https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&h=600&fit=crop&q=80"
                  alt="Code background"
                  containerClassName="w-full h-full"
                  delay={0.4}
                  direction="up"
                />
              </div>

              <div className="relative bg-surface/95 border border-ink/[0.06] overflow-hidden backdrop-blur-sm">
                {/* Window chrome */}
                <div className="flex items-center gap-2 px-5 py-3.5 border-b border-ink/[0.06] bg-surface">
                  <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                  <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                  <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                  <span className="ml-3 text-xs text-ink/50 font-mono">
                    agent.config.ts
                  </span>
                </div>

                {/* Code body */}
                <div className="px-6 py-6 font-mono text-[13px] leading-7 overflow-x-auto">
                  {simpleCodeLines.map((line, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={
                        inView
                          ? { opacity: 1, x: 0 }
                          : { opacity: 0, x: -8 }
                      }
                      transition={{
                        duration: 0.3,
                        delay: 0.5 + i * 0.04,
                        ease: "easeOut",
                      }}
                      className="whitespace-pre"
                    >
                      {colorize(line)}
                    </motion.div>
                  ))}
                </div>
              </div>
            </AnimatedCard>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Integration Marquee Section                                        */
/* ------------------------------------------------------------------ */

function MarqueeSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  /* Duplicate the list for seamless scroll */
  const marqueeItems = [...integrations, ...integrations];

  return (
    <section ref={ref} className="py-16 md:py-24 border-b border-rule-dark overflow-hidden">
      <div className="section-padding max-container mb-12">
        {inView && (
          <SoftBlurIn delay={0.1}>
            <p className="text-center text-ink/50 text-lg">
              Trusted by teams using the tools they already love
            </p>
          </SoftBlurIn>
        )}
      </div>

      {inView && (
        <SoftBlurIn delay={0.25}>
          <div className="relative">
            {/* Left/right fade */}
            <div className="absolute left-0 top-0 bottom-0 w-24 md:w-40 bg-gradient-to-r from-white to-transparent z-10" />
            <div className="absolute right-0 top-0 bottom-0 w-24 md:w-40 bg-gradient-to-l from-white to-transparent z-10" />

            {/* Scrolling row */}
            <div className="flex animate-marquee-scroll">
              {marqueeItems.map((ig, i) => (
                <div
                  key={`${ig.name}-${i}`}
                  className="flex-shrink-0 flex items-center gap-3 mx-6 md:mx-8"
                >
                  <span className="text-3xl">{ig.icon}</span>
                  <span className="text-base font-medium text-ink/60 whitespace-nowrap">
                    {ig.name}
                  </span>
                </div>
              ))}
            </div>

            {/* marquee-scroll animation defined in globals.css */}
          </div>
        </SoftBlurIn>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  CTA Section                                                        */
/* ------------------------------------------------------------------ */

function CTASection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-24 md:py-40 relative overflow-hidden">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-b from-white via-surface to-white" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full opacity-20 blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(34,211,238,0.3) 0%, rgba(59,130,246,0.15) 50%, transparent 70%)",
        }}
      />

      <div className="relative z-10 section-padding max-container text-center">
        {inView && (
          <>
            <LineByLineSlide
              text={"Connect Your Stack"}
              as="h2"
              className="text-display-lg font-bold gradient-text mb-6"
              delay={0.1}
            />

            <SoftBlurIn delay={0.3}>
              <p className="text-xl md:text-2xl text-ink/50 max-w-xl mx-auto mb-12 leading-relaxed">
                Bring every tool together under one intelligent layer. Your agents
                work across your entire ecosystem, seamlessly.
              </p>
            </SoftBlurIn>

            <SoftBlurIn delay={0.5}>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <Link
                  href="/contact"
                  className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-white bg-ink hover:bg-ink/90 rounded-full transition-colors duration-200"
                >
                  Connect Your Stack
                </Link>
                <Link
                  href="/workflows"
                  className="inline-flex items-center justify-center px-8 py-4 text-base font-semibold text-ink/60 border border-ink/10 hover:border-ink/20 hover:text-ink rounded-full transition-all duration-200"
                >
                  See Workflows
                </Link>
              </div>
            </SoftBlurIn>
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function IntegrationsPage() {
  return (
    <main>
      <HeroSection />
      <IntegrationGridSection />
      <DeveloperAPISection />
      <MarqueeSection />
      <CTASection />
    </main>
  );
}
