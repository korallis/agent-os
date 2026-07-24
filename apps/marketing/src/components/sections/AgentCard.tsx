"use client";

import { useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { cn } from "@agent-os/ui";
import { fadeUp } from "@agent-os/ui";

interface AgentCardProps {
  agent: {
    name: string;
    description: string;
    icon: string;
    capabilities: string[];
    color: string;
    slug: string;
  };
}

export default function AgentCard({ agent }: AgentCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  return (
    <motion.div
      ref={cardRef}
      variants={fadeUp}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      whileHover={{ y: -8, transition: { duration: 0.3, ease: "easeOut" } }}
      className="relative group"
    >
      <Link
        href={`/agents/${agent.slug}`}
        className={cn(
          "relative block rounded-3xl overflow-hidden p-8",
          "bg-[rgba(0,0,0,0.03)] backdrop-blur-xl",
          "border border-[rgba(0,0,0,0.06)]",
          "transition-all duration-300"
        )}
        style={{
          boxShadow: isHovered
            ? `0 0 40px ${agent.color}22, 0 0 80px ${agent.color}11, 0 20px 40px rgba(0,0,0,0.08)`
            : "0 4px 20px rgba(0,0,0,0.06)",
          borderColor: isHovered
            ? `${agent.color}40`
            : "rgba(0,0,0,0.06)",
        }}
      >
        {/* Cursor-follow radial light */}
        {isHovered && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
            style={{
              background: `radial-gradient(300px circle at ${mousePos.x}px ${mousePos.y}px, ${agent.color}15, transparent 60%)`,
            }}
          />
        )}

        <div className="relative z-10">
          {/* Icon */}
          <div
            className="w-16 h-16 rounded-xl flex items-center justify-center text-3xl mb-6 transition-transform duration-300 group-hover:scale-110"
            style={{
              background: `${agent.color}12`,
              border: `1px solid ${agent.color}25`,
            }}
          >
            {agent.icon}
          </div>

          {/* Name */}
          <h3 className="text-xl font-bold text-ink mb-3">{agent.name}</h3>

          {/* Description */}
          <p className="text-ink/50 text-sm leading-relaxed mb-6">
            {agent.description}
          </p>

          {/* Capabilities pills */}
          <div className="flex flex-wrap gap-2 mb-6">
            {agent.capabilities.slice(0, 4).map((cap) => (
              <span
                key={cap}
                className="inline-block rounded-lg px-3 py-1 text-xs font-medium glass"
                style={{
                  color: `${agent.color}`,
                  borderColor: `${agent.color}20`,
                }}
              >
                {cap}
              </span>
            ))}
          </div>

          {/* CTA */}
          <div className="flex items-center gap-2 text-sm font-medium transition-colors duration-200"
            style={{ color: agent.color }}
          >
            <span>View Agent</span>
            <svg
              className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
