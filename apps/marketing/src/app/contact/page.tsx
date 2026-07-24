"use client";

import { useRef, useState } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import { PerCharacterRise, SoftBlurIn } from "@agent-os/ui";

const inputClasses =
  "w-full rounded-2xl border border-ink/[0.08] bg-white px-5 py-4 text-[15px] text-ink placeholder:text-ink/30 outline-none transition-all duration-300 focus:border-electric/40 focus:bg-surface backdrop-blur-sm";

const labelClasses = "mb-2 block text-[13px] font-medium text-ink/50 tracking-wide";

const teamSizeOptions = ["1-10", "11-50", "51-200", "200+"];
const useCaseOptions = ["Research", "Sales", "Support", "Automation", "Custom"];

function ContactForm() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    teamSize: "",
    useCase: "",
    message: "",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <div ref={ref}>
      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-electric to-cyan-soft">
              <svg width="36" height="36" viewBox="0 0 32 32" fill="none">
                <path d="M8 16.5L13.5 22L24 10" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h3 className="text-3xl font-bold text-ink mb-3">We&apos;ll be in touch</h3>
            <p className="text-ink/50 text-lg">Our team will reach out within 24 hours.</p>
          </motion.div>
        ) : (
          <motion.form key="form" onSubmit={handleSubmit} exit={{ opacity: 0 }} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {[
                { name: "name", label: "Name", placeholder: "Your full name", type: "input" },
                { name: "email", label: "Work Email", placeholder: "you@company.com", type: "input", inputType: "email" },
                { name: "company", label: "Company", placeholder: "Company name", type: "input" },
                { name: "teamSize", label: "Team Size", placeholder: "Select team size", type: "select", options: teamSizeOptions },
              ].map((field, i) => (
                <motion.div
                  key={field.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={inView ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.5, delay: 0.1 + i * 0.06 }}
                >
                  <label htmlFor={field.name} className={labelClasses}>{field.label}</label>
                  {field.type === "input" ? (
                    <input
                      id={field.name}
                      name={field.name}
                      type={field.inputType || "text"}
                      placeholder={field.placeholder}
                      value={form[field.name as keyof typeof form]}
                      onChange={handleChange}
                      className={inputClasses}
                      required
                    />
                  ) : (
                    <select
                      id={field.name}
                      name={field.name}
                      value={form[field.name as keyof typeof form]}
                      onChange={handleChange}
                      className={`${inputClasses} appearance-none cursor-pointer ${!form[field.name as keyof typeof form] ? "text-ink/30" : ""}`}
                      required
                    >
                      <option value="" disabled>{field.placeholder}</option>
                      {field.options?.map((opt) => (
                        <option key={opt} value={opt} className="bg-white text-ink">{opt}</option>
                      ))}
                    </select>
                  )}
                </motion.div>
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.35 }}
            >
              <label htmlFor="useCase" className={labelClasses}>Primary Use Case</label>
              <select
                id="useCase"
                name="useCase"
                value={form.useCase}
                onChange={handleChange}
                className={`${inputClasses} appearance-none cursor-pointer ${!form.useCase ? "text-ink/30" : ""}`}
                required
              >
                <option value="" disabled>Select use case</option>
                {useCaseOptions.map((opt) => (
                  <option key={opt} value={opt} className="bg-white text-ink">{opt}</option>
                ))}
              </select>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.4 }}
            >
              <label htmlFor="message" className={labelClasses}>Message</label>
              <textarea
                id="message"
                name="message"
                placeholder="Tell us about your use case..."
                value={form.message}
                onChange={handleChange}
                rows={4}
                className={`${inputClasses} resize-none`}
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.45 }}
              className="pt-3"
            >
              <button
                type="submit"
                className="w-full py-4 rounded-full bg-ink text-white text-[15px] font-semibold transition-all duration-300 hover:bg-ink/90 active:scale-[0.98]"
              >
                Book a Demo
              </button>
            </motion.div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

const steps = [
  { icon: "01", title: "Review your workflow", description: "Our team analyzes your current processes and identifies automation opportunities." },
  { icon: "02", title: "Map agent opportunities", description: "We design a custom agent configuration tailored to your team's needs." },
  { icon: "03", title: "Demo the right system", description: "See Agent OS in action with a personalized walkthrough of your use case." },
  { icon: "04", title: "Get an automation plan", description: "Receive a detailed plan for deploying agents across your workflows." },
];

const contactMethods = [
  { label: "Email", value: "hello@agentos.ai", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  )},
  { label: "Response time", value: "Within 24 hours", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )},
  { label: "Enterprise", value: "Custom onboarding", icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
    </svg>
  )},
];

export default function ContactPage() {
  const stepsRef = useRef(null);
  const stepsInView = useInView(stepsRef, { once: true, margin: "-60px" });
  const methodsRef = useRef(null);
  const methodsInView = useInView(methodsRef, { once: true, margin: "-60px" });

  return (
    <main className="bg-white">
      {/* Hero */}
      <section className="relative min-h-[50vh] flex items-center justify-center overflow-hidden pt-32 pb-16 section-padding">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[600px] rounded-full opacity-20 blur-[140px]"
          style={{ background: "radial-gradient(ellipse at center, rgba(59,130,246,0.5) 0%, rgba(139,92,246,0.2) 40%, transparent 70%)" }}
        />
        <div className="relative z-10 max-container w-full text-center">
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6 }}
            className="mb-6"
          >
            <span className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-ink/60 border border-ink/[0.08] bg-black/[0.03]">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              Available now
            </span>
          </motion.div>

          <div className="max-w-4xl mx-auto mb-6">
            <PerCharacterRise text="Let's Build Your" as="h1" className="text-display-lg font-bold text-ink" delay={0.1} />
            <PerCharacterRise text="Agent System" as="h1" className="text-display-lg font-bold gradient-text" delay={0.35} />
          </div>

          <SoftBlurIn delay={0.5} className="max-w-2xl mx-auto">
            <p className="text-lg text-ink/50 leading-relaxed">
              Tell us about your workflows and we&apos;ll show you how Agent OS can automate them.
            </p>
          </SoftBlurIn>
        </div>
      </section>

      {/* Contact methods strip */}
      <section ref={methodsRef} className="border-y border-ink/[0.06]">
        <div className="section-padding max-container">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-ink/[0.06]">
            {contactMethods.map((method, i) => (
              <motion.div
                key={method.label}
                initial={{ opacity: 0, y: 20 }}
                animate={methodsInView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="flex items-center gap-4 py-6 md:py-8 md:px-8 first:md:pl-0 last:md:pr-0"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-black/[0.05] border border-ink/[0.08] flex items-center justify-center text-ink/40">
                  {method.icon}
                </div>
                <div>
                  <p className="text-[13px] text-ink/40">{method.label}</p>
                  <p className="text-[15px] text-ink font-medium">{method.value}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Form + Steps */}
      <section className="py-20 md:py-32">
        <div className="section-padding max-container">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-16 lg:gap-24">
            {/* Form */}
            <div>
              <SoftBlurIn delay={0.1}>
                <h2 className="text-2xl font-bold text-ink mb-2">Book a demo</h2>
                <p className="text-ink/40 text-[15px] mb-10">Fill out the form and our team will get back to you shortly.</p>
              </SoftBlurIn>
              <ContactForm />
            </div>

            {/* Steps */}
            <div ref={stepsRef} className="lg:pt-16">
              <motion.p
                initial={{ opacity: 0 }}
                animate={stepsInView ? { opacity: 1 } : {}}
                transition={{ duration: 0.5 }}
                className="text-[13px] font-medium text-ink/40 tracking-wider uppercase mb-8"
              >
                What happens next
              </motion.p>

              <div className="space-y-0">
                {steps.map((step, i) => (
                  <motion.div
                    key={step.icon}
                    initial={{ opacity: 0, x: 20 }}
                    animate={stepsInView ? { opacity: 1, x: 0 } : {}}
                    transition={{ delay: 0.15 + i * 0.12, duration: 0.5 }}
                    className="relative pl-12 pb-10 last:pb-0"
                  >
                    {i < steps.length - 1 && (
                      <div className="absolute left-[15px] top-8 bottom-0 w-px bg-gradient-to-b from-ink/10 to-transparent" />
                    )}
                    <div className="absolute left-0 top-0 w-8 h-8 rounded-full border border-ink/[0.1] bg-black/[0.03] flex items-center justify-center">
                      <span className="text-[11px] font-mono text-electric">{step.icon}</span>
                    </div>
                    <h4 className="text-[15px] font-semibold text-ink mb-1.5">{step.title}</h4>
                    <p className="text-[13px] text-ink/40 leading-relaxed">{step.description}</p>
                  </motion.div>
                ))}
              </div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={stepsInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="mt-10 p-5 rounded-3xl border border-ink/[0.06] bg-black/[0.02]"
              >
                <p className="text-[13px] text-ink/40 mb-1">Prefer email?</p>
                <p className="text-[15px] text-ink">
                  Reach us at <span className="text-electric font-medium">hello@agentos.ai</span>
                </p>
              </motion.div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
