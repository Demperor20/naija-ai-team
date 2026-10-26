// lib/agents/team.ts — the 7 agents: key, display name, channel, colour, initials.

export interface AgentDef {
  key: string;
  displayName: string;
  channel: string;
  colour: string;
  initials: string;
}

export const AGENTS: AgentDef[] = [
  {
    key: "ceo",
    displayName: "AI Co-Founder / CEO",
    channel: "general",
    colour: "#14532d",
    initials: "CE",
  },
  {
    key: "product",
    displayName: "Product Manager",
    channel: "product",
    colour: "#0e7490",
    initials: "PM",
  },
  {
    key: "marketing",
    displayName: "Marketing Lead",
    channel: "marketing",
    colour: "#b45309",
    initials: "MK",
  },
  {
    key: "design",
    displayName: "Designer / Brand",
    channel: "design",
    colour: "#be123c",
    initials: "DE",
  },
  {
    key: "engineering",
    displayName: "Engineering / Tech Lead",
    channel: "engineering",
    colour: "#1d4ed8",
    initials: "EN",
  },
  {
    key: "sales",
    displayName: "Sales & Growth",
    channel: "sales",
    colour: "#15803d",
    initials: "SA",
  },
  {
    key: "compliance",
    displayName: "Operations & Compliance",
    channel: "compliance",
    colour: "#57534e",
    initials: "OC",
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
