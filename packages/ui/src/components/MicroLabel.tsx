import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface MicroLabelProps {
  children: ReactNode;
  className?: string;
  as?: "span" | "p" | "div" | "dt" | "dd" | "th";
}

/**
 * The Geist Mono uppercase micro-label idiom
 * (`text-xs font-mono uppercase tracking-[0.2em]`) used for metadata
 * rows across the marketing site — shared so console surfaces render
 * the same language.
 */
export function MicroLabel({
  children,
  className,
  as: Tag = "span",
}: MicroLabelProps) {
  return (
    <Tag className={cn("text-xs font-mono uppercase tracking-[0.2em]", className)}>
      {children}
    </Tag>
  );
}
