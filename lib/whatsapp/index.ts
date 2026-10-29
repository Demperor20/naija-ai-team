// lib/whatsapp/index.ts — provider selection. WHATSAPP_PROVIDER=meta|twilio
// (default meta) picks the provider for sends the app initiates itself
// (video job notices); the /api/whatsapp and /api/twilio routes always use
// their own provider. WHATSAPP_DRY_RUN=1 logs sends instead of calling
// either API. Never set DRY_RUN in Vercel.

import { metaProvider } from "./meta";
import { buildProposalList, storeLetters, twilioProvider } from "./twilio";
import { digitsOnly } from "./text";
import {
  isProviderId,
  type ProviderId,
  type WhatsAppProvider,
} from "./types";

export type { ProviderId };
export type {
  IncomingMedia,
  IncomingMessage,
  IncomingType,
  ProposalSummary,
  WhatsAppProvider,
} from "./types";
export { ProviderHttpError } from "./types";
export { handleIncoming } from "./handle";

export function getProviderId(): ProviderId {
  const raw = (process.env.WHATSAPP_PROVIDER ?? "meta").trim().toLowerCase();
  if (isProviderId(raw)) return raw;
  console.warn(
    `WHATSAPP_PROVIDER=${raw || "(empty)"} is not meta|twilio; using meta`,
  );
  return "meta";
}

function dryRunProvider(inner: WhatsAppProvider): WhatsAppProvider {
  const log = (kind: string, to: string, preview: string): void => {
    console.log(
      `[wa-dry-run:${inner.id}] ${kind} to=${to} ${preview.slice(0, 300)}`,
    );
  };
  return {
    id: inner.id,
    parseIncoming: (request) => inner.parseIncoming(request),
    sendText: async (to, text) => {
      log("text", to, text);
    },
    sendMedia: async (to, publicUrl, caption) => {
      log("media", to, `${publicUrl} ${caption ?? ""}`);
    },
    sendProposals: async (to, decisions) => {
      // Letters are still stored (Twilio needs the map); nothing is sent.
      if (inner.id === "twilio") {
        await storeLetters(digitsOnly(to), buildProposalList(decisions).map);
      }
      log(
        "proposals",
        to,
        decisions.map((d) => d.title).join(" | "),
      );
    },
  };
}

const cache = new Map<string, WhatsAppProvider>();

let dryRunWarned = false;

function warnIfDryRunOnVercel(dryRun: boolean): void {
  // Dry-run on a deployed host means owners get nothing while every log
  // looks healthy — the classic "Twilio is silent" false alarm. Warn once.
  if (dryRun && !dryRunWarned && process.env.VERCEL) {
    dryRunWarned = true;
    console.warn(
      "[whatsapp] WHATSAPP_DRY_RUN=1 is set on Vercel: outbound messages are only logged, nothing reaches the owner. Unset it to go live.",
    );
  }
}

export function getProvider(id?: ProviderId): WhatsAppProvider {
  const key = id ?? getProviderId();
  const dryRun = process.env.WHATSAPP_DRY_RUN === "1";
  warnIfDryRunOnVercel(dryRun);
  const cacheKey = `${key}:${dryRun ? "dry" : "live"}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const inner = key === "twilio" ? twilioProvider : metaProvider;
  const provider = dryRun ? dryRunProvider(inner) : inner;
  cache.set(cacheKey, provider);
  return provider;
}
