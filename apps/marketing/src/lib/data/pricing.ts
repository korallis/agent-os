export interface PricingPlan {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  cta: string;
  highlighted: boolean;
}

export const pricingPlans: PricingPlan[] = [
  {
    name: "Starter",
    price: "$29",
    period: "/month",
    description: "For individuals exploring AI agents",
    features: [
      "3 active agents",
      "Basic workflows",
      "Limited memory (1GB)",
      "Community support",
      "5 integrations",
      "Basic analytics",
    ],
    cta: "Start Free",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$99",
    period: "/month",
    description: "For growing teams building with agents",
    features: [
      "Unlimited agents",
      "Advanced workflows",
      "Full memory (50GB)",
      "Priority support",
      "All integrations",
      "Advanced analytics",
      "Multi-agent collaboration",
      "Custom triggers",
    ],
    cta: "Start Free",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For organizations scaling AI operations",
    features: [
      "Everything in Pro",
      "Custom permissions & SSO",
      "Audit logs & compliance",
      "Dedicated infrastructure",
      "Advanced security",
      "Custom onboarding",
      "SLA guarantee",
      "Dedicated account manager",
    ],
    cta: "Talk to Sales",
    highlighted: false,
  },
];

export const faqs = [
  {
    question: "What is an AI agent?",
    answer: "An AI agent is an autonomous system that can understand context, make decisions, and execute tasks across your tools and workflows. Unlike simple chatbots, agents can reason, remember, and take multi-step actions.",
  },
  {
    question: "How does Agent OS differ from a single AI assistant?",
    answer: "Agent OS provides a team of specialized agents, each optimized for different tasks. Instead of one generalist, you get research, design, sales, and support agents that collaborate and share context.",
  },
  {
    question: "Is my data secure?",
    answer: "Yes. Agent OS uses enterprise-grade encryption, role-based access controls, audit logging, and human approval gates. Every agent action is logged, visible, and reversible.",
  },
  {
    question: "Can I control what agents do?",
    answer: "Absolutely. Every workflow can include human approval steps, permission boundaries, and action limits. You decide what agents can do autonomously and what requires your sign-off.",
  },
  {
    question: "What integrations are supported?",
    answer: "Agent OS connects to 50+ tools including Slack, Notion, Gmail, GitHub, Figma, HubSpot, Salesforce, and more. Custom integrations are available via our API.",
  },
  {
    question: "Can I try Agent OS for free?",
    answer: "Yes. The Starter plan includes a free trial with 3 agents, basic workflows, and community support. No credit card required to start.",
  },
];
