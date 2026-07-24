"use client";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@agent-os/ui";
import { fadeUp, staggerContainer } from "@agent-os/ui";

interface IntegrationItem {
  name: string;
  category: string;
  icon: string;
}

interface IntegrationGridProps {
  integrations: IntegrationItem[];
  categories: string[];
}

export default function IntegrationGrid({
  integrations,
  categories,
}: IntegrationGridProps) {
  const [activeCategory, setActiveCategory] = useState("All");

  const allCategories = useMemo(() => ["All", ...categories], [categories]);

  const filtered = useMemo(
    () =>
      activeCategory === "All"
        ? integrations
        : integrations.filter((i) => i.category === activeCategory),
    [activeCategory, integrations]
  );

  return (
    <section className="section-padding py-24 md:py-32">
      <div className="max-container">
        {/* Category filter tabs */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-16">
          {allCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "relative rounded-full px-5 py-2.5 text-sm font-medium transition-all duration-300 cursor-pointer",
                activeCategory === cat
                  ? "bg-ink text-white"
                  : "bg-white text-ink/50 border border-ink/10 hover:text-ink hover:border-ink/20"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Integration grid */}
        <motion.div
          layout
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6"
        >
          <AnimatePresence mode="popLayout">
            {filtered.map((integration) => (
              <motion.div
                key={integration.name}
                layout
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                whileHover={{
                  y: -4,
                  boxShadow: "0 0 30px rgba(59,130,246,0.1), 0 8px 24px rgba(0,0,0,0.06)",
                  transition: { duration: 0.25 },
                }}
                className={cn(
                  "group relative rounded-3xl p-6",
                  "bg-[rgba(0,0,0,0.03)] backdrop-blur-xl",
                  "border border-[rgba(0,0,0,0.06)]",
                  "transition-colors duration-300",
                  "hover:border-[rgba(0,0,0,0.12)]",
                  "flex flex-col items-center text-center"
                )}
              >
                {/* Icon */}
                <div className="text-4xl mb-4 transition-transform duration-300 group-hover:scale-110">
                  {integration.icon}
                </div>

                {/* Name */}
                <h4 className="text-sm font-semibold text-ink mb-2">
                  {integration.name}
                </h4>

                {/* Category badge */}
                <span className="inline-block rounded-lg px-3 py-1 text-[11px] font-medium text-ink/50 glass">
                  {integration.category}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>

        {/* Marquee row */}
        <div className="relative mt-20 overflow-hidden">
          {/* Left fade mask */}
          <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-24 z-10 bg-gradient-to-r from-white to-transparent" />
          {/* Right fade mask */}
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-24 z-10 bg-gradient-to-l from-white to-transparent" />

          <div className="flex animate-marquee whitespace-nowrap">
            {/* Duplicate the list for seamless loop */}
            {[...integrations, ...integrations].map((integration, index) => (
              <span
                key={`${integration.name}-${index}`}
                className="mx-6 text-lg font-medium text-ink/30 flex-shrink-0"
              >
                {integration.icon} {integration.name}
              </span>
            ))}
          </div>

          <style jsx>{`
            @keyframes marquee {
              0% {
                transform: translateX(0%);
              }
              100% {
                transform: translateX(-50%);
              }
            }
            .animate-marquee {
              animation: marquee 30s linear infinite;
            }
          `}</style>
        </div>
      </div>
    </section>
  );
}
