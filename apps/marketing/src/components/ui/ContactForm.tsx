"use client";

import { useState, useRef } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import { cn } from "@agent-os/ui";
import MagneticButton from "./MagneticButton";

interface ContactFormProps {
  className?: string;
}

const teamSizeOptions = ["1-10", "11-50", "51-200", "200+"];
const useCaseOptions = [
  "Research",
  "Sales",
  "Support",
  "Automation",
  "Custom",
];

const inputClasses = cn(
  "w-full rounded-2xl border border-black/10 bg-surface px-4 py-3",
  "text-sm text-ink placeholder:text-ink/30",
  "outline-none transition-all duration-200",
  "focus:border-electric/50 focus:ring-2 focus:ring-electric/20"
);

const labelClasses = "mb-1.5 block text-sm font-medium text-ink/60";

export default function ContactForm({ className }: ContactFormProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: "-60px" });
  const [submitted, setSubmitted] = useState(false);

  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    teamSize: "",
    useCase: "",
    message: "",
  });

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  const fields = [
    {
      name: "name",
      label: "Name",
      type: "input",
      placeholder: "Your full name",
    },
    {
      name: "email",
      label: "Work Email",
      type: "input",
      inputType: "email",
      placeholder: "you@company.com",
    },
    {
      name: "company",
      label: "Company",
      type: "input",
      placeholder: "Company name",
    },
    {
      name: "teamSize",
      label: "Team Size",
      type: "select",
      options: teamSizeOptions,
      placeholder: "Select team size",
    },
    {
      name: "useCase",
      label: "Primary Use Case",
      type: "select",
      options: useCaseOptions,
      placeholder: "Select use case",
    },
    {
      name: "message",
      label: "Message",
      type: "textarea",
      placeholder: "Tell us about your use case...",
    },
  ] as const;

  return (
    <div ref={containerRef} className={cn("w-full", className)}>
      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            {/* Check circle */}
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-electric to-cyan">
              <svg
                width="32"
                height="32"
                viewBox="0 0 32 32"
                fill="none"
              >
                <path
                  d="M8 16.5L13.5 22L24 10"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3 className="text-2xl font-bold text-ink">
              Thanks! We&apos;ll be in touch.
            </h3>
            <p className="mt-2 text-ink/50">
              Our team will reach out within 24 hours.
            </p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            onSubmit={handleSubmit}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="space-y-5"
          >
            {fields.map((field, index) => (
              <motion.div
                key={field.name}
                initial={{ opacity: 0, y: 20 }}
                animate={
                  isInView
                    ? { opacity: 1, y: 0 }
                    : { opacity: 0, y: 20 }
                }
                transition={{
                  duration: 0.4,
                  ease: "easeOut",
                  delay: index * 0.08,
                }}
              >
                <label htmlFor={field.name} className={labelClasses}>
                  {field.label}
                </label>

                {field.type === "input" && (
                  <input
                    id={field.name}
                    name={field.name}
                    type={
                      "inputType" in field
                        ? field.inputType
                        : "text"
                    }
                    placeholder={field.placeholder}
                    value={form[field.name as keyof typeof form]}
                    onChange={handleChange}
                    className={inputClasses}
                    required
                  />
                )}

                {field.type === "select" && (
                  <select
                    id={field.name}
                    name={field.name}
                    value={form[field.name as keyof typeof form]}
                    onChange={handleChange}
                    className={cn(
                      inputClasses,
                      "appearance-none cursor-pointer",
                      !form[field.name as keyof typeof form] &&
                        "text-ink/30"
                    )}
                    required
                  >
                    <option value="" disabled>
                      {field.placeholder}
                    </option>
                    {"options" in field &&
                      field.options.map((opt) => (
                        <option
                          key={opt}
                          value={opt}
                          className="bg-white text-ink"
                        >
                          {opt}
                        </option>
                      ))}
                  </select>
                )}

                {field.type === "textarea" && (
                  <textarea
                    id={field.name}
                    name={field.name}
                    placeholder={field.placeholder}
                    value={form[field.name as keyof typeof form]}
                    onChange={handleChange}
                    rows={4}
                    className={cn(inputClasses, "resize-none")}
                  />
                )}
              </motion.div>
            ))}

            {/* Submit */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={
                isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }
              }
              transition={{
                duration: 0.4,
                ease: "easeOut",
                delay: fields.length * 0.08,
              }}
              className="pt-2"
            >
              <MagneticButton
                variant="primary"
                size="lg"
                className="w-full justify-center"
                onClick={() => {}}
              >
                Book a Demo
              </MagneticButton>
            </motion.div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
