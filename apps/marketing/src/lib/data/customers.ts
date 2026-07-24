export interface CustomerStory {
  company: string;
  industry: string;
  quote: string;
  metric: string;
  metricLabel: string;
  summary: string;
}

export const customerStories: CustomerStory[] = [
  {
    company: "Nexus Labs",
    industry: "Startup",
    quote: "Agent OS turned our 3-day research process into a 2-hour workflow. Our team ships decisions faster than ever.",
    metric: "42%",
    metricLabel: "Faster research cycles",
    summary: "Scaling research workflows with autonomous agents that scan, compare, and summarize market intelligence.",
  },
  {
    company: "Prism Agency",
    industry: "Agency",
    quote: "Client reporting used to take our team an entire day. Now it happens automatically while we focus on strategy.",
    metric: "3.5x",
    metricLabel: "More workflows automated",
    summary: "Automating client reporting with multi-agent systems that pull data, generate insights, and format deliverables.",
  },
  {
    company: "CloudSync",
    industry: "SaaS",
    quote: "Our support response time dropped dramatically. Agents handle triage and the team handles relationships.",
    metric: "60%",
    metricLabel: "Less manual reporting",
    summary: "Improving support response with intelligent ticket triage, context retrieval, and automated first-responses.",
  },
  {
    company: "Velocity Sales",
    industry: "Sales",
    quote: "Every outreach email is now personalized with real research. Our reply rates have never been higher.",
    metric: "28hrs",
    metricLabel: "Saved per team weekly",
    summary: "Personalizing outreach at scale with research agents that analyze accounts before every touchpoint.",
  },
  {
    company: "BuildRight",
    industry: "Product",
    quote: "Feedback from 12 channels now flows into structured decisions. No more spreadsheet chaos.",
    metric: "85%",
    metricLabel: "Feedback processed automatically",
    summary: "Organizing product feedback with agents that collect, categorize, and surface actionable patterns.",
  },
];
