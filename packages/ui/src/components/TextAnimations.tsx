"use client";

import { useRef, ReactNode } from "react";
import { motion, useInView, Variants } from "framer-motion";
import { cn } from "../lib/cn";

/* ------------------------------------------------------------------ */
/*  Soft Blur In                                                       */
/* ------------------------------------------------------------------ */

interface SoftBlurInProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  as?: "div" | "span" | "p" | "h1" | "h2" | "h3" | "h4";
}

export function SoftBlurIn({
  children,
  className,
  delay = 0,
  duration = 0.8,
  as = "div",
}: SoftBlurInProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const Tag = motion[as] as typeof motion.div;

  return (
    <Tag
      ref={ref}
      className={cn(className)}
      initial={{ opacity: 0, filter: "blur(12px)" }}
      animate={
        inView
          ? { opacity: 1, filter: "blur(0px)" }
          : { opacity: 0, filter: "blur(12px)" }
      }
      transition={{ duration, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Spring Scale In                                                    */
/* ------------------------------------------------------------------ */

interface SpringScaleInProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "span" | "p" | "h1" | "h2" | "h3" | "h4";
}

export function SpringScaleIn({
  children,
  className,
  delay = 0,
  as = "div",
}: SpringScaleInProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const Tag = motion[as] as typeof motion.div;

  return (
    <Tag
      ref={ref}
      className={cn(className)}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={
        inView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }
      }
      transition={{
        type: "spring",
        stiffness: 150,
        damping: 18,
        delay,
      }}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Per Character Rise                                                 */
/* ------------------------------------------------------------------ */

interface PerCharacterRiseProps {
  text: string;
  className?: string;
  delay?: number;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span";
}

export function PerCharacterRise({
  text,
  className,
  delay = 0,
  as: Tag = "h2",
}: PerCharacterRiseProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  const words = text.split(" ");
  let charIndex = 0;

  return (
    <Tag ref={ref} className={cn(className)} aria-label={text}>
      {words.map((word, wi) => {
        const startIndex = charIndex;
        charIndex += word.length;

        return (
          <span key={wi} className="inline-flex" style={{ whiteSpace: "nowrap" }}>
            {word.split("").map((char, ci) => (
              <motion.span
                key={ci}
                className="inline-block"
                initial={{ y: "100%", opacity: 0 }}
                animate={
                  inView ? { y: "0%", opacity: 1 } : { y: "100%", opacity: 0 }
                }
                transition={{
                  duration: 0.5,
                  delay: delay + (startIndex + ci) * 0.025,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {char}
              </motion.span>
            ))}
            {wi < words.length - 1 && (
              <motion.span
                className="inline-block"
                style={{ whiteSpace: "pre" }}
                initial={{ y: "100%", opacity: 0 }}
                animate={
                  inView ? { y: "0%", opacity: 1 } : { y: "100%", opacity: 0 }
                }
                transition={{
                  duration: 0.5,
                  delay: delay + charIndex * 0.025,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {" "}
              </motion.span>
            )}
            {(() => { charIndex += 1; return null; })()}
          </span>
        );
      })}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Mask Reveal Up — for 1-2 line headings                             */
/* ------------------------------------------------------------------ */

interface MaskRevealUpProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div";
}

export function MaskRevealUp({
  children,
  className,
  delay = 0,
  as: Tag = "div",
}: MaskRevealUpProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <Tag ref={ref} className={cn("overflow-hidden", className)}>
      <motion.span
        className="block"
        initial={{ y: "110%", opacity: 0 }}
        animate={
          inView ? { y: "0%", opacity: 1 } : { y: "110%", opacity: 0 }
        }
        transition={{
          duration: 0.9,
          delay,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        {children}
      </motion.span>
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Line-by-Line Slide — multi-line text split by \n                   */
/* ------------------------------------------------------------------ */

interface LineByLineSlideProps {
  text: string;
  className?: string;
  lineClassName?: string;
  delay?: number;
  stagger?: number;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "div";
}

export function LineByLineSlide({
  text,
  className,
  lineClassName,
  delay = 0,
  stagger = 0.12,
  as: Tag = "h2",
}: LineByLineSlideProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const lines = text.split("\n");

  return (
    <Tag ref={ref} className={cn(className)}>
      {lines.map((line, i) => (
        <span key={i} className="block overflow-hidden pb-[0.15em]">
          <motion.span
            className={cn("block", lineClassName)}
            initial={{ y: "120%", opacity: 0 }}
            animate={
              inView
                ? { y: "0%", opacity: 1 }
                : { y: "120%", opacity: 0 }
            }
            transition={{
              duration: 0.9,
              delay: delay + i * stagger,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Short Slide Down — for 3+ line blocks                              */
/* ------------------------------------------------------------------ */

interface ShortSlideDownProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "p" | "span" | "h1" | "h2" | "h3" | "h4";
}

export function ShortSlideDown({
  children,
  className,
  delay = 0,
  as = "div",
}: ShortSlideDownProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const Tag = motion[as] as typeof motion.div;

  return (
    <Tag
      ref={ref}
      className={cn(className)}
      initial={{ y: -30, opacity: 0 }}
      animate={inView ? { y: 0, opacity: 1 } : { y: -30, opacity: 0 }}
      transition={{
        duration: 0.7,
        delay,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/*  Mask Reveal Image                                                  */
/* ------------------------------------------------------------------ */

interface MaskRevealImageProps {
  src: string;
  alt: string;
  className?: string;
  containerClassName?: string;
  delay?: number;
  direction?: "up" | "down" | "left" | "right";
  fill?: boolean;
  width?: number;
  height?: number;
}

export function MaskRevealImage({
  src,
  alt,
  className,
  containerClassName,
  delay = 0,
  direction = "up",
}: MaskRevealImageProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });

  const clipPaths: Record<
    NonNullable<MaskRevealImageProps["direction"]>,
    { hidden: string; visible: string }
  > = {
    up: { hidden: "inset(100% 0 0 0)", visible: "inset(0 0 0 0)" },
    down: { hidden: "inset(0 0 100% 0)", visible: "inset(0 0 0 0)" },
    left: { hidden: "inset(0 100% 0 0)", visible: "inset(0 0 0 0)" },
    right: { hidden: "inset(0 0 0 100%)", visible: "inset(0 0 0 0)" },
  };

  const clip = clipPaths[direction];

  return (
    <div
      ref={ref}
      className={cn("overflow-hidden relative", containerClassName)}
    >
      <motion.div
        className="absolute inset-0 overflow-hidden"
        initial={{ clipPath: clip.hidden, opacity: 0 }}
        animate={
          inView
            ? { clipPath: clip.visible, opacity: 1 }
            : { clipPath: clip.hidden, opacity: 0 }
        }
        transition={{
          duration: 1.2,
          delay: inView ? delay : 0,
          ease: [0.25, 0.46, 0.45, 0.94],
        }}
      >
        <motion.div
          className="absolute inset-0"
          initial={{ scale: 1.15 }}
          animate={inView ? { scale: 1 } : { scale: 1.15 }}
          transition={{
            duration: 1.6,
            delay: inView ? delay : 0,
            ease: [0.25, 0.46, 0.45, 0.94],
          }}
        >
          <img
            src={src}
            alt={alt}
            loading="eager"
            decoding="async"
            className={cn(
              "absolute inset-0 w-full h-full object-cover",
              className
            )}
          />
        </motion.div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Animated Card                                                      */
/* ------------------------------------------------------------------ */

interface AnimatedCardProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  index?: number;
  hover?: boolean;
}

export function AnimatedCard({
  children,
  className,
  delay = 0,
  index = 0,
  hover = true,
}: AnimatedCardProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      className={cn(className)}
      initial={{ opacity: 0, y: 60, scale: 0.95 }}
      animate={
        inView
          ? { opacity: 1, y: 0, scale: 1 }
          : { opacity: 0, y: 60, scale: 0.95 }
      }
      transition={{
        duration: 0.7,
        delay: delay + index * 0.1,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      {...(hover
        ? {
            whileHover: {
              y: -8,
              transition: { duration: 0.3, ease: "easeOut" as const },
            },
          }
        : {})}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stagger Wrapper                                                    */
/* ------------------------------------------------------------------ */

const staggerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

export function StaggerContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      className={cn(className)}
      variants={staggerVariants}
      initial="hidden"
      animate={inView ? "visible" : "hidden"}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div className={cn(className)} variants={staggerChild}>
      {children}
    </motion.div>
  );
}
