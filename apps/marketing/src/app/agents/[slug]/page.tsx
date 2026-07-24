"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import { useParams, notFound } from "next/navigation";
import {
  SoftBlurIn,
  SpringScaleIn,
  PerCharacterRise,
  MaskRevealUp,
  LineByLineSlide,
  AnimatedCard,
  StaggerContainer,
  StaggerItem,
} from "@agent-os/ui";

/* ------------------------------------------------------------------ */
/*  Agent Data                                                         */
/* ------------------------------------------------------------------ */

interface AgentDetail {
  slug: string;
  name: string;
  tagline: string;
  taglineLine2: string;
  badge: string;
  heroDescription: string;
  color: string;
  accentGlow: string;
  overviewHeading: string;
  overviewParagraphs: string[];
  stats: { label: string; value: string }[];
  capabilities: {
    title: string;
    description: string;
    icon: string;
  }[];
  workflowSteps: { label: string; description: string; color: string }[];
  integrations: string[];
  ctaHeading: string;
  ctaHeadingLine2: string;
  ctaDescription: string;
  ctaButton: string;
}

const agentDetails: Record<string, AgentDetail> = {
  research: {
    slug: "research",
    name: "Research Agent",
    tagline: "Autonomous Research",
    taglineLine2: "That Drives Decisions",
    badge: "Research Agent",
    heroDescription:
      "An intelligent research partner that scans sources, summarizes insights, compares options, and turns messy information into structured decisions.",
    color: "#3b82f6",
    accentGlow: "electric",
    overviewHeading: "Research That Moves at the Speed of Thought",
    overviewParagraphs: [
      "The Research Agent eliminates the hours you spend gathering, reading, comparing, and synthesizing information. It operates across dozens of sources simultaneously, extracting only what matters.",
      "Whether you are evaluating a new market, preparing a competitive brief, or making a high-stakes product decision, the Research Agent structures chaos into clarity.",
      "It learns your preferences over time, remembering past queries, favored sources, and recurring topics so every new research cycle starts smarter than the last.",
    ],
    stats: [
      { label: "Avg. research time saved", value: "67%" },
      { label: "Sources scanned per run", value: "120+" },
      { label: "Report accuracy rate", value: "98.5%" },
      { label: "Supported languages", value: "40+" },
    ],
    capabilities: [
      {
        title: "Market Research",
        description:
          "Scan industry reports, news feeds, and databases to surface actionable market intelligence in minutes.",
        icon: "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
      },
      {
        title: "Competitor Analysis",
        description:
          "Track competitor moves, pricing changes, feature launches, and positioning shifts across the web.",
        icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
      },
      {
        title: "Source Summarization",
        description:
          "Condense long-form articles, papers, and documents into structured summaries with key takeaways.",
        icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
      },
      {
        title: "Trend Scanning",
        description:
          "Identify emerging patterns and shifts in your industry before they become mainstream knowledge.",
        icon: "M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941",
      },
      {
        title: "Report Generation",
        description:
          "Produce formatted, shareable reports with citations, charts, and executive summaries.",
        icon: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z",
      },
      {
        title: "Decision Briefs",
        description:
          "Turn raw data into structured decision frameworks with pros, cons, and ranked recommendations.",
        icon: "M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18",
      },
    ],
    workflowSteps: [
      { label: "Input", description: "Define query", color: "#f59e0b" },
      { label: "Search", description: "Scan sources", color: "#3b82f6" },
      { label: "Analyze", description: "Extract data", color: "#8b5cf6" },
      { label: "Synthesize", description: "Find patterns", color: "#22d3ee" },
      { label: "Recommend", description: "Rank options", color: "#10b981" },
      { label: "Report", description: "Deliver brief", color: "#ec4899" },
    ],
    integrations: [
      "Google Drive",
      "Notion",
      "Slack",
      "Airtable",
      "Gmail",
      "HubSpot",
      "Linear",
      "REST APIs",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Research Agent",
    ctaDescription:
      "Start turning scattered information into structured decisions today.",
    ctaButton: "Deploy Research Agent",
  },

  design: {
    slug: "design",
    name: "Design Agent",
    tagline: "Creative Intelligence",
    taglineLine2: "That Ships Faster",
    badge: "Design Agent",
    heroDescription:
      "Generates UI concepts, audits design systems, and translates wireframes into polished components aligned with your brand.",
    color: "#8b5cf6",
    accentGlow: "violet-accent",
    overviewHeading: "Design Systems That Scale Without the Chaos",
    overviewParagraphs: [
      "The Design Agent bridges the gap between creative vision and production-ready output. It understands your design system, brand guidelines, and component library to generate consistent, on-brand UI.",
      "From wireframe to polished prototype, it handles the repetitive work -- auditing spacing, checking accessibility, generating responsive variants -- so your designers focus on creative problem-solving.",
      "It maintains a living memory of your design decisions, catching inconsistencies before they ship and suggesting improvements based on your established patterns.",
    ],
    stats: [
      { label: "Design iteration speed", value: "5x" },
      { label: "Components generated", value: "10K+" },
      { label: "Accessibility compliance", value: "99%" },
      { label: "Brand consistency score", value: "96%" },
    ],
    capabilities: [
      {
        title: "UI Generation",
        description:
          "Generate production-ready UI components from natural language descriptions or rough wireframes.",
        icon: "M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42",
      },
      {
        title: "Design System Audit",
        description:
          "Analyze your component library for inconsistencies in spacing, color, typography, and accessibility.",
        icon: "M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75",
      },
      {
        title: "Responsive Variants",
        description:
          "Automatically generate mobile, tablet, and desktop variants of your designs with proper breakpoints.",
        icon: "M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3",
      },
      {
        title: "Prototyping",
        description:
          "Turn static designs into interactive prototypes with transitions, micro-interactions, and user flows.",
        icon: "M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z",
      },
      {
        title: "Brand Compliance",
        description:
          "Check every design against your brand guidelines for color, typography, voice, and visual consistency.",
        icon: "M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z",
      },
      {
        title: "Asset Generation",
        description:
          "Export icons, illustrations, and design tokens in every format your engineering team needs.",
        icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z",
      },
    ],
    workflowSteps: [
      { label: "Brief", description: "Define scope", color: "#8b5cf6" },
      { label: "Research", description: "Gather refs", color: "#3b82f6" },
      { label: "Generate", description: "Create UI", color: "#22d3ee" },
      { label: "Audit", description: "Check quality", color: "#f59e0b" },
      { label: "Iterate", description: "Refine design", color: "#10b981" },
      { label: "Export", description: "Ship assets", color: "#ec4899" },
    ],
    integrations: [
      "Figma",
      "Notion",
      "Slack",
      "GitHub",
      "Storybook",
      "Linear",
      "Framer",
      "Vercel",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Design Agent",
    ctaDescription:
      "Start shipping consistent, on-brand designs at unprecedented speed.",
    ctaButton: "Deploy Design Agent",
  },

  sales: {
    slug: "sales",
    name: "Sales Agent",
    tagline: "Revenue Intelligence",
    taglineLine2: "That Closes Deals",
    badge: "Sales Agent",
    heroDescription:
      "Qualifies leads, drafts outreach sequences, and keeps your pipeline moving while you focus on closing deals.",
    color: "#22d3ee",
    accentGlow: "cyan",
    overviewHeading: "Your Pipeline Never Sleeps",
    overviewParagraphs: [
      "The Sales Agent researches accounts, personalizes outreach at scale, and surfaces the signals that matter most -- so your reps spend time on calls, not copy-pasting templates.",
      "It scores every lead based on fit, intent, and engagement, then drafts multi-touch sequences tailored to each prospect's industry, role, and pain points.",
      "Connected to your CRM, it updates records in real time, flags stalled deals before they slip, and prepares meeting briefs with full context on every stakeholder.",
    ],
    stats: [
      { label: "Lead qualification speed", value: "12x" },
      { label: "Outreach response rate", value: "+34%" },
      { label: "Pipeline visibility", value: "100%" },
      { label: "Avg. deal cycle reduction", value: "23%" },
    ],
    capabilities: [
      {
        title: "Lead Scoring",
        description:
          "Score and rank every inbound lead based on firmographic fit, behavioral signals, and intent data.",
        icon: "M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z",
      },
      {
        title: "Email Sequences",
        description:
          "Draft personalized multi-touch email sequences tailored to each prospect's role, industry, and pain points.",
        icon: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
      },
      {
        title: "CRM Sync",
        description:
          "Keep your CRM updated in real time with activity logs, deal stages, contact notes, and engagement metrics.",
        icon: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3",
      },
      {
        title: "Pipeline Insights",
        description:
          "Surface stalled deals, at-risk opportunities, and next-best actions for every stage of your pipeline.",
        icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
      },
      {
        title: "Meeting Prep",
        description:
          "Generate pre-call briefs with prospect history, stakeholder maps, and talking points tailored to each deal.",
        icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
      },
      {
        title: "Follow-up Automation",
        description:
          "Never miss a follow-up again. Automated reminders and drafted responses based on conversation context.",
        icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
      },
    ],
    workflowSteps: [
      { label: "Enrich", description: "Research lead", color: "#22d3ee" },
      { label: "Score", description: "Rank fit", color: "#3b82f6" },
      { label: "Personalize", description: "Draft copy", color: "#8b5cf6" },
      { label: "Sequence", description: "Multi-touch", color: "#f59e0b" },
      { label: "Track", description: "Monitor signals", color: "#10b981" },
      { label: "Close", description: "Seal the deal", color: "#ec4899" },
    ],
    integrations: [
      "Salesforce",
      "HubSpot",
      "Gmail",
      "LinkedIn",
      "Slack",
      "Outreach",
      "Gong",
      "Calendly",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Sales Agent",
    ctaDescription:
      "Start accelerating your pipeline and closing deals faster today.",
    ctaButton: "Deploy Sales Agent",
  },

  support: {
    slug: "support",
    name: "Support Agent",
    tagline: "Intelligent Support",
    taglineLine2: "That Scales With You",
    badge: "Support Agent",
    heroDescription:
      "Handles tier-1 tickets, resolves known issues, and escalates edge cases to humans with full context attached.",
    color: "#10b981",
    accentGlow: "electric",
    overviewHeading: "Customer Support Without the Bottleneck",
    overviewParagraphs: [
      "The Support Agent handles the repetitive tickets that consume your team's time -- password resets, billing questions, how-to guides -- while routing complex issues to the right human with full context.",
      "It draws from your knowledge base, past resolutions, and product documentation to provide accurate, consistent answers that match your brand voice.",
      "Every interaction improves the system. Unresolved tickets become training data, escalation patterns surface knowledge gaps, and resolution times shrink week over week.",
    ],
    stats: [
      { label: "Tickets auto-resolved", value: "73%" },
      { label: "Avg. first response time", value: "<30s" },
      { label: "Customer satisfaction", value: "94%" },
      { label: "Escalation accuracy", value: "99%" },
    ],
    capabilities: [
      {
        title: "Ticket Triage",
        description:
          "Automatically categorize, prioritize, and route incoming tickets based on content, urgency, and customer tier.",
        icon: "M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z",
      },
      {
        title: "Auto-Resolution",
        description:
          "Resolve common issues instantly by matching patterns against your knowledge base and past successful resolutions.",
        icon: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
      },
      {
        title: "Smart Escalation",
        description:
          "Route complex issues to the right team member with full conversation context, customer history, and suggested solutions.",
        icon: "M3 4.5h14.25M3 9h9.75M3 13.5h9.75m4.5-4.5v12m0 0l-3.75-3.75M17.25 21l3.75-3.75",
      },
      {
        title: "Knowledge Base",
        description:
          "Continuously learn from resolved tickets to expand your knowledge base and improve future resolution rates.",
        icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
      },
      {
        title: "Sentiment Analysis",
        description:
          "Detect frustration, urgency, and churn risk in real time so human agents can step in before situations escalate.",
        icon: "M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm-.375 0h.008v.015h-.008V9.75zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zm-.375 0h.008v.015h-.008V9.75z",
      },
      {
        title: "SLA Management",
        description:
          "Track and enforce service level agreements with automated alerts, priority queuing, and resolution timers.",
        icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
      },
    ],
    workflowSteps: [
      { label: "Receive", description: "Intake ticket", color: "#10b981" },
      { label: "Classify", description: "Categorize", color: "#3b82f6" },
      { label: "Search", description: "Find solution", color: "#8b5cf6" },
      { label: "Respond", description: "Draft reply", color: "#22d3ee" },
      { label: "Resolve", description: "Close ticket", color: "#f59e0b" },
      { label: "Learn", description: "Update KB", color: "#ec4899" },
    ],
    integrations: [
      "Zendesk",
      "Intercom",
      "Slack",
      "Notion",
      "Gmail",
      "Jira",
      "Linear",
      "Discord",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Support Agent",
    ctaDescription:
      "Start resolving tickets instantly and scaling support without headcount.",
    ctaButton: "Deploy Support Agent",
  },

  data: {
    slug: "data",
    name: "Data Agent",
    tagline: "Data Intelligence",
    taglineLine2: "Your Team Understands",
    badge: "Data Agent",
    heroDescription:
      "Connects to your warehouse, writes queries, and delivers dashboards and reports your team can actually understand.",
    color: "#f59e0b",
    accentGlow: "electric",
    overviewHeading: "From Raw Data to Clear Decisions",
    overviewParagraphs: [
      "The Data Agent eliminates the bottleneck between questions and answers. It writes SQL, builds visualizations, and surfaces anomalies -- no data team queue required.",
      "Ask questions in plain English and get back structured answers with charts, tables, and context. It understands your schema, knows your metrics, and remembers your preferences.",
      "Scheduled reports run automatically. Anomaly detection catches problems early. And every query is logged and version-controlled for full auditability.",
    ],
    stats: [
      { label: "Query generation accuracy", value: "97%" },
      { label: "Reports automated weekly", value: "150+" },
      { label: "Anomalies caught early", value: "89%" },
      { label: "Data sources connected", value: "50+" },
    ],
    capabilities: [
      {
        title: "SQL Generation",
        description:
          "Write complex SQL queries from natural language questions across your entire data warehouse.",
        icon: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5",
      },
      {
        title: "Dashboard Creation",
        description:
          "Build interactive dashboards with charts, filters, and real-time data from your connected sources.",
        icon: "M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z",
      },
      {
        title: "Anomaly Detection",
        description:
          "Automatically flag unusual patterns, spikes, and drops in your metrics before they become problems.",
        icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
      },
      {
        title: "Automated Reporting",
        description:
          "Schedule recurring reports with custom metrics, time ranges, and distribution lists.",
        icon: "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5",
      },
      {
        title: "Metric Tracking",
        description:
          "Define and monitor KPIs with automated alerts when metrics cross thresholds or deviate from trends.",
        icon: "M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941",
      },
      {
        title: "Data Cleaning",
        description:
          "Identify duplicates, missing values, and format inconsistencies across your data sources.",
        icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
      },
    ],
    workflowSteps: [
      { label: "Connect", description: "Link sources", color: "#f59e0b" },
      { label: "Query", description: "Write SQL", color: "#3b82f6" },
      { label: "Process", description: "Clean data", color: "#8b5cf6" },
      { label: "Visualize", description: "Build charts", color: "#22d3ee" },
      { label: "Alert", description: "Flag anomalies", color: "#ef4444" },
      { label: "Report", description: "Distribute", color: "#10b981" },
    ],
    integrations: [
      "Snowflake",
      "BigQuery",
      "PostgreSQL",
      "Looker",
      "Slack",
      "Google Sheets",
      "Airtable",
      "REST APIs",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Data Agent",
    ctaDescription:
      "Start turning your data warehouse into decisions your team acts on.",
    ctaButton: "Deploy Data Agent",
  },

  automation: {
    slug: "automation",
    name: "Automation Agent",
    tagline: "Workflow Intelligence",
    taglineLine2: "That Runs Itself",
    badge: "Automation Agent",
    heroDescription:
      "Orchestrates cross-tool workflows, schedules recurring jobs, and eliminates the busywork that slows your team down.",
    color: "#ef4444",
    accentGlow: "electric",
    overviewHeading: "Automate Everything Between Your Tools",
    overviewParagraphs: [
      "The Automation Agent connects your entire stack and executes multi-step workflows that would normally require manual hand-offs between tools and teams.",
      "Define triggers, conditions, and actions in natural language. The agent handles retries, error recovery, rate limits, and parallel execution so your workflows run reliably at any scale.",
      "From onboarding flows to deployment pipelines to invoice processing -- any process that follows rules can be automated, monitored, and continuously optimized.",
    ],
    stats: [
      { label: "Workflows automated", value: "500+" },
      { label: "Manual hours saved monthly", value: "2,400" },
      { label: "Workflow reliability", value: "99.9%" },
      { label: "Connected tools", value: "100+" },
    ],
    capabilities: [
      {
        title: "Workflow Builder",
        description:
          "Create complex multi-step automations from natural language descriptions with branching logic and conditions.",
        icon: "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5",
      },
      {
        title: "Trigger Management",
        description:
          "Set up event-based, time-based, and condition-based triggers that automatically kick off workflows.",
        icon: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z",
      },
      {
        title: "Error Handling",
        description:
          "Automatic retries, fallback paths, and human escalation when workflows encounter unexpected conditions.",
        icon: "M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z",
      },
      {
        title: "Scheduling",
        description:
          "Run workflows on schedules -- hourly, daily, weekly -- with timezone awareness and smart retry logic.",
        icon: "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5",
      },
      {
        title: "Parallel Execution",
        description:
          "Run independent workflow steps simultaneously to reduce total execution time and handle high volumes.",
        icon: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
      },
      {
        title: "Audit Logging",
        description:
          "Every action, decision, and data transformation is logged with timestamps for compliance and debugging.",
        icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
      },
    ],
    workflowSteps: [
      { label: "Trigger", description: "Start event", color: "#ef4444" },
      { label: "Fetch", description: "Pull data", color: "#3b82f6" },
      { label: "Transform", description: "Process", color: "#8b5cf6" },
      { label: "Execute", description: "Run actions", color: "#f59e0b" },
      { label: "Validate", description: "Check result", color: "#22d3ee" },
      { label: "Complete", description: "Log & notify", color: "#10b981" },
    ],
    integrations: [
      "Zapier",
      "GitHub",
      "Slack",
      "AWS Lambda",
      "Google Cloud",
      "Stripe",
      "Jira",
      "Webhooks",
    ],
    ctaHeading: "Deploy the",
    ctaHeadingLine2: "Automation Agent",
    ctaDescription:
      "Start eliminating manual workflows and scaling operations today.",
    ctaButton: "Deploy Automation Agent",
  },
};

/* ------------------------------------------------------------------ */
/*  Sections                                                           */
/* ------------------------------------------------------------------ */

function HeroSection({ agent }: { agent: AgentDetail }) {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[600px] rounded-full blur-[160px]"
          style={{ backgroundColor: `${agent.color}12` }}
        />
      </div>

      <div className="relative z-10 section-padding max-container w-full text-center">
        <SpringScaleIn delay={0.1}>
          <span
            className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium tracking-widest uppercase mb-8"
            style={{
              border: `1px solid ${agent.color}33`,
              backgroundColor: `${agent.color}0a`,
              color: agent.color,
            }}
          >
            <span
              className="block w-1.5 h-1.5 rounded-full animate-glow-pulse"
              style={{ backgroundColor: agent.color }}
            />
            {agent.badge}
          </span>
        </SpringScaleIn>

        <div className="max-w-5xl mx-auto">
          <PerCharacterRise
            text={agent.tagline}
            as="h1"
            className="text-display-xl font-bold text-ink"
            delay={0.15}
          />
          <PerCharacterRise
            text={agent.taglineLine2}
            as="h1"
            className="text-display-xl font-bold gradient-text"
            delay={0.4}
          />
        </div>

        <SoftBlurIn
          delay={0.4}
          as="p"
          className="mt-8 max-w-2xl mx-auto text-lg md:text-xl text-ink/50 leading-relaxed"
        >
          {agent.heroDescription}
        </SoftBlurIn>

        <SoftBlurIn
          delay={0.6}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Link
            href="#overview"
            className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-3.5 text-sm font-semibold text-white transition-all hover:bg-ink/90"
          >
            See How It Works
            <svg
              className="w-4 h-4 transition-transform group-hover:translate-y-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </Link>
          <Link
            href="/agents"
            className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-8 py-3.5 text-sm font-semibold text-ink transition-all hover:bg-surface"
          >
            All Agents
          </Link>
        </SoftBlurIn>
      </div>

      <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-ink/[0.08] to-transparent" />
    </section>
  );
}

function StatsBar({ agent }: { agent: AgentDetail }) {
  return (
    <section className="border-b border-rule-dark">
      <div className="section-padding max-container">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-ink/[0.06]">
          {agent.stats.map((stat, i) => (
            <AnimatedCard
              key={stat.label}
              index={i}
              hover={false}
              className="py-10 md:py-14 px-6 md:px-8 text-center"
            >
              <PerCharacterRise
                text={stat.value}
                as="p"
                className="text-display-md font-bold gradient-text mb-2"
                delay={i * 0.1}
              />
              <SoftBlurIn
                as="p"
                delay={0.2 + i * 0.1}
                className="text-sm text-ink/50"
              >
                {stat.label}
              </SoftBlurIn>
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

function OverviewSection({ agent }: { agent: AgentDetail }) {
  return (
    <section
      id="overview"
      className="py-24 md:py-32 lg:py-40 border-b border-rule-dark"
    >
      <div className="section-padding max-container">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24 items-start">
          <div>
            <SpringScaleIn>
              <p
                className="text-sm font-medium tracking-widest uppercase mb-4"
                style={{ color: agent.color }}
              >
                Overview
              </p>
            </SpringScaleIn>

            <MaskRevealUp
              as="h2"
              className="text-display-sm font-bold text-ink mb-8"
              delay={0.1}
            >
              {agent.overviewHeading}
            </MaskRevealUp>

            <SoftBlurIn
              delay={0.2}
              className="space-y-5 text-ink/50 leading-relaxed text-base md:text-lg"
            >
              {agent.overviewParagraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </SoftBlurIn>
          </div>

          {/* Visual — Agent process diagram */}
          <div className="space-y-6">
            <AnimatedCard
              className="rounded-3xl bg-surface border border-ink/[0.06] p-8 md:p-10"
              delay={0.3}
              hover={false}
            >
              <h3 className="text-lg font-semibold text-ink mb-8">
                Key Performance
              </h3>
              <div className="grid grid-cols-2 gap-8">
                {agent.stats.map((stat, i) => (
                  <div key={stat.label}>
                    <PerCharacterRise
                      text={stat.value}
                      as="p"
                      className="text-display-sm font-bold gradient-text mb-1"
                      delay={0.4 + i * 0.1}
                    />
                    <SoftBlurIn
                      as="p"
                      delay={0.5 + i * 0.1}
                      className="text-sm text-ink/50"
                    >
                      {stat.label}
                    </SoftBlurIn>
                  </div>
                ))}
              </div>
            </AnimatedCard>

            {/* Quick capabilities preview */}
            <AnimatedCard
              className="rounded-3xl bg-white border border-ink/[0.06] p-8"
              delay={0.4}
              hover={false}
            >
              <h3 className="text-sm font-semibold text-ink/40 tracking-widest uppercase mb-5">
                Core Capabilities
              </h3>
              <div className="space-y-3">
                {agent.capabilities.slice(0, 4).map((cap, i) => (
                  <div
                    key={cap.title}
                    className="flex items-center gap-3 text-sm"
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className="text-ink/70 font-medium">{cap.title}</span>
                  </div>
                ))}
              </div>
            </AnimatedCard>
          </div>
        </div>
      </div>
    </section>
  );
}

function CapabilitiesSection({ agent }: { agent: AgentDetail }) {
  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark">
      <div className="section-padding max-container">
        <div className="text-center mb-16 md:mb-20">
          <SpringScaleIn>
            <p
              className="text-sm font-medium tracking-widest uppercase mb-4"
              style={{ color: agent.color }}
            >
              Capabilities
            </p>
          </SpringScaleIn>

          <LineByLineSlide
            text={`What the ${agent.name}\nCan Do`}
            as="h2"
            className="text-display-lg font-bold text-ink mb-6"
          />

          <SoftBlurIn
            as="p"
            delay={0.3}
            className="text-lg md:text-xl text-ink/50 max-w-2xl mx-auto"
          >
            Six core capabilities designed to transform how your team works.
          </SoftBlurIn>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
          {agent.capabilities.map((cap, i) => (
            <AnimatedCard
              key={cap.title}
              index={i}
              className="rounded-3xl bg-white border border-ink/[0.06] overflow-hidden transition-all duration-300 hover:border-ink/[0.12] hover:shadow-lg"
            >
              <div className="p-8 md:p-10">
                {/* Icon */}
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-6"
                  style={{
                    backgroundColor: `${agent.color}0a`,
                    border: `1px solid ${agent.color}20`,
                  }}
                >
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke={agent.color}
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={cap.icon}
                    />
                  </svg>
                </div>

                <MaskRevealUp
                  as="h3"
                  className="text-xl font-bold text-ink mb-3"
                  delay={i * 0.08 + 0.1}
                >
                  {cap.title}
                </MaskRevealUp>
                <SoftBlurIn
                  as="p"
                  delay={i * 0.08 + 0.2}
                  className="text-ink/50 text-sm leading-relaxed"
                >
                  {cap.description}
                </SoftBlurIn>
              </div>
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection({ agent }: { agent: AgentDetail }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <section
      ref={ref}
      className="py-24 md:py-32 lg:py-40 border-b border-rule-dark relative overflow-hidden"
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white via-surface/40 to-white" />

      <div className="relative z-10 section-padding max-container">
        <div className="text-center mb-16 md:mb-20">
          <SpringScaleIn>
            <p
              className="text-sm font-medium tracking-widest uppercase mb-4"
              style={{ color: agent.color }}
            >
              Workflow
            </p>
          </SpringScaleIn>

          <PerCharacterRise
            text="How It Works"
            as="h2"
            className="text-display-lg font-bold text-ink mb-6"
          />

          <SoftBlurIn
            as="p"
            delay={0.3}
            className="text-lg md:text-xl text-ink/50 max-w-2xl mx-auto"
          >
            A six-step pipeline executed autonomously from start to finish.
          </SoftBlurIn>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4 md:gap-0">
          {agent.workflowSteps.map((step, i) => (
            <div key={step.label} className="flex items-center">
              <AnimatedCard
                index={i}
                hover={false}
                className="relative flex flex-col items-center justify-center gap-2 w-[130px] h-[110px] md:w-[155px] md:h-[125px] rounded-3xl bg-white border border-ink/[0.06]"
              >
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: step.color }}
                />
                <span
                  className="text-base font-semibold tracking-wide"
                  style={{ color: step.color }}
                >
                  {step.label}
                </span>
                <span className="text-[10px] text-ink/30">
                  {step.description}
                </span>
                <span className="text-[10px] font-mono text-ink/20 uppercase">
                  Step {String(i + 1).padStart(2, "0")}
                </span>
              </AnimatedCard>

              {i < agent.workflowSteps.length - 1 && (
                <motion.div
                  initial={{ scaleX: 0, opacity: 0 }}
                  animate={
                    inView
                      ? { scaleX: 1, opacity: 1 }
                      : { scaleX: 0, opacity: 0 }
                  }
                  transition={{
                    duration: 0.4,
                    delay: i * 0.15 + 0.3,
                    ease: "easeOut",
                  }}
                  className="hidden md:block w-8 h-[2px] origin-left"
                  style={{
                    background: `linear-gradient(90deg, ${step.color}60, ${agent.workflowSteps[i + 1]?.color ?? step.color}60)`,
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationsSection({ agent }: { agent: AgentDetail }) {
  return (
    <section className="py-24 md:py-32 lg:py-40 border-b border-rule-dark">
      <div className="section-padding max-container text-center">
        <SpringScaleIn>
          <p
            className="text-sm font-medium tracking-widest uppercase mb-4"
            style={{ color: agent.color }}
          >
            Integrations
          </p>
        </SpringScaleIn>

        <MaskRevealUp
          as="h2"
          className="text-display-sm font-bold text-ink mb-6"
          delay={0.1}
        >
          Works With Your Stack
        </MaskRevealUp>

        <SoftBlurIn
          as="p"
          delay={0.2}
          className="text-lg text-ink/50 max-w-xl mx-auto mb-12"
        >
          The {agent.name} connects to your favorite tools to pull data and push
          results where your team already works.
        </SoftBlurIn>

        <StaggerContainer className="flex flex-wrap items-center justify-center gap-3">
          {agent.integrations.map((tool) => (
            <StaggerItem key={tool}>
              <span className="rounded-full px-6 py-3 text-sm font-medium bg-surface border border-ink/[0.06] text-ink/60 hover:text-ink hover:border-ink/[0.15] transition-colors duration-300">
                {tool}
              </span>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}

function OtherAgentsSection({ agent }: { agent: AgentDetail }) {
  const otherAgents = Object.values(agentDetails).filter(
    (a) => a.slug !== agent.slug
  );

  return (
    <section className="py-24 md:py-32 border-b border-rule-dark">
      <div className="section-padding max-container">
        <div className="text-center mb-12 md:mb-16">
          <SpringScaleIn>
            <p className="text-electric text-sm font-medium tracking-widest uppercase mb-4">
              Explore More
            </p>
          </SpringScaleIn>

          <MaskRevealUp
            as="h2"
            className="text-display-sm font-bold text-ink"
            delay={0.1}
          >
            Other Agents
          </MaskRevealUp>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {otherAgents.map((other, i) => (
            <AnimatedCard key={other.slug} index={i}>
              <Link
                href={`/agents/${other.slug}`}
                className="block rounded-3xl bg-white border border-ink/[0.06] p-6 transition-all duration-300 hover:border-ink/[0.12] hover:shadow-md group"
              >
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center mb-4"
                  style={{
                    backgroundColor: `${other.color}0a`,
                    border: `1px solid ${other.color}20`,
                  }}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: other.color }}
                  />
                </div>
                <h3 className="text-sm font-bold text-ink mb-1">
                  {other.name}
                </h3>
                <p className="text-xs text-ink/40 leading-relaxed line-clamp-2">
                  {other.heroDescription}
                </p>
                <span
                  className="inline-flex items-center gap-1 mt-3 text-xs font-medium transition-colors"
                  style={{ color: other.color }}
                >
                  View
                  <svg
                    className="w-3 h-3 transition-transform group-hover:translate-x-0.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17 8l4 4m0 0l-4 4m4-4H3"
                    />
                  </svg>
                </span>
              </Link>
            </AnimatedCard>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection({ agent }: { agent: AgentDetail }) {
  return (
    <section className="relative py-32 md:py-40 lg:py-48 overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-electric/[0.08] via-white to-violet-accent/[0.06]" />
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full blur-[180px]"
          style={{ backgroundColor: `${agent.color}0c` }}
        />
      </div>

      <div className="relative z-10 section-padding max-container text-center">
        <LineByLineSlide
          text={`${agent.ctaHeading}\n${agent.ctaHeadingLine2}`}
          as="h2"
          className="text-display-lg font-bold text-ink max-w-3xl mx-auto"
        />

        <SoftBlurIn
          as="p"
          delay={0.3}
          className="mt-6 text-lg md:text-xl text-ink/50 max-w-xl mx-auto"
        >
          {agent.ctaDescription}
        </SoftBlurIn>

        <SoftBlurIn
          delay={0.5}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Link
            href="/contact"
            className="group inline-flex items-center gap-2 rounded-full bg-ink px-8 py-4 text-sm font-semibold text-white transition-all hover:bg-ink/90"
          >
            {agent.ctaButton}
            <svg
              className="w-4 h-4 transition-transform group-hover:translate-x-1"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 8l4 4m0 0l-4 4m4-4H3"
              />
            </svg>
          </Link>
          <Link
            href="/agents"
            className="inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-8 py-4 text-sm font-semibold text-ink transition hover:bg-surface"
          >
            View All Agents
          </Link>
        </SoftBlurIn>
      </div>

      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-ink/[0.08] to-transparent" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function AgentDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const agent = agentDetails[slug];

  if (!agent) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center section-padding">
        <h1 className="text-display-md font-bold text-ink mb-4">
          Agent Not Found
        </h1>
        <p className="text-ink/50 mb-8">
          The agent you are looking for does not exist.
        </p>
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-sm font-semibold text-white transition hover:bg-ink/90"
        >
          View All Agents
        </Link>
      </main>
    );
  }

  return (
    <main>
      <HeroSection agent={agent} />
      <StatsBar agent={agent} />
      <OverviewSection agent={agent} />
      <CapabilitiesSection agent={agent} />
      <WorkflowSection agent={agent} />
      <IntegrationsSection agent={agent} />
      <OtherAgentsSection agent={agent} />
      <CTASection agent={agent} />
    </main>
  );
}
