"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "../lib/cn";

export interface SiteHeaderLink {
  label: string;
  href: string;
}

interface SiteHeaderProps {
  /** Inline links shown in the centered desktop nav. */
  primaryLinks: SiteHeaderLink[];
  /** Full link list for the slide-in menu panel. */
  menuLinks: SiteHeaderLink[];
  /** Solid ink pill with the arrow, right of the menu button (hidden on mobile). */
  cta?: SiteHeaderLink;
  /** Extra chrome (e.g. a live status chip) rendered left of the menu button. */
  statusSlot?: ReactNode;
  /** Content of the menu panel's bottom info block. */
  menuFooter?: ReactNode;
  logoHref?: string;
}

/**
 * The Agent OS fixed header/nav shell — logo wordmark, centered inline
 * links, pill menu button with the animated burger, slide-in right menu
 * panel with numbered rows. Promoted from the marketing site so every
 * Agent OS surface shares one header language.
 */
export function SiteHeader({
  primaryLinks,
  menuLinks,
  cta,
  statusSlot,
  menuFooter,
  logoHref = "/",
}: SiteHeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      <header
        className={cn(
          "fixed top-0 left-0 right-0 z-50 transition-all duration-500",
          scrolled
            ? "bg-white/90 backdrop-blur-xl border-b border-black/[0.06] shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
            : "bg-white/70 backdrop-blur-lg"
        )}
      >
        <div className="flex items-center justify-between h-14 lg:h-16 px-6 md:px-8 lg:px-12">
          {/* Logo */}
          <Link href={logoHref} className="relative z-[60] flex-shrink-0 group">
            <motion.span
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="text-lg font-bold text-ink tracking-tight"
            >
              Agent OS<span className="text-ink/30">.</span>
            </motion.span>
          </Link>

          {/* Center: Inline nav links (desktop only) */}
          <motion.nav
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="hidden lg:flex items-center gap-1"
          >
            {primaryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200",
                  isActive(link.href)
                    ? "text-ink"
                    : "text-ink/40 hover:text-ink"
                )}
              >
                {link.label}
              </Link>
            ))}
          </motion.nav>

          {/* Right: status slot + menu + CTA */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative z-[60] flex items-center gap-2"
          >
            {statusSlot}

            {/* Menu Button */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center gap-3 rounded-full px-4 py-2 border border-ink/10 hover:border-ink/25 transition-colors duration-300 group"
            >
              <span className="text-[13px] font-medium text-ink/60 group-hover:text-ink transition-colors">
                {menuOpen ? "Close" : "Menu"}
              </span>
              <div className="flex flex-col items-center justify-center w-4 h-3.5 gap-[4px]">
                <motion.span
                  animate={menuOpen ? { rotate: 45, y: 3 } : { rotate: 0, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="block h-[1.5px] w-4 origin-center bg-ink"
                />
                <motion.span
                  animate={menuOpen ? { rotate: -45, y: -3 } : { rotate: 0, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="block h-[1.5px] w-4 origin-center bg-ink"
                />
              </div>
            </button>

            {cta && (
              <Link
                href={cta.href}
                className="hidden sm:flex items-center gap-3 rounded-full px-4 py-2 bg-ink text-white hover:bg-ink/90 transition-colors duration-300 group"
              >
                <span className="text-[13px] font-medium">{cta.label}</span>
                <svg className="w-3.5 h-3.5 transition-transform duration-300 group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
            )}
          </motion.div>
        </div>
      </header>

      {/* Right-side slide-in menu panel */}
      <AnimatePresence>
        {menuOpen && (
          <>
            {/* Dark overlay on left */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
            />

            {/* Right panel — white background */}
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
              className="fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[480px] lg:w-[520px] bg-white overflow-y-auto"
            >
              {/* Top spacer for header */}
              <div className="h-20" />

              {/* Nav links */}
              <nav className="px-8 md:px-12 py-6">
                <div className="space-y-0">
                  {menuLinks.map((link, index) => (
                    <motion.div
                      key={link.href}
                      initial={{ opacity: 0, x: 30 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{
                        duration: 0.35,
                        delay: index * 0.04,
                        ease: [0.25, 0.1, 0.25, 1],
                      }}
                      className="border-b border-ink/[0.06]"
                    >
                      <Link
                        href={link.href}
                        onClick={() => setMenuOpen(false)}
                        className="group flex items-center justify-between py-4"
                      >
                        <div className="flex items-center gap-4">
                          <span className={cn(
                            "text-xs font-mono tabular-nums w-7",
                            isActive(link.href) ? "text-electric-dark" : "text-ink/25"
                          )}>
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className={cn(
                            "text-lg md:text-xl font-semibold transition-colors duration-200",
                            isActive(link.href)
                              ? "text-electric-dark"
                              : "text-ink group-hover:text-electric-dark"
                          )}>
                            {link.label}
                          </span>
                        </div>
                        <motion.span
                          initial={{ x: -5, opacity: 0 }}
                          whileHover={{ x: 0, opacity: 1 }}
                          className="text-electric-dark"
                        >
                          <svg className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                          </svg>
                        </motion.span>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </nav>

              {/* Bottom info */}
              {menuFooter && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="px-8 md:px-12 py-8 mt-4 border-t border-ink/[0.06]"
                >
                  {menuFooter}
                </motion.div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
