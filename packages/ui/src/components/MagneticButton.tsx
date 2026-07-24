"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { cn } from "../lib/cn";

interface MagneticButtonProps {
  children: React.ReactNode;
  href?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  onClick?: () => void;
}

const sizeClasses = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-3 text-base",
  lg: "px-8 py-4 text-lg",
};

/**
 * The magnetic pill CTA used across the marketing site — shared so every
 * Agent OS surface renders the same button language.
 */
export function MagneticButton({
  children,
  href,
  variant = "primary",
  size = "md",
  className,
  onClick,
}: MagneticButtonProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distX = e.clientX - centerX;
    const distY = e.clientY - centerY;
    setPosition({ x: distX * 0.2, y: distY * 0.2 });
  };

  const handleMouseLeave = () => {
    setPosition({ x: 0, y: 0 });
  };

  const baseClasses = cn(
    "relative inline-flex items-center justify-center rounded-full font-medium transition-colors overflow-hidden cursor-pointer",
    sizeClasses[size],
    className
  );

  const variantClasses = cn(
    variant === "primary" &&
      "bg-ink text-white hover:bg-ink/90",
    variant === "secondary" &&
      "bg-white text-ink border border-ink/20 hover:border-ink/40",
    variant === "ghost" && "bg-transparent text-ink group"
  );

  const sweepElement = variant !== "ghost" && (
    <span className="absolute inset-0 z-0 overflow-hidden">
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
    </span>
  );

  const ghostUnderline = variant === "ghost" && (
    <span className="absolute bottom-0 left-1/2 h-px w-0 -translate-x-1/2 bg-ink transition-all duration-300 group-hover:w-full" />
  );

  const inner = (
    <>
      {sweepElement}
      <span className="relative z-10">{children}</span>
      {ghostUnderline}
    </>
  );

  if (href) {
    return (
      <div
        ref={ref}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="inline-block"
      >
        <motion.div
          animate={{ x: position.x, y: position.y }}
          transition={{ type: "spring", stiffness: 200, damping: 20, mass: 0.5 }}
        >
          <Link
            href={href}
            className={cn(baseClasses, variantClasses, "group")}
            {...(onClick ? { onClick } : {})}
          >
            {inner}
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="inline-block"
    >
      <motion.button
        animate={{ x: position.x, y: position.y }}
        transition={{ type: "spring", stiffness: 200, damping: 20, mass: 0.5 }}
        className={cn(baseClasses, variantClasses, "group")}
        onClick={onClick}
      >
        {inner}
      </motion.button>
    </div>
  );
}
