"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Image from "next/image";
import { cn } from "@agent-os/ui";

interface Resource {
  title: string;
  category: string;
  description: string;
  readTime: string;
  featured: boolean;
  image: string;
}

interface ResourceCardProps {
  resource: Resource;
}

function ArrowIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="text-ink/30 transition-all duration-300 group-hover:translate-x-1 group-hover:text-ink"
    >
      <path
        d="M4 10H16M16 10L11 5M16 10L11 15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ResourceCard({ resource }: ResourceCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-3xl",
        "bg-white",
        "border border-black/[0.06]",
        "transition-all duration-500",
        "hover:-translate-y-1 hover:border-black/[0.12] hover:shadow-lg",
        "cursor-pointer",
        resource.featured && "md:col-span-2"
      )}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden",
          resource.featured ? "h-52 md:h-64" : "h-44"
        )}
      >
        <Image
          src={resource.image}
          alt={resource.title}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-cover transition-transform duration-700 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />

        <div className="absolute top-4 left-4">
          <span className="inline-flex items-center rounded-lg bg-white/80 backdrop-blur-md px-3 py-1 text-[11px] font-medium text-ink/70 border border-white/20">
            {resource.category}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 md:p-6">
        <h3
          className={cn(
            "font-bold text-ink leading-tight",
            resource.featured ? "text-xl md:text-2xl" : "text-lg"
          )}
        >
          {resource.title}
        </h3>

        <p className="mt-2.5 flex-1 text-[13px] leading-relaxed text-ink/40">
          {resource.description}
        </p>

        <div className="mt-5 flex items-center justify-between border-t border-black/[0.06] pt-4">
          <span className="text-[12px] text-ink/30 font-mono">{resource.readTime}</span>
          <ArrowIcon />
        </div>
      </div>
    </motion.div>
  );
}
