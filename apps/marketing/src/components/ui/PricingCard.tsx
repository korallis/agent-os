"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { cn } from "@agent-os/ui";
import { CountUp } from "@/components/sections/FeatureVisuals";
import MagneticButton from "./MagneticButton";

interface PricingPlan {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  cta: string;
  highlighted: boolean;
}

interface PricingCardProps {
  plan: PricingPlan;
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0 text-electric-light"
    >
      <path
        d="M3 8.5L6.5 12L13 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function PricingCard({ plan }: PricingCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
      className={cn(
        "relative flex flex-col rounded-3xl p-6 md:p-8",
        plan.highlighted
          ? "bg-ink text-white shadow-[0_0_60px_rgba(0,0,0,0.15)] scale-[1.02] md:scale-105"
          : "bg-white border border-black/[0.06]"
      )}
    >
      {/* Popular badge */}
      {plan.highlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="rounded-full bg-electric px-4 py-1 text-xs font-semibold text-white">
            Popular
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h3 className={cn("text-lg font-semibold", plan.highlighted ? "text-white" : "text-ink")}>{plan.name}</h3>
        <div className="mt-3 flex items-baseline gap-1">
          <span className={cn("text-4xl font-bold tracking-tight md:text-5xl", plan.highlighted ? "text-white" : "text-ink")}>
            {plan.price.startsWith("$") ? (
              <><span>$</span><CountUp value={parseInt(plan.price.replace("$", ""))} delay={0.3} duration={1.2} /></>
            ) : plan.price}
          </span>
          <span className={cn("text-sm", plan.highlighted ? "text-white/50" : "text-ink/50")}>{plan.period}</span>
        </div>
        <p className={cn("mt-3 text-sm leading-relaxed", plan.highlighted ? "text-white/60" : "text-ink/50")}>
          {plan.description}
        </p>
      </div>

      {/* Divider */}
      <div className={cn("mb-6 h-px w-full", plan.highlighted ? "bg-white/10" : "bg-black/[0.06]")} />

      {/* Features */}
      <ul className="mb-8 flex flex-1 flex-col gap-3">
        {plan.features.map((feature, index) => (
          <li key={index} className="flex items-start gap-3">
            {plan.highlighted ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-electric-light">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <CheckIcon />
            )}
            <span className={cn("text-sm", plan.highlighted ? "text-white/70" : "text-ink/60")}>{feature}</span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      <MagneticButton
        href="/contact"
        variant="secondary"
        size="md"
        className={cn(
          "w-full justify-center",
          plan.highlighted && "!bg-white !text-ink !border-white hover:!bg-white/90"
        )}
      >
        {plan.cta}
      </MagneticButton>
    </motion.div>
  );
}
