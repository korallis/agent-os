import type { Metadata } from "next";
import { PoliciesModal } from "@/components/policies/PoliciesModal";

export const metadata: Metadata = { title: "Policies — AgentOS" };

export default function PoliciesPage() {
  return <PoliciesModal />;
}
