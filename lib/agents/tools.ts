// lib/agents/tools.ts — tool definitions for the model plus the web_search
// handler. delegate_* calls are executed by lib/agents/run.ts, which runs
// the specialist's own loop (this file must not import run.ts).

import type { MetaTool } from "../meta";
import { SPECIALIST_KEYS } from "./team";

export const WEB_SEARCH_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current facts: competitors, prices, rules, trends. Returns up to 5 results with title, url and a short snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
};

const DELEGATE_DESCRIPTIONS: Record<string, string> = {
  product:
    "Ask the Product Manager: offer or product scope, validation, priorities, MVP.",
  marketing:
    "Ask the Marketing Lead: positioning, messages, posts, promos, launch plans.",
  design:
    "Ask the Designer / Brand: names, brand, visuals, flyers, layouts.",
  engineering:
    "Ask the Engineering / Tech Lead: tools, build plans, costs, feasibility.",
  sales:
    "Ask the Sales & Growth lead: customers, pricing, offers, outreach, follow-ups.",
  compliance:
    "Ask the Operations & Compliance lead: CAC registration, tax ID, data protection, startup rules, operations.",
};

export function delegateToolFor(specialistKey: string): MetaTool {
  return {
    type: "function",
    function: {
      name: `delegate_${specialistKey}`,
      description: `${DELEGATE_DESCRIPTIONS[specialistKey] ?? `Ask the ${specialistKey} specialist.`} Include the business profile, the relevant approved decisions and a clear task in the brief.`,
      parameters: {
        type: "object",
        properties: {
          brief: {
            type: "string",
            description: "Task brief for the specialist.",
          },
        },
        required: ["brief"],
      },
    },
  };
}

export function getToolsFor(agentKey: string): MetaTool[] {
  if (agentKey === "ceo") {
    return [WEB_SEARCH_TOOL, ...SPECIALIST_KEYS.map(delegateToolFor)];
  }
  return [WEB_SEARCH_TOOL];
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function handleWebSearch(args: {
  query?: unknown;
}): Promise<WebSearchResult[] | { error: string }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "web_search needs a query string." };
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    return { error: "web_search is not configured (missing FIRECRAWL_API_KEY)." };
  }
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, limit: 5 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { error: `web_search failed (HTTP ${res.status}).` };
  const json = (await res.json()) as {
    data?: Array<{ title?: string; url?: string; description?: string }>;
  };
  const data = Array.isArray(json.data) ? json.data : [];
  return data.slice(0, 5).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    snippet: (r.description ?? "").slice(0, 300),
  }));
}
