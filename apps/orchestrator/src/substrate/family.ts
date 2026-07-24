import type { ModelFamily } from "@agent-os/protocol";

/**
 * Map a Pi `provider/model` string to a model family for cross-family
 * invariants (master plan §6.2, [R6] claude-agent-sdk → anthropic).
 */
export function familyFromModel(model: string): ModelFamily {
  const slash = model.indexOf("/");
  const provider = (slash === -1 ? model : model.slice(0, slash)).toLowerCase();
  switch (provider) {
    case "anthropic":
    case "claude-agent-sdk":
      return "anthropic";
    case "openai":
    case "chatgpt":
      return "openai";
    case "xai":
    case "grok":
      return "xai";
    case "google":
    case "google-gemini-cli":
    case "google-vertex":
      return "google";
    case "moonshot":
    case "moonshotai":
    case "kimi-coding":
    case "kimi":
      return "moonshot";
    case "mistral":
      return "mistral";
    case "deepseek":
      return "deepseek";
    case "groq":
      return "groq";
    case "openrouter": {
      // openrouter/<origin>/<model> — peel one more segment when present
      const rest = slash === -1 ? "" : model.slice(slash + 1).toLowerCase();
      if (rest.startsWith("anthropic/") || rest.startsWith("claude")) return "anthropic";
      if (rest.startsWith("openai/") || rest.startsWith("gpt")) return "openai";
      if (rest.startsWith("x-ai/") || rest.startsWith("xai/")) return "xai";
      if (rest.startsWith("google/")) return "google";
      if (rest.startsWith("moonshotai/") || rest.startsWith("moonshot/")) return "moonshot";
      if (rest.startsWith("mistralai/") || rest.startsWith("mistral/")) return "mistral";
      if (rest.startsWith("deepseek/")) return "deepseek";
      return "other";
    }
    case "vercel-ai-gateway": {
      const rest = slash === -1 ? "" : model.slice(slash + 1).toLowerCase();
      if (rest.includes("anthropic") || rest.includes("claude")) return "anthropic";
      if (rest.includes("openai") || rest.includes("gpt")) return "openai";
      return "other";
    }
    default:
      return "other";
  }
}
