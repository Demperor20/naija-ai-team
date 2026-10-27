// lib/media.ts — the media pipeline (AGENTS.md section 11). Everything the
// owner sends goes through here before any agent sees it: store the
// original in Supabase Storage, insert a files row, then describe it.

import { randomUUID } from "node:crypto";
import {
  describeImage,
  describeVideo,
  probeDuration,
  transcribe,
  type ImageCategory,
  type VideoHighlight,
  type VideoProduct,
} from "./meta";
import { getClient, getCompany, saveFile } from "./db";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 180;
export const MAX_VIDEO_SECONDS = 60;
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;

// Friendly rejection shown to the owner when a file breaks the limits.
export class MediaError extends Error {
  userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

export type MediaKind = "audio" | "image" | "video";

export interface ProcessedMedia {
  fileId: string;
  path: string;
  url: string;
  kind: MediaKind;
  fileKind: string; // files.kind value: audio | photo | video
  mime: string;
  sizeBytes: number;
  durationSec?: number;
  description: string; // what goes to the agents (and file ids via fileId)
  transcript?: string;
  category?: ImageCategory;
  products?: VideoProduct[];
  highlights?: VideoHighlight[];
  ms: number;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/3gpp": "3gp",
};

// Small generic word list so the transcriber hears business talk correctly.
// The company's own name is added at runtime.
const BASE_KEYWORDS = [
  "naira",
  "jollof",
  "zobo",
  "WhatsApp",
  "delivery",
  "Lagos",
  "customer",
  "price",
  "order",
  "balance",
];

function mediaKind(mime: string): MediaKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function businessKeywords(companyName: string): string[] {
  const words = companyName.split(/[^A-Za-z0-9₦]+/).filter((w) => w.length > 1);
  return [...new Set([...words, ...BASE_KEYWORDS])].slice(0, 50);
}

export async function processMedia(args: {
  companyId: string;
  buffer: Buffer;
  mime: string;
  messageId?: string;
}): Promise<ProcessedMedia> {
  const started = Date.now();
  const { companyId, buffer, mime } = args;
  const kind = mediaKind(mime);
  if (!kind) {
    throw new MediaError(
      "Sorry, I can only use photos, voice notes and short videos for now. Please send one of those.",
    );
  }
  const sizeBytes = buffer.length;
  if (kind === "image" && sizeBytes > MAX_IMAGE_BYTES) {
    throw new MediaError(
      "That photo is too big for me (over 10 MB). Please send a smaller one.",
    );
  }
  if (kind === "video" && sizeBytes > MAX_VIDEO_BYTES) {
    throw new MediaError(
      "That video is too big for me (over 16 MB). Please send one under 60 seconds.",
    );
  }

  let durationSec: number | undefined;
  if (kind === "audio" || kind === "video") {
    const probed = await probeDuration(buffer);
    if (probed !== null) durationSec = Math.round(probed);
    const limit = kind === "audio" ? MAX_AUDIO_SECONDS : MAX_VIDEO_SECONDS;
    if (durationSec !== undefined && durationSec > limit) {
      throw new MediaError(
        kind === "audio"
          ? "That voice note is longer than 3 minutes. Please send a shorter one."
          : "That video is longer than 60 seconds. Please send a shorter clip.",
      );
    }
  }

  const company = await getCompany(companyId);
  if (!company) throw new Error(`processMedia: company not found`);

  const ext = EXT_BY_MIME[mime] ?? "bin";
  const path = `${companyId}/${todayStamp()}/${randomUUID()}.${ext}`;
  const { error: uploadError } = await getClient()
    .storage.from("files")
    .upload(path, buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    throw new Error(`media upload failed: ${uploadError.message}`);
  }
  const url = getClient().storage.from("files").getPublicUrl(path).data.publicUrl;
  const fileKind = kind === "image" ? "photo" : kind;
  const file = await saveFile({
    companyId,
    kind: fileKind,
    url,
    mime,
    madeBy: "owner",
    messageId: args.messageId,
    meta: {
      size: sizeBytes,
      ...(durationSec !== undefined ? { duration: durationSec } : {}),
    },
  });

  if (kind === "audio") {
    const result = await transcribe(buffer, mime, {
      keywords: businessKeywords(company.name),
    });
    const description = `Voice note transcript (${result.via === "websocket" ? "transcribed" : "transcribed (fallback)"}): "${result.text}"`;
    return {
      fileId: file.id,
      path,
      url,
      kind,
      fileKind,
      mime,
      sizeBytes,
      durationSec,
      description,
      transcript: result.text,
      ms: Date.now() - started,
    };
  }

  if (kind === "image") {
    const result = await describeImage(buffer, mime);
    return {
      fileId: file.id,
      path,
      url,
      kind,
      fileKind,
      mime,
      sizeBytes,
      description: `Photo (${result.category}): ${result.description}`,
      category: result.category,
      ms: Date.now() - started,
    };
  }

  const result = await describeVideo(buffer, mime);
  const productLines = result.products.map((p) => `- ${p.name} (best at ${p.seconds}s)`);
  const highlightLines = result.highlights.map(
    (h) => `- ${h.start}s–${h.end}s: ${h.why}`,
  );
  const description = [
    `Shop video: ${result.description}`,
    ...(productLines.length ? ["Products seen:", ...productLines] : []),
    ...(highlightLines.length ? ["Highlights:", ...highlightLines] : []),
  ].join("\n");
  return {
    fileId: file.id,
    path,
    url,
    kind,
    fileKind,
    mime,
    sizeBytes,
    durationSec,
    description,
    products: result.products,
    highlights: result.highlights,
    ms: Date.now() - started,
  };
}
