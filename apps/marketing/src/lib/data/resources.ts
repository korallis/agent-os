export interface Resource {
  title: string;
  category: string;
  description: string;
  readTime: string;
  featured: boolean;
  image: string;
}

export const resources: Resource[] = [
  {
    title: "The Beginner's Guide to AI Agents",
    category: "Guides",
    description: "Everything you need to know about AI agents, from basic concepts to advanced deployment strategies.",
    readTime: "12 min read",
    featured: true,
    image: "/autonomous-research.png",
  },
  {
    title: "Designing Human-in-the-Loop Workflows",
    category: "Guides",
    description: "How to build AI workflows that keep humans in control while maximizing agent autonomy.",
    readTime: "8 min read",
    featured: false,
    image: "/design-agent.png",
  },
  {
    title: "How Multi-Agent Systems Change SaaS",
    category: "Research",
    description: "A deep dive into how specialized agent teams are reshaping the software landscape.",
    readTime: "15 min read",
    featured: true,
    image: "/multi-agent-orchestration.png",
  },
  {
    title: "AI Agent Security Checklist",
    category: "Reports",
    description: "Essential security practices for deploying AI agents in enterprise environments.",
    readTime: "6 min read",
    featured: false,
    image: "/enterprise-security.png",
  },
  {
    title: "Workflow Automation Playbook",
    category: "Tutorials",
    description: "Step-by-step guide to building your first automated multi-agent workflow.",
    readTime: "10 min read",
    featured: false,
    image: "/automation-agent.png",
  },
  {
    title: "The Future Interface Report",
    category: "Research",
    description: "How AI agents will replace traditional software interfaces within the next decade.",
    readTime: "20 min read",
    featured: true,
    image: "/adaptive-reasoning.png",
  },
];

export const resourceCategories = [
  "All",
  "Guides",
  "Reports",
  "Product Updates",
  "Research",
  "Tutorials",
  "Templates",
];
