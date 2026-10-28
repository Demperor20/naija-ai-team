// lib/rate-limit.ts — basic per-owner rate limiting. Each business (one
// WhatsApp phone or one Try-it session maps to one company) gets 30
// incoming messages per rolling hour. Counts come from the messages table
// so the limit holds across Vercel instances; phones still onboarding
// (no company yet) get a best-effort in-memory bucket instead.

import { countRecentMessages } from "./db";

export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const RATE_LIMIT_MESSAGE =
  "You're sending messages very quickly. Please wait a few minutes and try again — your team isn't going anywhere.";

export async function checkCompanyRateLimit(
  companyId: string,
): Promise<{ allowed: boolean; count: number }> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const count = await countRecentMessages(companyId, since);
  return { allowed: count < RATE_LIMIT_MAX, count };
}

// Best-effort bucket for phones with no company yet. Correct per instance;
// onboarding is 4 short questions, so this only stops floods.
const phoneHits = new Map<string, number[]>();

export function checkPhoneRateLimit(phone: string): {
  allowed: boolean;
  count: number;
} {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (phoneHits.get(phone) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  phoneHits.set(phone, hits);
  if (phoneHits.size > 10_000) {
    const oldest = [...phoneHits.keys()].slice(0, 1000);
    for (const k of oldest) phoneHits.delete(k);
  }
  return { allowed: hits.length <= RATE_LIMIT_MAX, count: hits.length };
}
