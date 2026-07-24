"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import { cn } from "@agent-os/ui";
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
/*  Data                                                               */
/* ------------------------------------------------------------------ */

interface Metric {
  value: string;
  label: string;
}

interface UseCase {
  id: string;
  team: string;
  teamLabel: string;
  headlineDark: string;
  headlineLight: string;
  description: string;
  metrics: Metric[];
}

const useCases: UseCase[] = [
  {
    id: "product",
    team: "Product Teams",
    teamLabel: "Product",
    headlineDark: "Decisions backed by data,",
    headlineLight: "not guesswork.",
    description:
      "Turn scattered feedback, research notes, and roadmap requests into clear product decisions. The Research Agent aggregates signals from user interviews, support tickets, and analytics to surface what matters most.",
    metrics: [
      { value: "42%", label: "Faster decisions" },
      { value: "3x", label: "More feedback processed" },
    ],
  },
  {
    id: "design",
    team: "Design Teams",
    teamLabel: "Design",
    headlineDark: "Research-driven design,",
    headlineLight: "fully automated.",
    description:
      "Transform research, references, and product requirements into structured design directions. Agents organize moodboards, competitive audits, and user insights so designers can focus on creating.",
    metrics: [
      { value: "60%", label: "Faster research" },
      { value: "2x", label: "More references" },
    ],
  },
  {
    id: "sales",
    team: "Sales Teams",
    teamLabel: "Sales",
    headlineDark: "Pipeline that moves",
    headlineLight: "itself.",
    description:
      "Research accounts, personalize outreach, and summarize opportunities automatically. Agents analyze prospects, draft tailored messages, and keep your pipeline data fresh without manual effort.",
    metrics: [
      { value: "35%", label: "More qualified leads" },
      { value: "2.5x", label: "Faster outreach" },
    ],
  },
  {
    id: "support",
    team: "Support Teams",
    teamLabel: "Support",
    headlineDark: "Resolution at the",
    headlineLight: "speed of context.",
    description:
      "Route tickets, retrieve context, and resolve issues with intelligent automation. The Support Agent triages incoming requests, pulls relevant documentation, and drafts responses in seconds.",
    metrics: [
      { value: "70%", label: "Faster resolution" },
      { value: "90%", label: "Satisfaction rate" },
    ],
  },
  {
    id: "operations",
    team: "Operations Teams",
    teamLabel: "Operations",
    headlineDark: "Workflows that run",
    headlineLight: "themselves.",
    description:
      "Automate reporting, sync tools, and coordinate cross-team workflows. Operations agents handle the repetitive coordination that keeps teams aligned and projects moving forward.",
    metrics: [
      { value: "80%", label: "Less manual work" },
      { value: "5x", label: "Throughput increase" },
    ],
  },
  {
    id: "agencies",
    team: "Agency Teams",
    teamLabel: "Agencies",
    headlineDark: "Scale without scaling",
    headlineLight: "headcount.",
    description:
      "Scale client work with AI-powered research, reporting, and deliverable generation. Agents handle the heavy lifting so your team delivers more value with fewer hours.",
    metrics: [
      { value: "3x", label: "Client capacity" },
      { value: "50%", label: "Faster delivery" },
    ],
  },
  {
    id: "founders",
    team: "Founders",
    teamLabel: "Founders",
    headlineDark: "A team before you",
    headlineLight: "have a team.",
    description:
      "Move fast with AI agents handling research, outreach, and operations. From market analysis to investor updates, agents give founders leverage to focus on what only they can do.",
    metrics: [
      { value: "10x", label: "Productivity gain" },
      { value: "$0", label: "Overhead cost" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Visual Components                                                  */
/* ------------------------------------------------------------------ */

const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.07, delayChildren: 0.1 },
  },
} as const;

const fadeSlideUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.25, 0.1, 0.25, 1] } },
} as const;

function VisualShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[#fafafa] rounded-3xl border border-black/[0.06] overflow-hidden">
      <div className="p-6 md:p-8">{children}</div>
    </div>
  );
}

/* --- Product: Feedback Aggregation -------------------------------- */

const signalSources = [
  { name: "User interviews", color: "bg-blue-500", count: 24 },
  { name: "Support tickets", color: "bg-amber-500", count: 142 },
  { name: "Analytics flags", color: "bg-emerald-500", count: 38 },
  { name: "Roadmap requests", color: "bg-violet-500", count: 67 },
];

function ProductVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-3"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-4">
          Signal Sources
        </motion.p>
        {signalSources.map((s) => (
          <motion.div
            key={s.name}
            variants={fadeSlideUp}
            className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-white border border-black/[0.04]"
          >
            <div className="flex items-center gap-3">
              <span className={cn("w-2 h-2 rounded-full", s.color)} />
              <span className="text-sm text-ink/70">{s.name}</span>
            </div>
            <span className="text-xs font-mono text-ink/40">{s.count}</span>
          </motion.div>
        ))}
        <motion.div
          variants={fadeSlideUp}
          className="mt-4 p-4 rounded-xl bg-white border border-emerald-200/60"
        >
          <p className="text-[10px] font-mono uppercase tracking-wider text-emerald-600/70 mb-1.5">
            Top Signal
          </p>
          <p className="text-sm font-medium text-ink/80">
            Search UX needs rework
          </p>
          <p className="text-xs text-ink/40 mt-1 font-mono">
            67 mentions across 3 sources
          </p>
        </motion.div>
      </motion.div>
    </VisualShell>
  );
}

/* --- Design: Research Board --------------------------------------- */

const auditItems = [
  { name: "Navigation patterns", done: true },
  { name: "Onboarding flows", done: true },
  { name: "Pricing pages", done: false },
];

function DesignVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-4"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-2">
          Moodboard
        </motion.p>
        <motion.div variants={fadeSlideUp} className="grid grid-cols-3 gap-2">
          <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-violet-200 to-violet-100" />
          <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-sky-200 to-sky-100" />
          <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-amber-200 to-amber-100" />
        </motion.div>
        <motion.div
          variants={fadeSlideUp}
          className="p-4 rounded-xl bg-white border border-black/[0.04]"
        >
          <p className="text-[10px] font-mono uppercase tracking-wider text-ink/30 mb-3">
            Competitive Audit
          </p>
          <div className="space-y-2.5">
            {auditItems.map((item) => (
              <div key={item.name} className="flex items-center gap-2.5">
                <span
                  className={cn(
                    "w-4 h-4 rounded-full flex items-center justify-center text-[10px]",
                    item.done
                      ? "bg-emerald-100 text-emerald-600"
                      : "bg-ink/5 text-ink/25"
                  )}
                >
                  {item.done ? "✓" : ""}
                </span>
                <span className="text-sm text-ink/60">{item.name}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </VisualShell>
  );
}

/* --- Sales: Pipeline Card ----------------------------------------- */

const prospects = [
  { company: "Meridian Corp", stage: "Proposal", stageColor: "bg-violet-100 text-violet-700", confidence: 82 },
  { company: "NovaTech Inc", stage: "Qualified", stageColor: "bg-blue-100 text-blue-700", confidence: 64 },
  { company: "Atlas Group", stage: "Lead", stageColor: "bg-amber-100 text-amber-700", confidence: 41 },
];

function SalesVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-3"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-2">
          Active Pipeline
        </motion.p>
        {prospects.map((p) => (
          <motion.div
            key={p.company}
            variants={fadeSlideUp}
            className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-white border border-black/[0.04]"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-ink/70">{p.company}</span>
              <span
                className={cn(
                  "text-[10px] font-mono px-2 py-0.5 rounded-full",
                  p.stageColor
                )}
              >
                {p.stage}
              </span>
            </div>
            <span className="text-xs font-mono text-ink/50">{p.confidence}%</span>
          </motion.div>
        ))}
      </motion.div>
    </VisualShell>
  );
}

/* --- Support: Ticket Triage --------------------------------------- */

const tickets = [
  { id: "TK-1042", subject: "API rate limit errors", priority: "High", priorityColor: "bg-red-100 text-red-700", status: "In Progress", time: "12m" },
  { id: "TK-1039", subject: "SSO login redirect loop", priority: "High", priorityColor: "bg-red-100 text-red-700", status: "Triaged", time: "24m" },
  { id: "TK-1037", subject: "Export formatting issue", priority: "Medium", priorityColor: "bg-amber-100 text-amber-700", status: "Resolved", time: "8m" },
];

function SupportVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-3"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-2">
          Ticket Queue
        </motion.p>
        {tickets.map((t) => (
          <motion.div
            key={t.id}
            variants={fadeSlideUp}
            className="py-3 px-3 rounded-xl bg-white border border-black/[0.04]"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-ink/30">{t.id}</span>
                <span
                  className={cn(
                    "text-[10px] font-mono px-2 py-0.5 rounded-full",
                    t.priorityColor
                  )}
                >
                  {t.priority}
                </span>
              </div>
              <span className="text-[10px] font-mono text-ink/30">{t.time} avg</span>
            </div>
            <p className="text-sm text-ink/70">{t.subject}</p>
            <p className="text-[10px] font-mono text-ink/40 mt-1">{t.status}</p>
          </motion.div>
        ))}
      </motion.div>
    </VisualShell>
  );
}

/* --- Operations: Workflow Dashboard ------------------------------- */

const workflows = [
  { name: "Weekly metrics report", status: "Running", statusColor: "bg-emerald-500", lastRun: "2m ago" },
  { name: "CRM sync pipeline", status: "Completed", statusColor: "bg-blue-500", lastRun: "1h ago" },
  { name: "Slack digest", status: "Scheduled", statusColor: "bg-amber-500", lastRun: "6h ago" },
  { name: "Invoice processing", status: "Completed", statusColor: "bg-blue-500", lastRun: "3h ago" },
];

function OperationsVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-3"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-2">
          Workflow Status
        </motion.p>
        {workflows.map((w) => (
          <motion.div
            key={w.name}
            variants={fadeSlideUp}
            className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-white border border-black/[0.04]"
          >
            <div className="flex items-center gap-3">
              <span className={cn("w-2 h-2 rounded-full", w.statusColor)} />
              <span className="text-sm text-ink/70">{w.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-ink/40">{w.status}</span>
              <span className="text-[10px] font-mono text-ink/25">{w.lastRun}</span>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </VisualShell>
  );
}

/* --- Agencies: Client Capacity ------------------------------------ */

const clients = [
  { name: "Brightpath Labs", project: "Brand Refresh", progress: 72 },
  { name: "Crestline Ventures", project: "Product Launch", progress: 45 },
  { name: "Pinnacle Media", project: "Content Strategy", progress: 88 },
];

function AgenciesVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="space-y-3"
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-2">
          Client Capacity
        </motion.p>
        {clients.map((c) => (
          <motion.div
            key={c.name}
            variants={fadeSlideUp}
            className="py-3 px-3 rounded-xl bg-white border border-black/[0.04]"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-ink/70">{c.name}</span>
              <span className="text-[10px] font-mono text-ink/40">{c.progress}%</span>
            </div>
            <p className="text-xs text-ink/40 mb-2">{c.project}</p>
            <div className="h-1.5 bg-ink/[0.06] rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-ink/20 rounded-full"
                initial={{ width: 0 }}
                whileInView={{ width: `${c.progress}%` }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
              />
            </div>
          </motion.div>
        ))}
      </motion.div>
    </VisualShell>
  );
}

/* --- Founders: Agent Team ----------------------------------------- */

const agentRoles = [
  { role: "Research", status: "active", statusColor: "bg-emerald-500" },
  { role: "Outreach", status: "active", statusColor: "bg-emerald-500" },
  { role: "Analytics", status: "idle", statusColor: "bg-amber-500" },
  { role: "Operations", status: "active", statusColor: "bg-emerald-500" },
];

function FoundersVisual() {
  return (
    <VisualShell>
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
      >
        <motion.p variants={fadeSlideUp} className="text-[11px] font-mono uppercase tracking-wider text-ink/30 mb-4">
          Agent Team
        </motion.p>
        <div className="grid grid-cols-2 gap-2.5">
          {agentRoles.map((a) => (
            <motion.div
              key={a.role}
              variants={fadeSlideUp}
              className="p-4 rounded-xl bg-white border border-black/[0.04] flex flex-col items-center gap-2.5"
            >
              <div className="w-9 h-9 rounded-full bg-ink/[0.04] flex items-center justify-center">
                <span className="text-xs font-mono text-ink/40">
                  {a.role.charAt(0)}
                </span>
              </div>
              <span className="text-sm font-medium text-ink/70">{a.role}</span>
              <div className="flex items-center gap-1.5">
                <span className={cn("w-1.5 h-1.5 rounded-full", a.statusColor)} />
                <span className="text-[10px] font-mono text-ink/35 capitalize">{a.status}</span>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </VisualShell>
  );
}

/* --- Visual map --------------------------------------------------- */

const visualMap: Record<string, () => React.JSX.Element> = {
  product: ProductVisual,
  design: DesignVisual,
  sales: SalesVisual,
  support: SupportVisual,
  operations: OperationsVisual,
  agencies: AgenciesVisual,
  founders: FoundersVisual,
};

/* ------------------------------------------------------------------ */
/*  Hero                                                               */
/* ------------------------------------------------------------------ */

function Hero() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section
      ref={ref}
      className="relative min-h-screen flex items-center justify-center overflow-hidden bg-white"
    >
      {/* Background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-electric/5 blur-[160px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-ink/10 to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 xl:px-20 py-32 md:py-40 text-center">
        {/* Badge */}
        {inView && (
          <SpringScaleIn delay={0.1}>
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-electric mb-8">
              Use Cases
            </p>
          </SpringScaleIn>
        )}

        {/* Title */}
        {inView && (
          <div className="mb-8">
            <PerCharacterRise
              text="AI Agents for"
              as="h1"
              className="text-display-xl font-bold leading-[0.95] tracking-tight text-ink"
              delay={0.2}
            />
            <PerCharacterRise
              text="Every Team"
              as="h1"
              className="text-display-xl font-bold leading-[0.95] tracking-tight gradient-text"
              delay={0.45}
            />
          </div>
        )}

        {/* Subtitle */}
        {inView && (
          <SoftBlurIn delay={0.4}>
            <p className="text-xl md:text-2xl text-ink/50 max-w-2xl mx-auto mb-12 leading-relaxed">
              From product to support, agents transform how teams work.
            </p>
          </SoftBlurIn>
        )}

        {/* CTAs */}
        {inView && (
          <SoftBlurIn delay={0.6}>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/contact"
                className="inline-flex items-center justify-center px-8 py-4 rounded-full bg-ink text-white font-medium text-base hover:bg-ink/90 transition-colors duration-300"
              >
                Talk to Us
              </Link>
              <Link
                href="/agents"
                className="inline-flex items-center justify-center px-8 py-4 rounded-full border border-ink/15 text-ink font-medium text-base hover:bg-surface transition-colors duration-300"
              >
                Explore Agents
              </Link>
            </div>
          </SoftBlurIn>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Use case section (alternating)                                     */
/* ------------------------------------------------------------------ */

function UseCaseSection({
  useCase,
  index,
}: {
  useCase: UseCase;
  index: number;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const isReversed = index % 2 !== 0;

  const Visual = visualMap[useCase.id];

  const textContent = (
    <div className="flex flex-col justify-center">
      {/* Team label */}
      {inView && (
        <SpringScaleIn delay={0.05}>
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-electric mb-6">
            {useCase.teamLabel}
          </p>
        </SpringScaleIn>
      )}

      {/* Two-tone headline */}
      {inView && (
        <MaskRevealUp as="h2" className="mb-6" delay={0.15}>
          <span className="text-display-sm font-bold leading-[1.1] tracking-tight">
            <span className="text-ink">{useCase.headlineDark}</span>{" "}
            <span className="text-ink/40">{useCase.headlineLight}</span>
          </span>
        </MaskRevealUp>
      )}

      {/* Description */}
      {inView && (
        <SoftBlurIn delay={0.25}>
          <p className="text-ink/50 leading-relaxed text-lg mb-10 max-w-lg">
            {useCase.description}
          </p>
        </SoftBlurIn>
      )}

      {/* Metrics */}
      <div className="flex gap-12">
        {useCase.metrics.map((metric, i) => (
          <div key={metric.label}>
            {inView && (
              <PerCharacterRise
                text={metric.value}
                as="p"
                className="text-display-md font-bold text-ink leading-none mb-2"
                delay={0.35 + i * 0.12}
              />
            )}
            {inView && (
              <SoftBlurIn delay={0.45 + i * 0.12}>
                <p className="text-sm text-ink/50">{metric.label}</p>
              </SoftBlurIn>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const visualContent = (
    <div className="flex items-center justify-center">
      {inView && Visual && <Visual />}
    </div>
  );

  return (
    <section
      ref={ref}
      className="border-b border-rule-dark bg-white"
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 xl:px-16">
        <div
          className={cn(
            "grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 py-20 md:py-28 xl:py-32 items-center",
            isReversed && "lg:[direction:rtl] [&>*]:lg:[direction:ltr]"
          )}
        >
          {textContent}
          {visualContent}
        </div>
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
    <section
      ref={ref}
      className="relative py-32 md:py-44 overflow-hidden bg-white"
    >
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-b from-electric/8 via-violet-accent/5 to-white" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-electric/8 blur-[140px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 xl:px-20 text-center">
        {inView && (
          <SpringScaleIn delay={0.1}>
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-electric mb-6">
              Get Started
            </p>
          </SpringScaleIn>
        )}

        {inView && (
          <LineByLineSlide
            text={"Find Your\nUse Case"}
            as="h2"
            className="text-display-md font-bold text-ink mb-6 tracking-tight"
            delay={0.2}
          />
        )}

        {inView && (
          <SoftBlurIn delay={0.35}>
            <p className="text-xl text-ink/50 max-w-xl mx-auto mb-12 leading-relaxed">
              Every team works differently. Agent OS adapts to the way you build,
              sell, support, and operate.
            </p>
          </SoftBlurIn>
        )}

        {inView && (
          <SoftBlurIn delay={0.5}>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/contact"
                className="inline-flex items-center justify-center px-8 py-4 rounded-full bg-ink text-white font-medium text-base hover:bg-ink/90 transition-colors duration-300"
              >
                Talk to Us
              </Link>
              <Link
                href="/agents"
                className="inline-flex items-center justify-center px-8 py-4 rounded-full border border-ink/15 text-ink font-medium text-base hover:bg-surface transition-colors duration-300"
              >
                Explore Agents
              </Link>
            </div>
          </SoftBlurIn>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function UseCasesPage() {
  return (
    <main>
      <Hero />

      <div>
        {useCases.map((uc, i) => (
          <UseCaseSection key={uc.id} useCase={uc} index={i} />
        ))}
      </div>

      <CTASection />
    </main>
  );
}
