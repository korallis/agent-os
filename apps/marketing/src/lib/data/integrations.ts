export interface Integration {
  name: string;
  category: string;
  icon: string;
}

export const integrations: Integration[] = [
  { name: "Slack", category: "Communication", icon: "💬" },
  { name: "Notion", category: "Productivity", icon: "📝" },
  { name: "Gmail", category: "Communication", icon: "📧" },
  { name: "Google Calendar", category: "Productivity", icon: "📅" },
  { name: "Linear", category: "Engineering", icon: "🔲" },
  { name: "Jira", category: "Engineering", icon: "📋" },
  { name: "GitHub", category: "Engineering", icon: "🐙" },
  { name: "Figma", category: "Design", icon: "🎨" },
  { name: "HubSpot", category: "Sales", icon: "🧲" },
  { name: "Salesforce", category: "Sales", icon: "☁️" },
  { name: "Zapier", category: "Automation", icon: "⚡" },
  { name: "Airtable", category: "Data", icon: "📊" },
  { name: "Google Drive", category: "Productivity", icon: "📁" },
  { name: "Intercom", category: "Communication", icon: "💁" },
  { name: "Stripe", category: "Data", icon: "💳" },
  { name: "REST APIs", category: "Automation", icon: "🔌" },
];

export const integrationCategories = [
  "Communication",
  "Productivity",
  "Design",
  "Engineering",
  "Sales",
  "Data",
  "Automation",
];
