// lib/whatsapp/meta.ts — Meta WhatsApp Cloud API (Graph API v26.0):
// send text/buttons/image/video/document, download media, verify signatures,
// plus the WhatsAppProvider adapter (parseIncoming/sendMedia/sendProposals).

import { createHmac, timingSafeEqual } from "node:crypto";
import { splitText as splitShared } from "./text";
import {
  ProviderHttpError,
  type IncomingMessage,
  type ProposalSummary,
  type WhatsAppProvider,
} from "./types";

const GRAPH_VERSION = "v26.0";

function token(): string {
  const t = process.env.WHATSAPP_TOKEN;
  if (!t) throw new Error("Missing WHATSAPP_TOKEN environment variable");
  return t;
}

function phoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) {
    throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID environment variable");
  }
  return id;
}

function api(path: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}${path}`;
}

// Split long text into chunks of at most 4,096 characters, preferring
// paragraph, line and word boundaries.
export function splitText(text: string): string[] {
  return splitShared(text, 4096);
}

async function postMessage(
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(api(`/${phoneNumberId()}/messages`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...payload,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `WhatsApp send failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
    );
  }
}

export async function sendText(to: string, text: string): Promise<void> {
  for (const chunk of splitText(text)) {
    await postMessage({
      to,
      type: "text",
      text: { body: chunk, preview_url: false },
    });
  }
}

export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<void> {
  if (buttons.length !== 3) {
    throw new Error("sendButtons needs exactly 3 buttons");
  }
  await postMessage({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

export async function sendProposalButtons(
  to: string,
  title: string,
  description: string,
  decisionId: string,
): Promise<void> {
  const body = description ? `${title}\n${description}` : title;
  await sendButtons(to, body, [
    { id: `${decisionId}:approved`, title: "Approve" },
    { id: `${decisionId}:changes_requested`, title: "Change" },
    { id: `${decisionId}:rejected`, title: "Reject" },
  ]);
}

async function uploadMedia(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  const res = await fetch(api(`/${phoneNumberId()}/media`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `WhatsApp media upload failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("WhatsApp media upload returned no id");
  return json.id;
}

export async function sendImage(
  to: string,
  image: Buffer,
  mime: string,
  caption?: string,
): Promise<void> {
  const id = await uploadMedia(image, mime, "image");
  await postMessage({
    to,
    type: "image",
    image: { id, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

export async function sendVideo(
  to: string,
  video: Buffer,
  mime: string,
  caption?: string,
): Promise<void> {
  const id = await uploadMedia(video, mime, "video.mp4");
  await postMessage({
    to,
    type: "video",
    video: { id, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

export async function sendDocument(
  to: string,
  doc: Buffer,
  mime: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const id = await uploadMedia(doc, mime, filename);
  await postMessage({
    to,
    type: "document",
    document: {
      id,
      filename,
      ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    },
  });
}

export async function downloadMedia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaRes = await fetch(api(`/${mediaId}`), {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed (HTTP ${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as {
    url?: string;
    mime_type?: string;
  };
  if (!meta.url) throw new Error("WhatsApp media lookup returned no url");
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!fileRes.ok) {
    throw new Error(
      `WhatsApp media download failed (HTTP ${fileRes.status})`,
    );
  }
  return {
    buffer: Buffer.from(await fileRes.arrayBuffer()),
    mimeType: meta.mime_type ?? "application/octet-stream",
  };
}

export function verifySignature(
  rawBody: string,
  header: string | null,
): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header) return false;
  const eq = header.indexOf("=");
  if (eq <= 0) return false;
  const scheme = header.slice(0, eq);
  const hash = header.slice(eq + 1);
  if (scheme !== "sha256" || !hash) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// WhatsAppProvider adapter.
// ---------------------------------------------------------------------------

interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface MetaMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
}

interface MetaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: MetaMessage[] };
    }>;
  }>;
}

function normalizeOne(message: MetaMessage): IncomingMessage | null {
  const id = message.id;
  const from = message.from;
  if (!id || !from) return null;
  if (message.type === "text" && message.text?.body) {
    return { from, messageId: id, type: "text", text: message.text.body };
  }
  if (
    message.type === "interactive" &&
    message.interactive?.type === "button_reply" &&
    message.interactive.button_reply?.id
  ) {
    return {
      from,
      messageId: id,
      type: "reply",
      text: message.interactive.button_reply.title ?? "",
      replyId: message.interactive.button_reply.id,
    };
  }
  const media =
    message.type === "image"
      ? message.image
      : message.type === "audio"
        ? message.audio
        : message.type === "video"
          ? message.video
          : undefined;
  if (media?.id && message.type) {
    const mediaId = media.id;
    return {
      from,
      messageId: id,
      type: message.type as "image" | "audio" | "video",
      text: "",
      caption: media.caption,
      media: {
        fetch: () => downloadMedia(mediaId).then((d) => ({ buffer: d.buffer, mime: d.mimeType })),
      },
    };
  }
  // Recognized envelope, unsupported content (sticker, location, ...).
  // Empty text tells the shared flow to send the "I can use..." reply.
  if (message.type) {
    return { from, messageId: id, type: "text", text: "" };
  }
  return null;
}

async function parseIncoming(request: Request): Promise<IncomingMessage[]> {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    throw new ProviderHttpError(403, "forbidden");
  }
  let payload: MetaPayload = {};
  try {
    payload = JSON.parse(raw) as MetaPayload;
  } catch {
    return [];
  }
  const out: IncomingMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const normalized = normalizeOne(message);
        if (normalized) out.push(normalized);
      }
    }
  }
  return out;
}

async function sendMedia(
  to: string,
  publicUrl: string,
  caption?: string,
): Promise<void> {
  const res = await fetch(publicUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`WhatsApp media fetch failed (HTTP ${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime =
    res.headers.get("content-type")?.split(";")[0].trim() ||
    "application/octet-stream";
  if (mime.startsWith("video/")) {
    await sendVideo(to, bytes, mime, caption);
  } else if (mime.startsWith("image/")) {
    await sendImage(to, bytes, mime, caption);
  } else {
    const filename =
      new URL(publicUrl).pathname.split("/").pop() || "document";
    await sendDocument(to, bytes, mime, filename, caption);
  }
}

async function sendProposals(
  to: string,
  decisions: ProposalSummary[],
): Promise<void> {
  for (const d of decisions) {
    await sendProposalButtons(to, d.title, d.description, d.decision_id);
  }
}

export const metaProvider: WhatsAppProvider = {
  id: "meta",
  parseIncoming,
  sendText,
  sendMedia,
  sendProposals,
};
