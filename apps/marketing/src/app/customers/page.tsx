"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { fadeUp, staggerContainer, staggerContainerSlow } from "@agent-os/ui";
import { MagneticButton } from "@agent-os/ui";
import PageHero from "@/components/sections/PageHero";
import { GlassCard } from "@agent-os/ui";
import { customerStories } from "@/lib/data/customers";

const metrics = [
  { value: "42%", label: "Faster research cycles" },
  { value: "3.5x", label: "More workflows automated" },
  { value: "60%", label: "Less manual reporting" },
  { value: "28hrs", label: "Saved per team weekly" },
];

function MetricsSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-surface via-white to-surface" />
      <div className="relative z-10 section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="grid grid-cols-2 md:grid-cols-4 gap-6"
        >
          {metrics.map((metric) => (
            <motion.div key={metric.label} variants={fadeUp} className="text-center">
              <div className="text-display-md font-bold gradient-text mb-2">{metric.value}</div>
              <p className="text-ink/50 text-sm">{metric.label}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function StoriesSection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section ref={ref} className="py-20 md:py-32">
      <div className="section-padding max-container">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="text-center mb-16"
        >
          <motion.p variants={fadeUp} className="text-electric text-sm font-medium tracking-wider uppercase mb-4">
            Customer Stories
          </motion.p>
          <motion.h2 variants={fadeUp} className="text-display-sm font-bold text-ink mb-4">
            How Teams Use Agent OS
          </motion.h2>
        </motion.div>

        <motion.div
          variants={staggerContainerSlow}
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          className="space-y-8"
        >
          {customerStories.map((story, i) => (
            <motion.div key={story.company} variants={fadeUp}>
              <GlassCard className="p-8 md:p-10">
                <div className="flex flex-col md:flex-row gap-8">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-electric to-violet-accent flex items-center justify-center text-white font-bold text-sm">
                        {story.company[0]}
                      </div>
                      <div>
                        <h3 className="font-bold text-ink">{story.company}</h3>
                        <span className="text-xs text-ink/40">{story.industry}</span>
                      </div>
                    </div>
                    <blockquote className="text-lg text-ink/60 mb-4 italic leading-relaxed">
                      &ldquo;{story.quote}&rdquo;
                    </blockquote>
                    <p className="text-ink/50 text-sm">{story.summary}</p>
                  </div>
                  <div className="flex items-center justify-center md:w-48 shrink-0">
                    <div className="text-center">
                      <div className="text-display-sm font-bold gradient-text">{story.metric}</div>
                      <p className="text-ink/50 text-sm mt-1">{story.metricLabel}</p>
                    </div>
                  </div>
                </div>
              </GlassCard>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

export default function CustomersPage() {
  return (
    <main>
      <PageHero
        badge="Customers"
        title={"Teams Are Already Designing\nWork Around Agents"}
        subtitle="See how modern teams use Agent OS to automate research, operations, sales, and support."
      />

      <MetricsSection />
      <StoriesSection />

      <section className="py-20 md:py-32 text-center">
        <div className="section-padding max-container">
          <h2 className="text-display-sm font-bold text-ink mb-6">
            Join the Teams Building With Agents
          </h2>
          <p className="text-xl text-ink/50 max-w-xl mx-auto mb-10">
            Start automating your workflows with intelligent AI agents.
          </p>
          <MagneticButton href="/contact" variant="primary" size="lg">
            Get Started
          </MagneticButton>
        </div>
      </section>
    </main>
  );
}
