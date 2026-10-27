// lib/whatsapp.ts — WhatsApp Cloud API (Graph API v26.0) helpers:
// send text/buttons/image/document, download media, verify signatures.

import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = "v26.0";
const MAX_TEXT_LENGTH = 4096;
const CHUNK_TARGET = 4000;

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
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_LENGTH) {
    let cut = CHUNK_TARGET;
    for (const sep of ["\n\n", "\n", " "]) {
      const idx = rest.lastIndexOf(sep, CHUNK_TARGET);
      if (idx > CHUNK_TARGET - 1000 && idx > 0) {
        cut = idx;
        break;
      }
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
    if (chunks.length > 20) break; // safety cap
  }
  if (rest) chunks.push(rest);
  return chunks;
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
