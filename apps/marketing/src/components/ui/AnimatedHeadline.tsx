"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { cn } from "@agent-os/ui";

interface AnimatedHeadlineProps {
  text: string;
  className?: string;
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  delay?: number;
}

export default function AnimatedHeadline({
  text,
  className,
  as: Tag = "h2",
  delay = 0,
}: AnimatedHeadlineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: "-60px" });

  const lines = text.split("\n");

  return (
    <Tag className={cn(className)}>
      <span ref={containerRef} className="block">
        {lines.map((line, lineIndex) => (
          <span key={lineIndex} className="block overflow-hidden pb-[0.15em]">
            <motion.span
              className="block"
              initial={{ y: "120%" }}
              animate={isInView ? { y: "0%" } : { y: "120%" }}
              transition={{
                duration: 0.9,
                ease: [0.22, 1, 0.36, 1],
                delay: delay + lineIndex * 0.1,
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
