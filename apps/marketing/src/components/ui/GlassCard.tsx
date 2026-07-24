"use client";

import { useRef, useState } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { cn } from "@agent-os/ui";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  glow?: string;
}

export default function GlassCard({
  children,
  className,
  hover = true,
  glow,
}: GlassCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const springRotateX = useSpring(rotateX, { stiffness: 200, damping: 20 });
  const springRotateY = useSpring(rotateY, { stiffness: 200, damping: 20 });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!hover || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const mouseX = e.clientX - centerX;
    const mouseY = e.clientY - centerY;

    const maxTilt = 3;
    const tiltX = -(mouseY / (rect.height / 2)) * maxTilt;
    const tiltY = (mouseX / (rect.width / 2)) * maxTilt;

    rotateX.set(tiltX);
    rotateY.set(tiltY);
  };

  const handleMouseLeave = () => {
    rotateX.set(0);
    rotateY.set(0);
    setIsHovered(false);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const glowShadow =
    isHovered && glow
      ? `0 0 40px ${glow}33, 0 0 80px ${glow}1a`
      : isHovered
        ? "0 0 40px rgba(59,130,246,0.1), 0 8px 32px rgba(0,0,0,0.08)"
        : "0 4px 20px rgba(0,0,0,0.06)";

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        rotateX: hover ? springRotateX : 0,
        rotateY: hover ? springRotateY : 0,
        transformPerspective: 800,
        boxShadow: glowShadow,
      }}
      {...(hover ? { whileHover: { scale: 1.02 } } : {})}
      transition={{ type: "spring", stiffness: 200, damping: 20 }}
      className={cn(
        "rounded-3xl",
        "bg-white backdrop-blur-xl",
        "border border-black/[0.06]",
        hover && "transition-shadow duration-300",
        hover && isHovered && "border-black/[0.12]",
        className
      )}
    >
      {children}
    </motion.div>
  );
}
