// lib/agents/team.ts — the 8 agents: key, display name, channel, colour, initials.
// Display names are the plain names owners see (AGENTS.md section 6);
// never show job titles like CEO or Co-Founder.

import type { ModelProvider } from "../meta";

export interface AgentDef {
  key: string;
  displayName: string;
  channel: string;
  colour: string;
  initials: string;
  // Which API serves this agent's chat calls: Meta's Model API, or the
  // Meta open-weight model Muse Spark Open served by Baseten.
  provider: ModelProvider;
}

export const AGENTS: AgentDef[] = [
  {
    key: "ceo",
    displayName: "Your team",
    channel: "general",
    colour: "#14532d",
    initials: "YT",
    provider: "meta",
  },
  {
    key: "books",
    displayName: "Books",
    channel: "books",
    colour: "#78350f",
    initials: "BO",
    provider: "meta",
  },
  {
    key: "product",
    displayName: "Plans",
    channel: "product",
    colour: "#0e7490",
    initials: "PL",
    provider: "baseten",
  },
  {
    key: "marketing",
    displayName: "Promotion",
    channel: "marketing",
    colour: "#b45309",
    initials: "PR",
    provider: "meta",
  },
  {
    key: "design",
    displayName: "Flyers & Catalogue",
    channel: "design",
    colour: "#be123c",
    initials: "FC",
    provider: "meta",
  },
  {
    key: "engineering",
    displayName: "Tools & Costs",
    channel: "engineering",
    colour: "#1d4ed8",
    initials: "TC",
    provider: "meta",
  },
  {
    key: "sales",
    displayName: "Prices & Customers",
    channel: "sales",
    colour: "#15803d",
    initials: "PC",
    provider: "baseten",
  },
  {
    key: "compliance",
    displayName: "Paperwork",
    channel: "compliance",
    colour: "#57534e",
    initials: "PA",
    provider: "meta",
  },
];

export const CEO_KEY = "ceo";

export const SPECIALIST_KEYS: string[] = AGENTS.filter((a) => a.key !== CEO_KEY).map(
  (a) => a.key,
);

export function getAgent(key: string): AgentDef {
  return AGENTS.find((a) => a.key === key) ?? AGENTS[0];
}

export function isAgentKey(key: string): boolean {
  return AGENTS.some((a) => a.key === key);
}

// CEO handles `general`, `whatsapp` and kickoffs; otherwise the channel's agent.
export function agentForChannel(
  channelId: string,
  isKickoff?: boolean,
): AgentDef {
  if (isKickoff || channelId === "general" || channelId === "whatsapp") {
    return getAgent(CEO_KEY);
  }
  return AGENTS.find((a) => a.channel === channelId) ?? getAgent(CEO_KEY);
}
