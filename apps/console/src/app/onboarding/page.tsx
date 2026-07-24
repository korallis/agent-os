import type { Metadata } from "next";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

export const metadata: Metadata = { title: "Onboarding — AgentOS" };

/**
 * Onboarding Guide — Figma frame `37:1300` (master plan §4.10 / §7 inventory).
 */
export default function OnboardingPage() {
  return <OnboardingWizard />;
}
