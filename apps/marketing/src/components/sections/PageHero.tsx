"use client";

import { motion } from "framer-motion";
import { PerCharacterRise } from "@agent-os/ui";
import { fadeUp } from "@agent-os/ui";

interface PageHeroProps {
  title: string;
  subtitle: string;
  badge?: string;
  children?: React.ReactNode;
}

export default function PageHero({
  title,
  subtitle,
  badge,
  children,
}: PageHeroProps) {
  const lines = title.split("\n");

  return (
    <section className="relative pt-28 pb-12 md:pt-36 md:pb-16 flex items-center justify-center overflow-hidden section-padding">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full opacity-20 blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(59,130,246,0.15) 0%, rgba(139,92,246,0.08) 40%, transparent 70%)",
        }}
      />

      <div className="relative z-10 max-container w-full flex flex-col items-center text-center">
        {badge && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="mb-8"
          >
            <span className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-ink/60 glass">
              <span className="h-1.5 w-1.5 rounded-full bg-electric animate-glow-pulse" />
              {badge}
            </span>
          </motion.div>
        )}

        <div className="max-w-5xl mx-auto mb-8">
          {lines.map((line, i) => (
            <PerCharacterRise
              key={i}
              text={line}
              as="h1"
              className={`text-display-lg font-bold ${i === 0 ? "text-ink" : "gradient-text"}`}
              delay={0.15 + i * 0.25}
            />
          ))}
        </div>

        <motion.p
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.5 }}
          className="max-w-4xl mx-auto text-lg md:text-xl text-ink/50 leading-relaxed mb-10"
        >
          {subtitle}
        </motion.p>

        {children && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.8,
              ease: [0.25, 0.46, 0.45, 0.94],
              delay: 0.7,
            }}
            className="flex flex-wrap items-center justify-center gap-4"
          >
            {children}
          </motion.div>
        )}
      </div>
    </section>
  );
}
