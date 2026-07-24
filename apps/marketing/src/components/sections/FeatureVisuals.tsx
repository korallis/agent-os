"use client";

import { useRef, useEffect, useState } from "react";
import { motion, useInView } from "framer-motion";

/* ─── Counting animation with blur ─── */
export function CountUp({
  value,
  suffix = "",
  prefix = "",
  duration = 1.6,
  className,
  delay = 0.2,
  decimals = 0,
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  duration?: number;
  className?: string;
  delay?: number;
  decimals?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const [display, setDisplay] = useState("0");
  const [blurDone, setBlurDone] = useState(false);

  // auto-detect decimals from value if not explicit
  const decimalPlaces = decimals || (String(value).includes(".") ? (String(value).split(".")[1] ?? "").length : 0);

  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    const delayMs = delay * 1000;
    let raf: number;

    function tick(now: number) {
      const elapsed = now - start - delayMs;
      if (elapsed < 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const progress = Math.min(elapsed / (duration * 1000), 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = eased * value;
      setDisplay(decimalPlaces > 0 ? current.toFixed(decimalPlaces) : String(Math.round(current)));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setBlurDone(true);
      }
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration, delay, decimalPlaces]);

  return (
    <motion.span
      ref={ref}
      className={className}
      style={{ filter: blurDone ? "blur(0px)" : inView ? "blur(4px)" : "blur(10px)", transition: "filter 0.3s ease-out" }}
      initial={{ opacity: 0 }}
      animate={inView ? { opacity: 1 } : {}}
      transition={{ opacity: { duration: 0.4, delay } }}
    >
      {prefix}{display}{suffix}
    </motion.span>
  );
}

/* ═══════════════════════════════════════════
   01: Multi-Agent Orchestration
   Hero card — actual agent monitoring UI
   ═══════════════════════════════════════════ */
export function OrchestrationVisual() {
  const agents = [
    { name: "Research", color: "#3b82f6", progress: 72 },
    { name: "Design", color: "#8b5cf6", progress: 38 },
    { name: "Support", color: "#10b981", progress: 100 },
    { name: "Sales", color: "#f59e0b", progress: 56 },
  ];

  return (
    <div className="w-full h-full flex items-center justify-center px-8 py-12 md:py-16">
      <div className="flex items-center gap-10 w-full max-w-[440px]">
        {/* Left: Big number */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="flex-shrink-0"
        >
          <CountUp value={4} className="text-[110px] md:text-[130px] font-bold text-ink leading-none tracking-tight block" />
          <span className="text-[18px] md:text-[20px] text-ink/20 font-semibold tracking-tight block -mt-2">
            agents
          </span>
          <div className="flex items-center gap-1.5 mt-3">
            <motion.div className="w-2 h-2 rounded-full bg-emerald-500" animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 2, repeat: Infinity }} />
            <span className="text-[12px] text-ink/30">3 active</span>
          </div>
        </motion.div>

        {/* Right: Agent progress bars */}
        <motion.div
          className="flex-1 min-w-0 space-y-5"
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          {agents.map((agent, i) => (
            <div key={agent.name}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: agent.color }} />
                  <span className="text-[12px] font-medium text-ink/50">{agent.name}</span>
                </div>
                <span className="text-[10px] text-ink/20 font-mono">{agent.progress}%</span>
              </div>
              <div className="h-2 bg-ink/[0.04] rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: agent.color, opacity: 0.6 }}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${agent.progress}%` }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 1.2, delay: 0.5 + i * 0.12, ease: "easeOut" }}
                />
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   02: Contextual Memory
   Metric card — big stat + visual insight
   ═══════════════════════════════════════════ */
export function MemoryVisual() {
  return (
    <div className="w-full h-full flex items-center justify-center px-8 py-12 md:py-16">
      <div className="flex items-center gap-10 w-full max-w-[440px]">
        {/* Left: Big number */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="flex-shrink-0"
        >
          <span className="text-[110px] md:text-[130px] font-bold text-ink leading-none tracking-tight block">
            <CountUp value={67} suffix="" className="" /><span className="text-[62px] md:text-[73px] text-ink/30">%</span>
          </span>
          <span className="text-[14px] text-ink/30 block mt-1">
            context utilization
          </span>
        </motion.div>

        {/* Right: Memory progress bars */}
        <motion.div
          className="flex-1 min-w-0 space-y-5"
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          {[
            { label: "Long-term", value: "128 docs", fill: 85, color: "#8b5cf6" },
            { label: "Working", value: "24 active", fill: 62, color: "#3b82f6" },
            { label: "Shared", value: "3 agents", fill: 47, color: "#10b981" },
          ].map((mem, i) => (
            <div key={mem.label}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-medium text-ink/50">{mem.label}</span>
                <span className="text-[10px] text-ink/20 font-mono">{mem.value}</span>
              </div>
              <div className="h-2 bg-ink/[0.04] rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: mem.color, opacity: 0.5 }}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${mem.fill}%` }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 1, delay: 0.5 + i * 0.15, ease: "easeOut" }}
                />
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   03: Adaptive Reasoning
   Actual reasoning trace UI panel
   ═══════════════════════════════════════════ */
export function ReasoningVisual() {
  const steps = [
    { name: "Parse Intent", detail: "analysis + recommendation", status: "done" as const, dur: "120ms" },
    { name: "Select Strategy", detail: "Multi-step chain", status: "done" as const, dur: "45ms" },
    { name: "Retrieve Context", detail: "4 sources, 12 docs", status: "done" as const, dur: "340ms" },
    { name: "Analyze Data", detail: "Pricing elasticity", status: "active" as const, dur: "1.2s" },
    { name: "Generate Output", detail: "Waiting", status: "pending" as const, dur: "—" },
  ];

  return (
    <div className="w-full h-full flex flex-col justify-center px-6 md:px-8 pb-6 pt-0">
      {/* Confidence badge */}
      <motion.div
        className="flex items-center gap-2 mb-6"
        initial={{ opacity: 0, y: -6 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <div className="flex items-center gap-1.5 bg-emerald-50 px-3 py-1.5 rounded-full">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span className="text-[12px] text-emerald-600 font-bold"><CountUp value={94} suffix="% confidence" className="" /></span>
        </div>
        <span className="text-[11px] text-ink/20 font-mono">5 steps · 4,291 tokens</span>
      </motion.div>

      {/* Big stepper */}
      <div className="space-y-0">
        {steps.map((step, i) => (
          <motion.div
            key={step.name}
            className="flex items-stretch gap-4"
            initial={{ opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.35, delay: 0.15 + i * 0.08 }}
          >
            {/* Stepper rail */}
            <div className="flex flex-col items-center flex-shrink-0 w-10">
              <div className={`w-10 h-10 flex items-center justify-center rounded-2xl ${
                step.status === "done" ? "bg-emerald-50" :
                step.status === "active" ? "bg-blue-50" :
                "bg-ink/[0.03]"
              }`}>
                {step.status === "done" ? (
                  <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : step.status === "active" ? (
                  <motion.div className="w-3 h-3 rounded-full bg-blue-500" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-ink/10" />
                )}
              </div>
              {i < steps.length - 1 && (
                <div className={`w-px flex-1 my-1 ${
                  step.status !== "pending" ? "bg-ink/[0.08]" : "bg-ink/[0.04]"
                }`} />
              )}
            </div>

            {/* Step content */}
            <div className="flex-1 min-w-0 pb-5">
              <div className="flex items-center justify-between">
                <span className={`text-[15px] font-semibold ${
                  step.status === "pending" ? "text-ink/25" : "text-ink"
                }`}>{step.name}</span>
                <span className={`text-[11px] font-mono ${
                  step.status === "pending" ? "text-ink/10" : "text-ink/20"
                }`}>{step.dur}</span>
              </div>
              <p className={`text-[12px] mt-0.5 ${
                step.status === "pending" ? "text-ink/15" : "text-ink/35"
              }`}>{step.detail}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   04: Enterprise Security
   Metric card — compliance badges + big stat
   ═══════════════════════════════════════════ */
export function SecurityVisual() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-6 pb-6 pt-0 text-center">
      {/* Shield icon */}
      <motion.div
        className="mb-5"
        initial={{ opacity: 0, scale: 0.8 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <div className="w-[72px] h-[72px] bg-emerald-50 border border-emerald-100 flex items-center justify-center mx-auto rounded-2xl">
          <svg className="w-9 h-9 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
        </div>
      </motion.div>

      {/* Compliance badges */}
      <motion.div
        className="flex gap-2 mb-6"
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        {[
          { name: "SOC 2", color: "border-emerald-200 bg-emerald-50 text-emerald-700" },
          { name: "GDPR", color: "border-blue-200 bg-blue-50 text-blue-700" },
          { name: "HIPAA", color: "border-violet-200 bg-violet-50 text-violet-700" },
        ].map((cert) => (
          <span key={cert.name} className={`text-[13px] font-bold px-4 py-2 border rounded-full ${cert.color}`}>{cert.name}</span>
        ))}
      </motion.div>

      {/* Big stat */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.6, delay: 0.3 }}
      >
        <span className="text-[83px] md:text-[94px] font-bold text-ink leading-none tracking-tight">
          <CountUp value={100} className="" /><span className="text-[47px] md:text-[52px] text-ink/30">%</span>
        </span>
      </motion.div>
      <motion.p
        className="text-base text-ink/40 mt-2"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.5, delay: 0.4 }}
      >
        of actions audited
      </motion.p>

      {/* Encryption note */}
      <motion.div
        className="flex items-center gap-1.5 mt-5 text-ink/20"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.5, delay: 0.5 }}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>
        <span className="text-[12px] font-mono">AES-256 end-to-end</span>
      </motion.div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   05: Universal Integrations
   Logo grid with real brand SVGs
   ═══════════════════════════════════════════ */
export function IntegrationsVisual() {
  const apps = [
    { name: "Slack",
      logo: <svg viewBox="0 0 2447.6 2452.5" className="w-full h-full"><g clipRule="evenodd" fillRule="evenodd"><path d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z" fill="#36c5f0"/><path d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z" fill="#2eb67d"/><path d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z" fill="#ecb22e"/><path d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0" fill="#e01e5a"/></g></svg> },
    { name: "GitHub",
      logo: <svg viewBox="0 0 1024 1024" className="w-full h-full"><path fillRule="evenodd" clipRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" transform="scale(64)" fill="#181717"/></svg> },
    { name: "Notion",
      logo: <svg viewBox="0 0 256 268" className="w-full h-full" preserveAspectRatio="xMidYMid"><path fill="#FFF" d="M16.092 11.538 164.09.608c18.179-1.56 22.85-.508 34.28 7.801l47.243 33.282C253.406 47.414 256 48.975 256 55.207v182.527c0 11.439-4.155 18.205-18.696 19.24L65.44 267.378c-10.913.517-16.11-1.043-21.825-8.327L8.826 213.814C2.586 205.487 0 199.254 0 191.97V29.726c0-9.352 4.155-17.153 16.092-18.188Z"/><path d="M164.09.608 16.092 11.538C4.155 12.573 0 20.374 0 29.726v162.245c0 7.284 2.585 13.516 8.826 21.843l34.789 45.237c5.715 7.284 10.912 8.844 21.825 8.327l171.864-10.404c14.532-1.035 18.696-7.801 18.696-19.24V55.207c0-5.911-2.336-7.614-9.21-12.66l-1.185-.856L198.37 8.409C186.94.1 182.27-.952 164.09.608ZM69.327 52.22c-14.033.945-17.216 1.159-25.186-5.323L23.876 30.778c-2.06-2.086-1.026-4.69 4.163-5.207l142.274-10.395c11.947-1.043 18.17 3.12 22.842 6.758l24.401 17.68c1.043.525 3.638 3.637.517 3.637L71.146 52.095l-1.819.125Zm-16.36 183.954V81.222c0-6.767 2.077-9.887 8.3-10.413L230.02 60.93c5.724-.517 8.31 3.12 8.31 9.879v153.917c0 6.767-1.044 12.49-10.387 13.008l-161.487 9.361c-9.343.517-13.489-2.594-13.489-10.921ZM212.377 89.53c1.034 4.681 0 9.362-4.681 9.897l-7.783 1.542v114.404c-6.758 3.637-12.981 5.715-18.18 5.715-8.308 0-10.386-2.604-16.609-10.396l-50.898-80.079v77.476l16.1 3.646s0 9.362-12.989 9.362l-35.814 2.077c-1.043-2.086 0-7.284 3.63-8.318l9.351-2.595V109.823l-12.98-1.052c-1.043-5.733 3.111-9.896 8.3-10.404l38.426-2.585 52.958 81.113v-71.76l-13.498-1.552c-1.043-5.733 3.111-9.896 8.3-10.404l35.84-2.087Z"/></svg> },
    { name: "Linear",
      logo: <svg viewBox="0 0 100 100" className="w-full h-full" fill="none"><path fill="#5E6AD2" d="M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.69.69.092 1.82-.857 1.597-18.425-4.323-32.93-18.827-37.252-37.252ZM.002 46.889a.99.99 0 0 0 .29.76L52.35 99.71c.201.2.478.307.76.29 2.37-.149 4.695-.46 6.963-.927.765-.157 1.03-1.096.478-1.648L2.576 39.448c-.552-.551-1.491-.286-1.648.479a50.067 50.067 0 0 0-.926 6.962ZM4.21 29.705a.988.988 0 0 0 .208 1.1l64.776 64.776c.289.29.726.375 1.1.208a49.908 49.908 0 0 0 5.185-2.684.981.981 0 0 0 .183-1.54L8.436 24.336a.981.981 0 0 0-1.541.183 49.896 49.896 0 0 0-2.684 5.185Zm8.448-11.631a.986.986 0 0 1-.045-1.354C21.78 6.46 35.111 0 49.952 0 77.592 0 100 22.407 100 50.048c0 14.84-6.46 28.172-16.72 37.338a.986.986 0 0 1-1.354-.045L12.659 18.074Z"/></svg> },
    { name: "Gmail",
      logo: <svg viewBox="0 49.4 512 399.42" className="w-full h-full"><g fill="none" fillRule="evenodd"><g fillRule="nonzero"><path fill="#4285f4" d="M34.91 448.818h81.454V251L0 163.727V413.91c0 19.287 15.622 34.91 34.91 34.91z"/><path fill="#34a853" d="M395.636 448.818h81.455c19.287 0 34.909-15.622 34.909-34.909V163.727L395.636 251z"/><path fill="#fbbc04" d="M395.636 99.727V251L512 163.727v-46.545c0-43.142-49.25-67.782-83.782-41.891z"/></g><path fill="#ea4335" d="M116.364 251V99.727L256 204.455 395.636 99.727V251L256 355.727z"/><path fill="#c5221f" fillRule="nonzero" d="M0 117.182v46.545L116.364 251V99.727L83.782 75.291C49.25 49.4 0 74.04 0 117.18z"/></g></svg> },
    { name: "Figma",
      logo: <svg viewBox="0 0 54 80" className="w-full h-full" fill="none"><g clipPath="url(#figma-clip)"><path d="M13.3333 80.0002C20.6933 80.0002 26.6667 74.0268 26.6667 66.6668V53.3335H13.3333C5.97333 53.3335 0 59.3068 0 66.6668C0 74.0268 5.97333 80.0002 13.3333 80.0002Z" fill="#0ACF83"/><path d="M0 39.9998C0 32.6398 5.97333 26.6665 13.3333 26.6665H26.6667V53.3332H13.3333C5.97333 53.3332 0 47.3598 0 39.9998Z" fill="#A259FF"/><path d="M0 13.3333C0 5.97333 5.97333 0 13.3333 0H26.6667V26.6667H13.3333C5.97333 26.6667 0 20.6933 0 13.3333Z" fill="#F24E1E"/><path d="M26.6667 0H40.0001C47.3601 0 53.3334 5.97333 53.3334 13.3333C53.3334 20.6933 47.3601 26.6667 40.0001 26.6667H26.6667V0Z" fill="#FF7262"/><path d="M53.3334 39.9998C53.3334 47.3598 47.3601 53.3332 40.0001 53.3332C32.6401 53.3332 26.6667 47.3598 26.6667 39.9998C26.6667 32.6398 32.6401 26.6665 40.0001 26.6665C47.3601 26.6665 53.3334 32.6398 53.3334 39.9998Z" fill="#1ABCFE"/></g><defs><clipPath id="figma-clip"><rect width="53.3333" height="80" fill="white"/></clipPath></defs></svg> },
  ];

  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-6 pb-6 pt-0">
      {/* App icon grid */}
      <motion.div
        className="grid grid-cols-3 gap-x-8 gap-y-6"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        {apps.map((app, i) => (
          <motion.div
            key={app.name}
            className="flex flex-col items-center gap-2.5"
            initial={{ opacity: 0, scale: 0.85 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.35, delay: 0.15 + i * 0.06 }}
          >
            <div className="w-14 h-14 md:w-16 md:h-16 flex items-center justify-center p-3 bg-ink/[0.03] rounded-2xl hover:bg-ink/[0.06] transition-colors">
              {app.logo}
            </div>
            <span className="text-[11px] font-medium text-ink/40">{app.name}</span>
          </motion.div>
        ))}
      </motion.div>

      {/* Status line */}
      <motion.div
        className="flex items-center gap-2 mt-8"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.4, delay: 0.5 }}
      >
        <motion.div className="w-2 h-2 rounded-full bg-emerald-400" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />
        <span className="text-[12px] text-ink/30">500+ integrations available</span>
      </motion.div>
    </div>
  );
}
