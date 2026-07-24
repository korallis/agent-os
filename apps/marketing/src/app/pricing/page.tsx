"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import dynamic from "next/dynamic";
import { fadeUp, staggerContainer } from "@agent-os/ui";
import { MagneticButton } from "@agent-os/ui";
import PageHero from "@/components/sections/PageHero";
import PricingCard from "@/components/ui/PricingCard";
const FAQAccordion = dynamic(() => import("@/components/ui/FAQAccordion"));
import { pricingPlans, faqs } from "@/lib/data/pricing";

export default function PricingPage() {
  const pricingRef = useRef(null);
  const pricingInView = useInView(pricingRef, { once: true, margin: "-60px" });
  const faqRef = useRef(null);
  const faqInView = useInView(faqRef, { once: true, margin: "-60px" });

  return (
    <main>
      <PageHero
        badge="Pricing"
        title={"Scale From One Agent\nto an Intelligent Workforce"}
        subtitle="Simple plans for individuals, teams, and enterprises building with AI agents."
      />

      <section ref={pricingRef} className="py-12 md:py-16">
        <div className="section-padding max-container">
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate={pricingInView ? "visible" : "hidden"}
            className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8"
          >
            {pricingPlans.map((plan) => (
              <motion.div key={plan.name} variants={fadeUp}>
                <PricingCard plan={plan} />
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <section ref={faqRef} className="py-20 md:py-32 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-white via-surface/30 to-white" />
        <div className="relative z-10 section-padding max-container">
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate={faqInView ? "visible" : "hidden"}
            className="text-center mb-16"
          >
            <motion.h2 variants={fadeUp} className="text-display-sm font-bold text-ink mb-4">
              Frequently Asked Questions
            </motion.h2>
          </motion.div>
          <div className="max-w-3xl mx-auto">
            <FAQAccordion items={faqs} />
          </div>
        </div>
      </section>

      <section className="py-20 md:py-32 text-center">
        <div className="section-padding max-container">
          <h2 className="text-display-sm font-bold text-ink mb-6">
            Ready to Get Started?
          </h2>
          <p className="text-xl text-ink/50 max-w-xl mx-auto mb-10">
            Start free. Upgrade when your team is ready.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <MagneticButton href="/contact" variant="primary" size="lg">
              Start Free
            </MagneticButton>
            <MagneticButton href="/contact" variant="secondary" size="lg">
              Talk to Sales
            </MagneticButton>
          </div>
        </div>
      </section>
    </main>
  );
}
