export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  longDescription: string;
  icon: string;
  capabilities: string[];
  useCases: string[];
  color: string;
}

export const agents: Agent[] = [
  {
    id: "research",
    name: "Research Agent",
    slug: "research-agent",
    description: "Scans sources, summarizes insights, and turns messy information into structured decisions.",
    longDescription: "An autonomous research partner that scans sources, summarizes insights, compares options, and turns messy information into structured decisions.",
    icon: "🔬",
    capabilities: ["Market research", "Competitor analysis", "Source summarization", "Trend scanning", "Report generation", "Decision briefs"],
    useCases: ["Product strategy", "Market entry", "Competitive intelligence", "Due diligence"],
    color: "#3b82f6",
  },
  {
    id: "design",
    name: "Design Agent",
    slug: "design-agent",
    description: "Transforms research and requirements into structured design directions and briefs.",
    longDescription: "A creative intelligence that transforms research, references, and product requirements into structured design directions.",
    icon: "🎨",
    capabilities: ["Design research", "Moodboard generation", "Brief creation", "Asset organization", "Feedback synthesis", "Design QA"],
    useCases: ["Product design", "Brand identity", "UI/UX research", "Design systems"],
    color: "#8b5cf6",
  },
  {
    id: "sales",
    name: "Sales Agent",
    slug: "sales-agent",
    description: "Researches accounts, personalizes outreach, and summarizes opportunities automatically.",
    longDescription: "A revenue intelligence agent that researches accounts, personalizes outreach, and summarizes opportunities automatically.",
    icon: "📈",
    capabilities: ["Account research", "Personalized outreach", "Pipeline analysis", "Opportunity scoring", "Meeting prep", "Follow-up automation"],
    useCases: ["Enterprise sales", "Outbound campaigns", "Account management", "Revenue ops"],
    color: "#22d3ee",
  },
  {
    id: "support",
    name: "Support Agent",
    slug: "support-agent",
    description: "Handles tickets, routes conversations, and resolves issues with context and speed.",
    longDescription: "A support intelligence that handles tickets, routes conversations, and resolves issues with full context and speed.",
    icon: "💬",
    capabilities: ["Ticket triage", "Auto-responses", "Escalation routing", "Knowledge retrieval", "Sentiment analysis", "Resolution tracking"],
    useCases: ["Customer support", "Internal help desk", "Community management", "SLA management"],
    color: "#10b981",
  },
  {
    id: "data",
    name: "Data Agent",
    slug: "data-agent",
    description: "Queries databases, generates reports, and surfaces insights across your data stack.",
    longDescription: "A data intelligence that queries databases, generates reports, and surfaces insights across your entire data stack.",
    icon: "📊",
    capabilities: ["Data querying", "Report generation", "Anomaly detection", "Dashboard creation", "Metric tracking", "Data cleaning"],
    useCases: ["Business intelligence", "Analytics", "Data ops", "Reporting automation"],
    color: "#f59e0b",
  },
  {
    id: "automation",
    name: "Automation Agent",
    slug: "automation-agent",
    description: "Connects tools, triggers workflows, and executes multi-step automations across systems.",
    longDescription: "A workflow intelligence that connects tools, triggers workflows, and executes multi-step automations across your entire system.",
    icon: "⚡",
    capabilities: ["Workflow creation", "Tool connection", "Trigger management", "Conditional logic", "Error handling", "Schedule automation"],
    useCases: ["Process automation", "System integration", "DevOps", "Operations"],
    color: "#ef4444",
  },
  {
    id: "voice",
    name: "Voice Agent",
    slug: "voice-agent",
    description: "Understands spoken input, generates natural responses, and powers voice-first interfaces.",
    longDescription: "A conversational intelligence that understands spoken input, generates natural responses, and powers voice-first interfaces.",
    icon: "🎙️",
    capabilities: ["Speech recognition", "Natural language", "Voice synthesis", "Conversation flow", "Multi-language", "Tone adaptation"],
    useCases: ["Voice assistants", "Call centers", "Accessibility", "Voice commerce"],
    color: "#ec4899",
  },
  {
    id: "vision",
    name: "Vision Agent",
    slug: "vision-agent",
    description: "Analyzes images, documents, and visual data to extract structured information.",
    longDescription: "A visual intelligence that analyzes images, documents, screens, and visual data to extract structured information.",
    icon: "👁️",
    capabilities: ["Image analysis", "Document parsing", "OCR extraction", "Visual QA", "Screenshot analysis", "Chart reading"],
    useCases: ["Document processing", "Visual inspection", "Content moderation", "Data extraction"],
    color: "#06b6d4",
  },
  {
    id: "workflow",
    name: "Workflow Agent",
    slug: "workflow-agent",
    description: "Orchestrates multi-agent systems and coordinates complex multi-step processes.",
    longDescription: "An orchestration intelligence that coordinates multi-agent systems and manages complex multi-step processes across your organization.",
    icon: "🔄",
    capabilities: ["Agent orchestration", "Process design", "Dependency management", "Parallel execution", "State management", "Error recovery"],
    useCases: ["Complex workflows", "Cross-team processes", "Multi-agent coordination", "Enterprise automation"],
    color: "#6366f1",
  },
];
