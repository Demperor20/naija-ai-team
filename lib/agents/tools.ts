// lib/agents/tools.ts — tool definitions for the model plus the web_search
// handler. delegate_* calls are executed by lib/agents/run.ts, which runs
// the specialist's own loop (this file must not import run.ts).

import type { MetaTool } from "../meta";
import { getLedgerDaily, getWhoOwesMe } from "../db";
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
  books:
    "Ask Books: read sales notebooks, receipts, POS slips and spoken sales; keep the books; who owes the owner; weekly results.",
  product:
    "Ask Plans: what to offer or build first and how to test it.",
  marketing:
    "Ask Promotion: posts, captions, promo ideas and short marketing videos from the owner's footage.",
  design:
    "Ask Flyers & Catalogue: flyers, Status images, product cutouts and the catalogue.",
  engineering:
    "Ask Tools & Costs: which tools to use and what they cost.",
  sales:
    "Ask Prices & Customers: pricing, offers, customer replies and follow-ups.",
  compliance:
    "Ask Paperwork: business registration, tax ID, data protection and startup rules, with official sources.",
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

export const BOOKS_SUMMARY_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "books_summary",
    description:
      "Read recorded sales from the books (confirmed entries only). Use when the owner asks how sales are doing. Period is one of: today, yesterday, week, month.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "yesterday", "week", "month"],
          description: "Which period to summarise.",
        },
      },
      required: ["period"],
    },
  },
};

export const WHO_OWES_ME_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "who_owes_me",
    description:
      "List customers who still owe the owner money, biggest debt first. Use when the owner asks who owes them.",
    parameters: { type: "object", properties: {} },
  },
};

export function getToolsFor(agentKey: string): MetaTool[] {
  if (agentKey === "ceo") {
    return [WEB_SEARCH_TOOL, ...SPECIALIST_KEYS.map(delegateToolFor)];
  }
  if (agentKey === "books") {
    return [WEB_SEARCH_TOOL, BOOKS_SUMMARY_TOOL, WHO_OWES_ME_TOOL];
  }
  return [WEB_SEARCH_TOOL];
}

export interface BooksSummary {
  period: string;
  start: string;
  end: string;
  days: Array<{ day: string; sales: number; expenses: number; profit: number }>;
  totalSales: number;
  totalExpenses: number;
  totalProfit: number;
}

export interface WhoOwesResult {
  customer: string;
  owed: number;
}

function lagosDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function handleBooksSummary(
  companyId: string,
  args: { period?: unknown },
): Promise<BooksSummary | { error: string }> {
  const period =
    args.period === "today" ||
    args.period === "yesterday" ||
    args.period === "week" ||
    args.period === "month"
      ? args.period
      : "week";
  const start =
    period === "today"
      ? lagosDay(0)
      : period === "yesterday"
        ? lagosDay(-1)
        : period === "week"
          ? lagosDay(-6)
          : lagosDay(-29);
  const end = period === "yesterday" ? lagosDay(-1) : lagosDay(0);
  const rows = await getLedgerDaily(companyId, start, end);
  const days = rows.map((r) => ({
    day: r.entry_date,
    sales: Number(r.sales) || 0,
    expenses: Number(r.expenses) || 0,
    profit: Number(r.profit) || 0,
  }));
  return {
    period,
    start,
    end,
    days,
    totalSales: days.reduce((acc, d) => acc + d.sales, 0),
    totalExpenses: days.reduce((acc, d) => acc + d.expenses, 0),
    totalProfit: days.reduce((acc, d) => acc + d.profit, 0),
  };
}

export async function handleWhoOwesMe(
  companyId: string,
): Promise<WhoOwesResult[] | { error: string }> {
  const rows = await getWhoOwesMe(companyId, 10);
  return rows
    .map((r) => ({
      customer: r.counterparty,
      owed: Number(r.balance) || 0,
    }))
    .filter((r) => r.owed > 0);
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
