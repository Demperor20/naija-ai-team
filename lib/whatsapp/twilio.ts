// lib/whatsapp/twilio.ts — Twilio WhatsApp Sandbox provider: parses the
// "When a message comes in" webhook, validates X-Twilio-Signature, sends
// through the Messages API with a per-phone 3.2 s queue (the Sandbox allows
// 1 message every 3 seconds), and approves proposals by letter (no buttons).

import twilio, { validateRequest } from "twilio";
import { getWhatsappUser, upsertWhatsappUser } from "../db";
import { digitsOnly, splitText } from "./text";
import {
  ProviderHttpError,
  type IncomingMessage,
  type ProposalSummary,
  type WhatsAppProvider,
} from "./types";

const TWILIO_TEXT_LIMIT = 1600;
const SEND_GAP_MS = 3200;

export const PROPOSAL_FOOTER =
  "Reply: yes A to approve · change A + what to change · no A to reject · yes all";

function accountSid(): string {
  const v = process.env.TWILIO_ACCOUNT_SID;
  if (!v) throw new Error("Missing TWILIO_ACCOUNT_SID environment variable");
  return v;
}

function authToken(): string {
  const v = process.env.TWILIO_AUTH_TOKEN;
  if (!v) throw new Error("Missing TWILIO_AUTH_TOKEN environment variable");
  return v;
}

function whatsappFrom(): string {
  const v = (process.env.TWILIO_WHATSAPP_FROM ?? "").trim();
  if (!v) throw new Error("Missing TWILIO_WHATSAPP_FROM environment variable");
  // Twilio requires the whatsapp: prefix; add it when the env value is a
  // bare number so sending still works instead of failing per message.
  if (/^whatsapp:/i.test(v)) return v;
  return `whatsapp:${v}`;
}

let cachedClient: ReturnType<typeof twilio> | null = null;

function client(): ReturnType<typeof twilio> {
  if (!cachedClient) cachedClient = twilio(accountSid(), authToken());
  return cachedClient;
}

function toWhatsApp(digits: string): string {
  return `whatsapp:+${digitsOnly(digits)}`;
}

// ---------------------------------------------------------------------------
// Incoming.
// ---------------------------------------------------------------------------

// The exact public URL Twilio called, for signature validation. An explicit
// override wins (some proxies hide the real host); otherwise reconstruct
// from forwarding headers, falling back to the request URL (local dev).
export function twilioWebhookUrl(request: Request): string {
  const override = process.env.TWILIO_PUBLIC_URL;
  if (override) return override;
  const headers = request.headers;
  const host =
    headers.get("x-forwarded-host") ?? new URL(request.url).host;
  const proto =
    headers.get("x-forwarded-proto") ??
    new URL(request.url).protocol.replace(/:$/, "");
  return `${proto}://${host}/api/twilio`;
}

// Twilio signs the URL exactly as pasted in the Console. A trailing slash
// there (…/api/twilio/) would otherwise 403 every delivery, so validate
// against each plausible spelling. Extra candidates are safe: without the
// auth token an attacker can't forge any of them.
function twilioWebhookCandidates(request: Request): string[] {
  const primary = twilioWebhookUrl(request);
  const out = [primary];
  const withSlash = primary.endsWith("/") ? primary.slice(0, -1) : `${primary}/`;
  out.push(withSlash);
  if (request.url !== primary && request.url !== withSlash) {
    out.push(request.url);
  }
  return [...new Set(out)];
}

type TwilioMediaKind = "audio" | "image" | "video";

function mediaKind(mime: string): TwilioMediaKind | null {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

async function fetchTwilioMedia(
  url: string,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const headers: Record<string, string> = {};
  // Twilio hosts real message media on api.twilio.com (HTTP Basic). Any
  // other host is fetched anonymously so credentials never leak to it.
  try {
    if (new URL(url).hostname === "api.twilio.com") {
      headers.Authorization = `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString("base64")}`;
    }
  } catch {
    throw new Error("Twilio media URL is not valid.");
  }
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Twilio media download failed (HTTP ${res.status})`);
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

async function parseIncoming(request: Request): Promise<IncomingMessage[]> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  const signature = request.headers.get("x-twilio-signature") ?? "";
  const token = authToken();
  const valid = twilioWebhookCandidates(request).some((url) =>
    validateRequest(token, signature, url, params),
  );
  if (!valid) {
    throw new ProviderHttpError(403, "forbidden");
  }
  const from = digitsOnly(params.From ?? "");
  const sid = params.MessageSid ?? "";
  const body = params.Body ?? "";
  if (!from || !sid) return [];
  const numMedia = Number.parseInt(params.NumMedia ?? "0", 10) || 0;
  if (numMedia <= 0) {
    return [{ from, messageId: sid, type: "text", text: body }];
  }
  const out: IncomingMessage[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`] ?? "";
    const mime = params[`MediaContentType${i}`] ?? "application/octet-stream";
    if (!url) continue;
    const kind = mediaKind(mime);
    if (!kind) continue;
    out.push({
      from,
      messageId: numMedia === 1 ? sid : `${sid}-${i}`,
      type: kind,
      text: "",
      caption: body || undefined,
      media: { fetch: () => fetchTwilioMedia(url, mime) },
    });
  }
  // Media of an unknown kind (or none usable): fall back to the text body,
  // or the empty-text "I can use..." reply when there is no body either.
  if (out.length === 0) {
    return [{ from, messageId: sid, type: "text", text: body }];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending (queued: at least 3.2 s between messages to one phone).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chains = new Map<string, Promise<void>>();
const lastSentAt = new Map<string, number>();

async function enqueueSend(phone: string, fn: () => Promise<void>): Promise<void> {
  const previous = chains.get(phone) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const wait = SEND_GAP_MS - (Date.now() - (lastSentAt.get(phone) ?? 0));
    if (wait > 0) await sleep(wait);
    await fn();
    lastSentAt.set(phone, Date.now());
  });
  chains.set(phone, next);
  if (chains.size > 10_000) {
    for (const key of [...chains.keys()].slice(0, 1000)) {
      if (key !== phone) chains.delete(key);
      if (key !== phone) lastSentAt.delete(key);
    }
  }
  await next;
}

// One retry inside the queue slot: sandbox sends occasionally 429/5xx on
// the first attempt, and the retry still respects the 3.2 s spacing
// because it runs within this phone's serialized chain.
async function sendWithOneRetry(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (first) {
    console.warn(
      `[twilio] send failed, retrying once: ${first instanceof Error ? first.message : String(first)}`,
    );
    await sleep(SEND_GAP_MS);
    await fn();
  }
}

async function sendText(to: string, text: string): Promise<void> {
  for (const chunk of splitText(text, TWILIO_TEXT_LIMIT)) {
    await enqueueSend(digitsOnly(to), () =>
      sendWithOneRetry(() =>
        client().messages.create({
          from: whatsappFrom(),
          to: toWhatsApp(to),
          body: chunk,
        }).then(() => {}),
      ),
    );
  }
}

async function sendMedia(
  to: string,
  publicUrl: string,
  caption?: string,
): Promise<void> {
  await enqueueSend(digitsOnly(to), () =>
    sendWithOneRetry(() =>
      client()
        .messages.create({
          from: whatsappFrom(),
          to: toWhatsApp(to),
          ...(caption ? { body: caption } : {}),
          mediaUrl: [publicUrl],
        })
        .then(() => {}),
    ),
  );
}

// ---------------------------------------------------------------------------
// Letter approvals (Twilio has no buttons).
// ---------------------------------------------------------------------------

export function letterFor(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// The letter map lives on the phone's whatsapp_users row so it survives
// restarts and works across instances. Namespaced to never collide with
// onboarding data (letters only exist after onboarding anyway).
const LETTERS_KEY = "__proposal_letters";

export async function storeLetters(
  phone: string,
  map: Record<string, string>,
): Promise<void> {
  const user = await getWhatsappUser(phone);
  const data =
    user && typeof user.onboarding_data === "object" && user.onboarding_data !== null
      ? (user.onboarding_data as Record<string, unknown>)
      : {};
  await upsertWhatsappUser({
    phone,
    onboardingData: { ...data, [LETTERS_KEY]: map },
  });
}

export async function readLetters(phone: string): Promise<Record<string, string>> {
  const user = await getWhatsappUser(phone);
  const data =
    user && typeof user.onboarding_data === "object" && user.onboarding_data !== null
      ? (user.onboarding_data as Record<string, unknown>)
      : {};
  const raw = data[LETTERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [letter, id] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id === "string" && id) out[letter.toUpperCase()] = id;
  }
  return out;
}

export function buildProposalList(decisions: ProposalSummary[]): {
  text: string;
  map: Record<string, string>;
} {
  const lines = decisions.map((d, i) => {
    const letter = letterFor(i);
    const desc = d.description ? ` — ${d.description}` : "";
    return `${letter}. ${d.title}${desc}`;
  });
  const map: Record<string, string> = {};
  decisions.forEach((d, i) => {
    map[letterFor(i)] = d.decision_id;
  });
  return {
    text: `Proposals:\n${lines.join("\n")}\n\n${PROPOSAL_FOOTER}`,
    map,
  };
}

async function sendProposals(
  to: string,
  decisions: ProposalSummary[],
): Promise<void> {
  if (decisions.length === 0) return;
  const built = buildProposalList(decisions);
  await storeLetters(digitsOnly(to), built.map);
  await sendText(to, built.text);
}

export type LetterAction =
  | { action: "approve"; decisionId: string }
  | { action: "approveAll" }
  | { action: "reject"; decisionId: string }
  | { action: "change"; decisionId: string; note: string | null };

// Parses "yes A", "ok A", "approve A", "no A", "no be am A", "change A ...",
// "yes all", and bare "yes"/"no"/"change ..." when exactly one proposal is
// pending. Returns null for anything else (handled as a normal message).
// pendingIds: all currently-pending decision ids, oldest first.
export function parseLetterCommand(
  text: string,
  letters: Record<string, string>,
  pendingIds: string[],
): LetterAction | null {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const only = pendingIds.length === 1 ? pendingIds[0] : null;

  const yesAll = /^yes all\.?$/i;
  if (yesAll.test(clean)) {
    return pendingIds.length > 0 ? { action: "approveAll" } : null;
  }

  const approveWord = /^(yes|ok|okay|approve|approved)\b/i;
  // "no be am" (Pidgin: "it's not it") must come before bare "no".
  const rejectWord = /^(no be am|no|reject|rejected)\b/i;
  const changeWord = /^change\b/i;

  const letterOf = (rest: string): string | null => {
    const m = rest.match(/^([A-Z]{1,2})\b/i);
    if (!m) return null;
    const letter = m[1].toUpperCase();
    return letters[letter] ?? null;
  };

  if (approveWord.test(clean)) {
    const rest = clean.replace(approveWord, "").trim();
    if (!rest.replace(/\.+$/, "")) {
      return only ? { action: "approve", decisionId: only } : null;
    }
    const id = letterOf(rest);
    return id ? { action: "approve", decisionId: id } : null;
  }
  if (rejectWord.test(clean)) {
    const rest = clean.replace(rejectWord, "").trim();
    if (!rest.replace(/\.+$/, "")) {
      return only ? { action: "reject", decisionId: only } : null;
    }
    const id = letterOf(rest);
    return id ? { action: "reject", decisionId: id } : null;
  }
  if (changeWord.test(clean)) {
    const rest = clean.replace(changeWord, "").trim();
    if (!rest) return null;
    const id = letterOf(rest);
    if (id) {
      const note = rest
        .replace(/^[A-Z]{1,2}\b[:\s]*/i, "")
        .trim()
        .replace(/\.+$/, "");
      return { action: "change", decisionId: id, note: note || null };
    }
    if (only) {
      const note = rest.replace(/\.+$/, "").trim();
      return { action: "change", decisionId: only, note: note || null };
    }
    return null;
  }
  return null;
}

export const twilioProvider: WhatsAppProvider = {
  id: "twilio",
  parseIncoming,
  sendText,
  sendMedia,
  sendProposals,
};
