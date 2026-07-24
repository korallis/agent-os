"use client";

import { useRef, useState } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import { fadeUp, staggerContainer } from "@agent-os/ui";
import PageHero from "@/components/sections/PageHero";
import ResourceCard from "@/components/ui/ResourceCard";
import { resources, resourceCategories } from "@/lib/data/resources";

export default function ResourcesPage() {
  const [activeCategory, setActiveCategory] = useState("All");
  const gridRef = useRef(null);
  const gridInView = useInView(gridRef, { once: true, margin: "-60px" });

  const filteredResources = activeCategory === "All"
    ? resources
    : resources.filter((r) => r.category === activeCategory);

  return (
    <main>
      <PageHero
        badge="Resources"
        title={"Learn the Future\nof Agentic Work"}
        subtitle="Guides, research, playbooks, and updates for teams designing AI agent workflows."
      />

      <section ref={gridRef} className="py-20 md:py-32">
        <div className="section-padding max-container">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={gridInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6 }}
            className="flex flex-wrap gap-2 mb-12"
          >
            {resourceCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2 rounded-full text-sm transition-all duration-300 ${
                  activeCategory === cat
                    ? "bg-ink text-white"
                    : "glass text-ink/50 hover:text-ink hover:border-ink/10"
                }`}
              >
                {cat}
              </button>
            ))}
          </motion.div>

          <motion.div
            layout
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            <AnimatePresence mode="popLayout">
              {filteredResources.map((resource) => (
                <motion.div
                  key={resource.title}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.4 }}
                  className={resource.featured ? "md:col-span-2" : ""}
                >
                  <ResourceCard resource={resource} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </div>
      </section>

      <section className="py-20 md:py-32 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-white via-surface/30 to-white" />
        <div className="relative z-10 section-padding max-container text-center">
          <h2 className="text-display-sm font-bold text-ink mb-4">
            Stay Updated
          </h2>
          <p className="text-xl text-ink/50 max-w-xl mx-auto mb-8">
            Get the latest guides, research, and product updates delivered to your inbox.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
            <input
              type="email"
              placeholder="Your email"
              className="flex-1 px-4 py-3 rounded-2xl bg-black/[0.03] border border-ink/10 text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2 focus:ring-electric/50 transition-all"
            />
            <button className="px-6 py-3 rounded-full bg-ink text-white font-medium hover:bg-ink/90 transition-colors">
              Subscribe
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
