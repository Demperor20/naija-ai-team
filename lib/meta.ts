// lib/meta.ts — the ONLY place in this project that calls the Meta Model API.
// Every AI call (chat, and later image/transcribe/segment) goes through here.
// Model IDs come from environment variables. The API key is never logged.

export interface MetaToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export type MetaContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface MetaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MetaContentPart[];
  // Set on assistant turns that made tool calls (echoed back on the next round).
  toolCalls?: MetaToolCallRequest[];
  // Set on tool turns: the id of the call this result answers.
  toolCallId?: string;
}

export interface MetaTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatResult {
  text: string;
  toolCalls: MetaToolCallRequest[];
  raw: unknown;
  model: string;
  ms: number;
}

export interface ChatArgs {
  messages: MetaMessage[];
  tools?: MetaTool[];
  // JSON Schema for the whole response object; sent as a structured-output
  // json_schema response_format.
  jsonSchema?: Record<string, unknown>;
  // Enforce the schema strictly (no extra keys). Only set true with a
  // strict-compliant schema: every object sets additionalProperties false
  // and lists all its keys in required.
  strictJson?: boolean;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

function endpoint(): string {
  const base = process.env.META_API_BASE;
  if (!base) throw new Error("Missing META_API_BASE environment variable");
  if (base.endsWith("/chat/completions")) return base;
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function toWireMessage(m: MetaMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.role === "tool" && m.toolCallId) {
    out.tool_call_id = m.toolCallId;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) {
    return `Meta API auth failed (HTTP ${status}). Check META_API_KEY.`;
  }
  if (status === 404) {
    return `Meta API endpoint not found (HTTP 404). Check META_API_BASE.`;
  }
  if (status === 429) {
    return `Meta API rate limited (HTTP 429)${snippet ? `: ${snippet}` : ""}`;
  }
  return `Meta API request failed (HTTP ${status})${snippet ? `: ${snippet}` : ""}`;
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) throw new Error("Missing META_API_KEY environment variable");
  const model = args.model ?? process.env.META_TEXT_MODEL;
  if (!model) throw new Error("Missing META_TEXT_MODEL environment variable");
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = endpoint();

  const body: Record<string, unknown> = {
    model,
    messages: args.messages.map(toWireMessage),
  };
  if (args.tools?.length) body.tools = args.tools;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: args.strictJson ?? false,
        schema: args.jsonSchema,
      },
    };
  }

  const started = Date.now();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(errorMessage(res.status, await res.text()));
        continue; // retry
      }
      if (!res.ok) {
        throw new Error(errorMessage(res.status, await res.text()));
      }
      const raw = (await res.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }> | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const message = raw.choices?.[0]?.message ?? {};
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((p) => p?.type === "text" && p.text)
                .map((p) => p.text as string)
                .join("")
            : "";
      const toolCalls: MetaToolCallRequest[] = (
        message.tool_calls ?? []
      ).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "",
      }));
      return {
        text,
        toolCalls,
        raw,
        model:
          typeof raw.model === "string" && raw.model ? raw.model : model,
        ms: Date.now() - started,
      };
    } catch (err) {
      // Retry network errors and timeouts; rethrow API errors immediately.
      if (err instanceof Error && err.message.startsWith("Meta API ")) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Meta API request failed after retries");
}

// ---------------------------------------------------------------------------
// Audio / image / video (AGENTS.md section 11). Still the only place that
// calls Meta; ffmpeg here only converts bytes, never calls any model.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";

function ffmpegBinary(): string {
  if (ffmpegStaticPath) {
    try {
      chmodSync(ffmpegStaticPath, 0o755);
    } catch {
      // Permissions already fine or read-only fs; try running it anyway.
    }
    return ffmpegStaticPath;
  }
  return "ffmpeg"; // system fallback (local dev without the bundled binary)
}

// Input goes through a temp file (not a pipe): some containers (e.g. MOV
// with the index at the end) need a seekable input. Output stays piped.
function runFfmpeg(
  args: string[],
  stdin?: Buffer,
): Promise<{ stdout: Buffer; stderr: string }> {
  let inputPath: string | null = null;
  if (stdin) {
    inputPath = join(tmpdir(), `naija-ffmpeg-${randomUUID()}`);
    writeFileSync(inputPath, stdin);
  }
  const input = inputPath;
  const finalArgs = input
    ? args.map((a) => (a === "pipe:0" ? input : a))
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), finalArgs, {
      stdio: "pipe",
    } as const);
    child.stdin.end();
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      cleanup();
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr: err });
      } else {
        const error = new Error(
          `ffmpeg failed (code ${code}): ${err.slice(-500)}`,
        ) as Error & { stderr: string };
        error.stderr = err;
        reject(error);
      }
    });

    function cleanup(): void {
      if (inputPath) {
        try {
          unlinkSync(inputPath);
        } catch {
          // Already gone; nothing to do.
        }
        inputPath = null;
      }
    }
  });
}

// Raw mono 16-bit PCM at 24 kHz for the real-time transcribe socket.
async function toPcm24kMono(input: Buffer): Promise<Buffer> {
  const { stdout } = await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    input,
  );
  return stdout;
}

// 16 kHz mono WAV for the Wonder transcription fallback.
async function toWav16kMono(input: Buffer): Promise<Buffer> {
  const { stdout } = await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "pipe:1",
    ],
    input,
  );
  return stdout;
}

// Remux to MP4 without re-encoding (fast) so phone videos play everywhere.
// MP4 needs a seekable output, so this goes through a temp file.
async function transmuxToMp4(input: Buffer): Promise<Buffer> {
  const outPath = join(tmpdir(), `naija-ffmpeg-out-${randomUUID()}.mp4`);
  try {
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-movflags",
        "faststart",
        outPath,
      ],
      input,
    );
    return readFileSync(outPath);
  } finally {
    try {
      unlinkSync(outPath);
    } catch {
      // Already gone; nothing to do.
    }
  }
}

// Media duration in seconds (audio/video), or null when unknown.
export async function probeDuration(input: Buffer): Promise<number | null> {
  let stderr = "";
  try {
    const r = await runFfmpeg(["-hide_banner", "-i", "pipe:0", "-f", "null", "-"], input);
    stderr = r.stderr;
  } catch (err) {
    stderr = (err as Error & { stderr?: string }).stderr ?? "";
  }
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!m) return null;
  const seconds =
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) ? seconds : null;
}

function asrWsUrl(): string {
  const base = process.env.META_API_BASE;
  if (!base) throw new Error("Missing META_API_BASE environment variable");
  return `${base.replace(/^http/, "ws").replace(/\/+$/, "")}/asr/realtime`;
}

interface WsClient {
  send(data: string | Buffer | ArrayBuffer): void;
  close(): void;
  onopen: ((this: WsClient) => void) | null;
  onmessage: ((this: WsClient, ev: { data: unknown }) => void) | null;
  onerror: ((this: WsClient) => void) | null;
  onclose:
    | ((this: WsClient, ev: { code: number; reason: string }) => void)
    | null;
}

function wsImpl(): (new (url: string) => WsClient) | null {
  const g = globalThis as unknown as {
    WebSocket?: new (url: string) => WsClient;
  };
  return g.WebSocket ?? null;
}

async function transcribeViaSocket(
  pcm: Buffer,
  opts: { keywords: string[]; timeoutMs: number },
): Promise<string> {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) throw new Error("Missing META_API_KEY environment variable");
  const model = process.env.META_TRANSCRIBE_MODEL;
  if (!model) {
    throw new Error("Missing META_TRANSCRIBE_MODEL environment variable");
  }
  const WS = wsImpl();
  if (!WS) throw new Error("WebSocket is not available in this runtime");

  return new Promise<string>((resolve, reject) => {
    const ws = new WS(asrWsUrl());
    let settled = false;
    let handshaked = false;
    let interim = "";
    const finals: string[] = [];
    const timer = setTimeout(() => {
      finish(() => reject(new Error("transcription timed out")));
    }, opts.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      fn();
    }

    function fail(message: string): void {
      finish(() => reject(new Error(message)));
    }

    ws.onopen = () => {
      // Auth goes in the handshake frame; the Authorization header is ignored.
      // The handshake must be the first JSON text frame.
      const handshake: Record<string, unknown> = {
        mode: "ENDPOINTING",
        authorization: { accessToken: apiKey },
        audioEncoding: "PCM_24KHZ",
        model,
        partialMode: "CUMULATIVE",
        emitAudioProgress: true,
      };
      if (opts.keywords.length > 0) handshake.keywords = opts.keywords;
      ws.send(JSON.stringify(handshake));
    };

    ws.onmessage = (ev) => {
      const rawText =
        typeof ev.data === "string"
          ? ev.data
          : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "error") {
        const detail =
          typeof msg.message === "string"
            ? msg.message
            : rawText.slice(0, 300);
        fail(`transcribe socket error: ${detail}`);
        return;
      }
      if (!handshaked) {
        if (typeof msg.sessionId === "string" && msg.sessionId) {
          handshaked = true;
          void streamAudio();
        } else {
          fail("transcribe handshake failed: no session id");
        }
        return;
      }
      if (msg.type === "transcript" && typeof msg.transcript === "string") {
        interim = msg.transcript;
        return;
      }
      if (
        msg.type === "speechComplete" &&
        typeof msg.transcript === "string" &&
        msg.transcript.trim()
      ) {
        finals.push(msg.transcript.trim());
        return;
      }
    };

    // Stream ~80 ms frames after the handshake ack, then end the stream.
    async function streamAudio(): Promise<void> {
      const CHUNK = 3840;
      try {
        for (let i = 0; i < pcm.length; i += CHUNK) {
          ws.send(pcm.subarray(i, i + CHUNK));
          if (i % (CHUNK * 20) === 0) {
            await new Promise((r) => setImmediate(r));
          }
        }
        ws.send(JSON.stringify({ type: "endStream" }));
      } catch (err) {
        fail(
          err instanceof Error
            ? `transcribe send failed: ${err.message}`
            : "transcribe send failed",
        );
      }
    }

    ws.onerror = () => {
      fail("transcribe socket connection failed");
    };
    ws.onclose = (ev) => {
      const text = finals.length > 0 ? finals.join(" ") : interim;
      finish(() =>
        text.trim()
          ? resolve(text.trim())
          : reject(
              new Error(
                `transcribe socket closed without a transcript (code ${ev.code})`,
              ),
            ),
      );
    };
  });
}

export interface TranscribeResult {
  text: string;
  ms: number;
  via: "websocket" | "wonder";
}

export async function transcribe(
  audioBuffer: Buffer,
  mime: string,
  opts?: { keywords?: string[]; timeoutMs?: number },
): Promise<TranscribeResult> {
  void mime;
  const started = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const keywords = (opts?.keywords ?? []).filter((k) => k.trim()).slice(0, 50);
  const pcm = await toPcm24kMono(audioBuffer);
  try {
    const text = await transcribeViaSocket(pcm, { keywords, timeoutMs });
    if (!text.trim()) throw new Error("empty transcript from socket");
    return { text: text.trim(), ms: Date.now() - started, via: "websocket" };
  } catch (err) {
    console.error(
      "transcribe websocket failed, falling back to Wonder:",
      err instanceof Error ? err.message : err,
    );
  }
  // Fallback: Muse Wonder with the audio file as input.
  const reasoningModel = process.env.META_REASONING_MODEL;
  if (!reasoningModel) {
    throw new Error("Missing META_REASONING_MODEL environment variable");
  }
  const wav = await toWav16kMono(audioBuffer);
  const hint =
    keywords.length > 0
      ? ` Business words you may hear: ${keywords.join(", ")}.`
      : "";
  const result = await chat({
    model: reasoningModel,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Transcribe this audio verbatim. It may contain English, Nigerian Pidgin, or a mix.${hint} Reply with only the transcript, no commentary.`,
          },
          {
            type: "input_audio",
            input_audio: { data: wav.toString("base64"), format: "wav" },
          },
        ],
      },
    ],
    temperature: 0,
    timeoutMs,
  });
  return { text: result.text.trim(), ms: Date.now() - started, via: "wonder" };
}

export type ImageCategory =
  | "sales_record"
  | "product_photo"
  | "price_list"
  | "other";

export interface ImageDescription {
  category: ImageCategory;
  description: string;
  ms: number;
}

const IMAGE_CATEGORIES: ImageCategory[] = [
  "sales_record",
  "product_photo",
  "price_list",
  "other",
];

export async function describeImage(
  imageBuffer: Buffer,
  mime: string,
  opts?: { timeoutMs?: number },
): Promise<ImageDescription> {
  const started = Date.now();
  const result = await chat({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Look at this photo from a Nigerian small business. Classify it as exactly one of: sales_record (notebook page, receipt, POS slip, transfer screenshot), product_photo, price_list, or other. Then write a one-paragraph description of what you see, including any readable items and prices; say clearly if anything is unreadable. Reply with the JSON object only.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mime};base64,${imageBuffer.toString("base64")}`,
            },
          },
        ],
      },
    ],
    jsonSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: IMAGE_CATEGORIES },
        description: { type: "string" },
      },
      required: ["category", "description"],
    },
    temperature: 0,
    timeoutMs: opts?.timeoutMs,
  });
  try {
    const parsed = JSON.parse(result.text) as {
      category?: unknown;
      description?: unknown;
    };
    const category = IMAGE_CATEGORIES.includes(
      parsed.category as ImageCategory,
    )
      ? (parsed.category as ImageCategory)
      : "other";
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description
        : result.text;
    return { category, description, ms: Date.now() - started };
  } catch {
    return {
      category: "other",
      description: result.text,
      ms: Date.now() - started,
    };
  }
}

export interface VideoProduct {
  name: string;
  seconds: number;
}

export interface VideoHighlight {
  start: number;
  end: number;
  why: string;
}

export interface VideoDescription {
  products: VideoProduct[];
  highlights: VideoHighlight[];
  description: string;
  ms: number;
}

export async function describeVideo(
  videoBuffer: Buffer,
  mime: string,
  opts?: { timeoutMs?: number },
): Promise<VideoDescription> {
  const started = Date.now();
  const reasoningModel = process.env.META_REASONING_MODEL;
  if (!reasoningModel) {
    throw new Error("Missing META_REASONING_MODEL environment variable");
  }
  let video = videoBuffer;
  let videoMime = mime;
  if (mime !== "video/mp4") {
    try {
      video = await transmuxToMp4(videoBuffer);
      videoMime = "video/mp4";
    } catch (err) {
      console.error(
        "video transmux failed, sending original:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const result = await chat({
    model: reasoningModel,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Watch this short shop video. List each distinct product you can see with the timestamp in seconds where it looks best, pick 3 to 5 highlight moments (start and end in seconds, plus why each is good for a promo), and write a one-paragraph description of the video. Reply with the JSON object only.",
          },
          {
            type: "video_url",
            video_url: {
              url: `data:${videoMime};base64,${video.toString("base64")}`,
            },
          },
        ],
      },
    ],
    jsonSchema: {
      type: "object",
      properties: {
        products: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              seconds: { type: "number" },
            },
            required: ["name", "seconds"],
          },
        },
        highlights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              why: { type: "string" },
            },
            required: ["start", "end", "why"],
          },
        },
        description: { type: "string" },
      },
      required: ["products", "highlights", "description"],
    },
    temperature: 0,
    timeoutMs: opts?.timeoutMs ?? 180_000,
  });
  const fallback: VideoDescription = {
    products: [],
    highlights: [],
    description: result.text,
    ms: Date.now() - started,
  };
  try {
    const parsed = JSON.parse(result.text) as {
      products?: unknown;
      highlights?: unknown;
      description?: unknown;
    };
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
      products: Array.isArray(parsed.products)
        ? parsed.products
            .filter(
              (p): p is { name: unknown; seconds: unknown } =>
                typeof p === "object" && p !== null,
            )
            .filter((p) => typeof p.name === "string" && p.name.trim())
            .map((p) => ({
              name: (p.name as string).trim(),
              seconds: num(p.seconds),
            }))
        : [],
      highlights: Array.isArray(parsed.highlights)
        ? parsed.highlights
            .filter(
              (h): h is Record<string, unknown> =>
                typeof h === "object" && h !== null,
            )
            .map((h) => ({
              start: num(h.start),
              end: num(h.end),
              why: typeof h.why === "string" ? h.why : "",
            }))
        : [],
      description:
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description
          : result.text,
      ms: Date.now() - started,
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// SAM 3.1 segmentation (AGENTS.md section 14). Responses-only model: photo +
// a text prompt naming the product, masks back as special-token text:
//   <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,payload|>
// Box x2/y2 are inclusive; the mask is exactly (x2+1-x1) x (y2+1-y1) pixels.
// The mask codec below is a TypeScript port of Meta's meta-sam-parser
// (PyPI, MIT-licensed reference logic): base-85 unpack, then a range-coded
// raster (~ = lossless with spatial predictor, thresholded at 129; ! = binary).
// ---------------------------------------------------------------------------

const SAM_TIMEOUT_MS = 120_000;
const SAM_RADIX = 85;
const SAM_PREFIX_LENGTH = 5;
const SAM_ALPHABET = ((): string => {
  const excluded = new Set(['"', "\\", ",", ";", "<", ">", "|"]);
  let s = "";
  for (let code = 0x21; code < 0x7f; code++) {
    const ch = String.fromCharCode(code);
    if (!excluded.has(ch)) s += ch;
  }
  return s;
})();
const SAM_CHAR_VALUES: number[] = ((): number[] => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < SAM_ALPHABET.length; i++) {
    table[SAM_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const SAM_TOP = 1 << 24;
const SAM_BOTTOM = 1 << 16;
const SAM_INCREMENT = 14;
const SAM_U32 = 0xffffffff;
const SAM_COUNT_LIMIT = 4096;
const SAM_CONTEXT_COUNT = 1 << 12;
const SAM_PADDING = 2;
const SAM_SYMBOLS = 256;
const SAM_TOTAL_INDEX = SAM_SYMBOLS;
const SAM_SPATIAL_MODES = 5;
const SAM_ZERO_INCREMENT = 32;
const SAM_ZERO_LIMIT = 16384;
const SAM_ORDER_ONE_INCREMENT = 56;
const SAM_ORDER_ONE_LIMIT = 8192;
const SAM_ORDER_TWO_STEP = 14 * 44;
const SAM_ORDER_TWO_LIMIT = 14 * 3584;
const SAM_ORDER_ZERO_STEP = 2 * 16;
const SAM_ORDER_ZERO_LIMIT = 2 * 2048;
const SAM_ORDER_ZERO_INITIAL = 2;
const SAM_ORDER_ONE_INITIAL = 1;

function samDigit(ch: string): number {
  const code = ch.charCodeAt(0);
  const value =
    code < SAM_CHAR_VALUES.length ? SAM_CHAR_VALUES[code] : -1;
  if (value < 0 || value >= SAM_RADIX) {
    throw new Error("SAM mask payload contains an invalid character.");
  }
  return value;
}

function samPack(input: Uint8Array): string {
  const length = input.length;
  let remaining = length;
  const prefix = new Array<string>(SAM_PREFIX_LENGTH);
  for (let i = SAM_PREFIX_LENGTH - 1; i >= 0; i--) {
    prefix[i] = SAM_ALPHABET[remaining % SAM_RADIX];
    remaining = Math.floor(remaining / SAM_RADIX);
  }
  if (remaining !== 0) throw new Error("SAM mask payload is too large.");
  const out: string[] = [...prefix];
  let offset = 0;
  const full = length - (length % 4);
  while (offset < full) {
    let value =
      (((input[offset] << 24) |
        (input[offset + 1] << 16) |
        (input[offset + 2] << 8) |
        input[offset + 3]) >>>
        0);
    const digits = [0, 0, 0, 0, 0];
    for (let i = 4; i >= 0; i--) {
      digits[i] = value % SAM_RADIX;
      value = Math.floor((value - digits[i]) / SAM_RADIX);
    }
    for (const d of digits) out.push(SAM_ALPHABET[d]);
    offset += 4;
  }
  const remainder = length - offset;
  if (remainder > 0) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      value =
        ((value << 8) | (i < remainder ? input[offset + i] : 0)) >>> 0;
    }
    const digits = [0, 0, 0, 0, 0];
    for (let i = 4; i >= 0; i--) {
      digits[i] = value % SAM_RADIX;
      value = Math.floor((value - digits[i]) / SAM_RADIX);
    }
    for (let i = 0; i < remainder + 1; i++) out.push(SAM_ALPHABET[digits[i]]);
  }
  return out.join("");
}

function samUnpack(payload: string): Uint8Array {
  if (payload.length < SAM_PREFIX_LENGTH) {
    throw new Error("SAM mask payload is missing its length prefix.");
  }
  let length = 0;
  for (let i = 0; i < SAM_PREFIX_LENGTH; i++) {
    length = length * SAM_RADIX + samDigit(payload[i]);
  }
  const remainder = length % 4;
  const expected =
    SAM_PREFIX_LENGTH +
    Math.floor(length / 4) * 5 +
    (remainder === 0 ? 0 : remainder + 1);
  if (payload.length !== expected) {
    throw new Error("SAM mask payload length does not match its prefix.");
  }
  const output = new Uint8Array(length);
  let source = SAM_PREFIX_LENGTH;
  let destination = 0;
  const full = length - remainder;
  while (destination < full) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      value = value * SAM_RADIX + samDigit(payload[source + i]);
    }
    if (value > SAM_U32) {
      throw new Error("SAM mask payload contains an out-of-range group.");
    }
    source += 5;
    output[destination] = (value >>> 24) & 0xff;
    output[destination + 1] = (value >>> 16) & 0xff;
    output[destination + 2] = (value >>> 8) & 0xff;
    output[destination + 3] = value & 0xff;
    destination += 4;
  }
  if (remainder > 0) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      value =
        value * SAM_RADIX +
        (i < remainder + 1
          ? samDigit(payload[source + i])
          : SAM_RADIX - 1);
    }
    if (value > SAM_U32) {
      throw new Error("SAM mask payload contains an out-of-range tail.");
    }
    for (let i = 0; i < remainder; i++) {
      output[destination + i] = (value >>> (24 - i * 8)) & 0xff;
    }
  }
  if (samPack(output) !== payload) {
    throw new Error("SAM mask payload is not in canonical form.");
  }
  return output;
}

class SamRangeDecoder {
  private input: Uint8Array;
  private position = 0;
  private low = 0;
  private range = SAM_U32;
  private code = 0;
  private scaled = 0;

  constructor(input: Uint8Array) {
    if (input.length < 4) {
      throw new Error("SAM mask payload is missing its finalization.");
    }
    this.input = input;
    for (let i = 0; i < 4; i++) {
      this.code = ((this.code << 8) | this.read()) >>> 0;
    }
  }

  frequency(total: number): number {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) {
      throw new Error("SAM mask payload has invalid coding state.");
    }
    const value = Math.floor(
      ((this.code - this.low) >>> 0) / this.scaled,
    );
    return value >= total ? total - 1 : value;
  }

  decode(cumulative: number, frequency: number): void {
    this.low = (this.low + this.scaled * cumulative) >>> 0;
    this.range = this.scaled * frequency;
    for (;;) {
      if (((this.low ^ ((this.low + this.range) >>> 0)) >>> 0) < SAM_TOP) {
        // Top bytes match: shift below.
      } else if (this.range < SAM_BOTTOM) {
        this.range = (-this.low >>> 0) & (SAM_BOTTOM - 1);
      } else {
        break;
      }
      this.code = ((this.code << 8) | this.read()) >>> 0;
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }

  private read(): number {
    if (this.position >= this.input.length) {
      throw new Error("SAM mask payload ended before decoding completed.");
    }
    const value = this.input[this.position];
    this.position += 1;
    return value;
  }
}

class SamRangeEncoder {
  private low = 0;
  private range = SAM_U32;
  private output: number[] = [];

  encode(cumulative: number, frequency: number, total: number): void {
    const scaled = Math.floor(this.range / total);
    this.low = (this.low + scaled * cumulative) >>> 0;
    this.range = scaled * frequency;
    for (;;) {
      if (((this.low ^ ((this.low + this.range) >>> 0)) >>> 0) < SAM_TOP) {
        // Top bytes match: shift below.
      } else if (this.range < SAM_BOTTOM) {
        this.range = (-this.low >>> 0) & (SAM_BOTTOM - 1);
      } else {
        break;
      }
      this.output.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 4; i++) {
      this.output.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
    }
    return Uint8Array.from(this.output);
  }
}

function samI32(value: number): number {
  const u = value >>> 0;
  return u >= 0x80000000 ? u - 0x100000000 : u;
}

function samPaeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function samPredictByte(
  output: Uint8Array,
  offset: number,
  x: number,
  y: number,
  mode: number,
  width: number,
): number {
  if (mode < 0 || mode >= SAM_SPATIAL_MODES) {
    throw new Error("SAM lossless mask payload uses an invalid predictor.");
  }
  const left = x > 0 ? output[offset - 1] : 0;
  const up = y > 0 ? output[offset - width] : 0;
  if (mode === 1) return up;
  if (mode === 2) return left;
  if (mode === 3) return (left + up) >> 1;
  const upperLeft = x > 0 && y > 0 ? output[offset - width - 1] : 0;
  if (mode === 0) return samPaeth(left, up, upperLeft);
  if (upperLeft >= Math.max(left, up)) return Math.min(left, up);
  if (upperLeft <= Math.min(left, up)) return Math.max(left, up);
  return left + up - upperLeft;
}

function samUnzig(value: number, prediction: number): number {
  const delta = value & 1 ? -((value + 1) >> 1) : value >> 1;
  return (prediction + delta) & 0xff;
}

function samZeroContext(
  residuals: Uint8Array,
  offset: number,
  x: number,
  y: number,
  width: number,
): number {
  const left = x > 0 ? (residuals[offset - 1] === 0 ? 1 : 0) : 1;
  const up = y > 0 ? (residuals[offset - width] === 0 ? 1 : 0) : 1;
  const upperLeft =
    x > 0 && y > 0 ? (residuals[offset - width - 1] === 0 ? 1 : 0) : 1;
  const upperRight =
    y > 0 && x < width - 1
      ? (residuals[offset - width + 1] === 0 ? 1 : 0)
      : 1;
  return left | (up << 1) | (upperLeft << 2) | (upperRight << 3);
}

function samDecodeLosslessRaster(
  payload: string,
  width: number,
  height: number,
): Uint8Array {
  if (!payload.startsWith("~")) {
    throw new Error("SAM lossless mask payloads must start with ~.");
  }
  const packed = samUnpack(payload.slice(1));
  if (packed.length < 5) {
    throw new Error("SAM lossless mask payload is truncated.");
  }
  const selector = packed[0];
  const decoder = new SamRangeDecoder(packed.slice(1));
  const length = width * height;
  const output = new Uint8Array(length);
  const residuals = new Uint8Array(length);
  const zeroCounts = new Uint32Array(32).fill(1);
  const orderOne = new Uint16Array(SAM_SYMBOLS * SAM_SYMBOLS).fill(
    SAM_ORDER_ONE_INITIAL,
  );
  const orderOneTotals = new Int32Array(SAM_SYMBOLS).fill(
    SAM_SYMBOLS * SAM_ORDER_ONE_INITIAL,
  );
  const orderZero = new Uint16Array(SAM_SYMBOLS).fill(SAM_ORDER_ZERO_INITIAL);
  let orderZeroTotal = SAM_SYMBOLS * SAM_ORDER_ZERO_INITIAL;
  const orderTwo = new Map<number, Uint16Array>();
  let previous = 0;

  for (let offset = 0; offset < length; offset++) {
    const x = offset % width;
    const y = Math.floor(offset / width);
    const zeroOffset = samZeroContext(residuals, offset, x, y, width) << 1;
    const zero = zeroCounts[zeroOffset];
    const nonzero = zeroCounts[zeroOffset + 1];
    const zeroFrequency = decoder.frequency(zero + nonzero);
    const bit = zeroFrequency < zero ? 0 : 1;
    decoder.decode(bit === 0 ? 0 : zero, bit === 0 ? zero : nonzero);
    zeroCounts[zeroOffset + bit] =
      (zeroCounts[zeroOffset + bit] + SAM_ZERO_INCREMENT) >>> 0;
    if (
      zeroCounts[zeroOffset] + zeroCounts[zeroOffset + 1] >=
      SAM_ZERO_LIMIT
    ) {
      zeroCounts[zeroOffset] = (zeroCounts[zeroOffset] >> 1) || 1;
      zeroCounts[zeroOffset + 1] = (zeroCounts[zeroOffset + 1] >> 1) || 1;
    }

    let symbol = 0;
    if (bit === 1) {
      const above = offset >= width ? residuals[offset - width] : 0;
      const key = (previous << 8) | above;
      let second = orderTwo.get(key);
      if (!second) {
        second = new Uint16Array(SAM_SYMBOLS + 1);
        orderTwo.set(key, second);
      }
      const firstOffset = previous << 8;
      const excludedZero =
        second[0] + orderOne[firstOffset] + orderZero[0];
      const total =
        second[SAM_TOTAL_INDEX] +
        orderOneTotals[previous] +
        orderZeroTotal -
        excludedZero;
      const target = decoder.frequency(total);
      let cumulative = 0;
      symbol = 1;
      let frequency =
        second[1] + orderOne[firstOffset + 1] + orderZero[1];
      while (cumulative + frequency <= target) {
        cumulative += frequency;
        symbol += 1;
        if (symbol >= SAM_SYMBOLS) {
          throw new Error("SAM lossless mask payload is malformed.");
        }
        frequency =
          second[symbol] +
          orderOne[firstOffset + symbol] +
          orderZero[symbol];
      }
      decoder.decode(cumulative, frequency);
      second[symbol] = (second[symbol] + SAM_ORDER_TWO_STEP) & 0xffff;
      second[SAM_TOTAL_INDEX] =
        (second[SAM_TOTAL_INDEX] + SAM_ORDER_TWO_STEP) & 0xffff;
      if (second[SAM_TOTAL_INDEX] >= SAM_ORDER_TWO_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SAM_SYMBOLS; v++) {
          second[v] = second[v] >> 1;
          totalAfterScaling += second[v];
        }
        second[SAM_TOTAL_INDEX] = totalAfterScaling & 0xffff;
      }
      orderOne[firstOffset + symbol] =
        (orderOne[firstOffset + symbol] + SAM_ORDER_ONE_INCREMENT) & 0xffff;
      orderOneTotals[previous] = samI32(
        orderOneTotals[previous] + SAM_ORDER_ONE_INCREMENT,
      );
      if (orderOneTotals[previous] >= SAM_ORDER_ONE_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SAM_SYMBOLS; v++) {
          const scaled = (orderOne[firstOffset + v] >> 1) || 1;
          orderOne[firstOffset + v] = scaled;
          totalAfterScaling += scaled;
        }
        orderOneTotals[previous] = samI32(totalAfterScaling);
      }
      orderZero[symbol] =
        (orderZero[symbol] + SAM_ORDER_ZERO_STEP) & 0xffff;
      orderZeroTotal += SAM_ORDER_ZERO_STEP;
      if (orderZeroTotal >= SAM_ORDER_ZERO_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SAM_SYMBOLS; v++) {
          orderZero[v] = orderZero[v] >> 1;
          totalAfterScaling += orderZero[v];
        }
        orderZeroTotal = totalAfterScaling;
      }
    }
    residuals[offset] = symbol;
    output[offset] = samUnzig(
      symbol,
      samPredictByte(output, offset, x, y, selector, width),
    );
    previous = symbol;
  }
  return output;
}

function samContextAt(
  raster: Uint8Array,
  position: number,
  prior: number,
  earlier: number,
): number {
  return (
    raster[position - 1] |
    (raster[position - 2] << 1) |
    (raster[prior - 2] << 2) |
    (raster[prior - 1] << 3) |
    (raster[prior] << 4) |
    (raster[prior + 1] << 5) |
    (raster[prior + 2] << 6) |
    (raster[earlier - 2] << 7) |
    (raster[earlier - 1] << 8) |
    (raster[earlier] << 9) |
    (raster[earlier + 1] << 10) |
    (raster[earlier + 2] << 11)
  );
}

function samUpdateCounts(
  counts: Uint16Array,
  offset: number,
  bit: number,
): void {
  counts[offset + bit] = (counts[offset + bit] + SAM_INCREMENT) & 0xffff;
  if (counts[offset] + counts[offset + 1] >= SAM_COUNT_LIMIT) {
    counts[offset] = (counts[offset] >> 1) || 1;
    counts[offset + 1] = (counts[offset + 1] >> 1) || 1;
  }
}

function samEncodeRaster(
  input: Uint8Array,
  width: number,
  height: number,
): string {
  const encoder = new SamRangeEncoder();
  const counts = new Uint16Array(SAM_CONTEXT_COUNT * 2).fill(1);
  const paddedWidth = width + 2 * SAM_PADDING;
  const padded = new Uint8Array(paddedWidth * (height + SAM_PADDING));
  for (let y = 0; y < height; y++) {
    const row = (y + SAM_PADDING) * paddedWidth + SAM_PADDING;
    for (let x = 0; x < width; x++) {
      const position = row + x;
      const context = samContextAt(
        padded,
        position,
        position - paddedWidth,
        position - 2 * paddedWidth,
      );
      const offset = context << 1;
      const zero = counts[offset];
      const one = counts[offset + 1];
      const bit = input[y * width + x];
      if (bit !== 0 && bit !== 1) {
        throw new Error("SAM decoded mask is not binary.");
      }
      if (bit === 0) {
        encoder.encode(0, zero, zero + one);
      } else {
        encoder.encode(zero, one, zero + one);
      }
      padded[position] = bit;
      samUpdateCounts(counts, offset, bit);
    }
  }
  return `!${samPack(encoder.finish())}`;
}

function samDecodeRaster(
  payload: string,
  width: number,
  height: number,
): Uint8Array {
  const decoder = new SamRangeDecoder(samUnpack(payload.slice(1)));
  const counts = new Uint16Array(SAM_CONTEXT_COUNT * 2).fill(1);
  const paddedWidth = width + 2 * SAM_PADDING;
  const padded = new Uint8Array(paddedWidth * (height + SAM_PADDING));
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + SAM_PADDING) * paddedWidth + SAM_PADDING;
    for (let x = 0; x < width; x++) {
      const position = row + x;
      const context = samContextAt(
        padded,
        position,
        position - paddedWidth,
        position - 2 * paddedWidth,
      );
      const offset = context << 1;
      const zero = counts[offset];
      const one = counts[offset + 1];
      const value = decoder.frequency(zero + one);
      const bit = value < zero ? 0 : 1;
      if (bit === 0) {
        decoder.decode(0, zero);
      } else {
        decoder.decode(zero, one);
      }
      padded[position] = bit;
      output[y * width + x] = bit;
      samUpdateCounts(counts, offset, bit);
    }
  }
  return output;
}

function samDecodeMaskToRaster(
  encoding: "one_bit" | "lossless",
  payload: string,
  width: number,
  height: number,
): Uint8Array {
  if (width <= 0 || height <= 0) {
    throw new Error("SAM mask dimensions must be positive.");
  }
  if (encoding === "lossless") {
    if (!payload.startsWith("~")) {
      throw new Error("SAM lossless mask payloads must start with ~.");
    }
    const coverage = samDecodeLosslessRaster(payload, width, height);
    const raster = new Uint8Array(coverage.length);
    for (let i = 0; i < coverage.length; i++) {
      raster[i] = coverage[i] >= 129 ? 1 : 0;
    }
    return raster;
  }
  if (!payload.startsWith("!")) {
    throw new Error("SAM one_bit mask payloads must start with !.");
  }
  const raster = samDecodeRaster(payload, width, height);
  if (samEncodeRaster(raster, width, height) !== payload) {
    throw new Error(
      "SAM mask payload is not canonical or has invalid finalization.",
    );
  }
  return raster;
}

export interface SegmentInstance {
  id: string;
  // Box in sent-image pixels; x2/y2 are exclusive (API x2/y2 + 1).
  box: { x1: number; y1: number; x2: number; y2: number };
  sentWidth: number;
  sentHeight: number;
  maskWidth: number;
  maskHeight: number;
  // Row-major 0/1 bytes covering exactly the box.
  mask: Buffer;
  foreground: number;
}

// Parses one SAM output_text lane into instances. Exported for testing.
export function parseSegmentationText(text: string): SegmentInstance[] {
  const instances: SegmentInstance[] = [];
  const recordRe =
    /^(?:,)?([0-9]+)<\|box;x1=(-?[0-9]+);y1=(-?[0-9]+);x2=(-?[0-9]+);y2=(-?[0-9]+);w=([0-9]+);h=([0-9]+)\|><\|mask;x=0;y=0;data=([0-9]+),([0-9]+),([!~][^|]+)\|>/;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.match(/^<([0-9]+)f>([\s\S]*)$/);
    if (!header) continue; // not a segmentation line; ignore
    let remainder = header[2];
    if (!remainder) continue;
    while (remainder) {
      const m = remainder.match(recordRe);
      if (!m) {
        throw new Error("SAM response contains a malformed record.");
      }
      const id = m[1];
      const x1 = Number(m[2]);
      const y1 = Number(m[3]);
      const x2 = Number(m[4]);
      const y2 = Number(m[5]);
      const sentWidth = Number(m[6]);
      const sentHeight = Number(m[7]);
      const maskHeight = Number(m[8]);
      const maskWidth = Number(m[9]);
      const payload = m[10];
      if (
        !Number.isSafeInteger(x1) ||
        !Number.isSafeInteger(y1) ||
        !Number.isSafeInteger(x2) ||
        !Number.isSafeInteger(y2) ||
        sentWidth <= 0 ||
        sentHeight <= 0 ||
        x1 < 0 ||
        y1 < 0 ||
        x2 < x1 ||
        y2 < y1 ||
        x2 >= sentWidth ||
        y2 >= sentHeight ||
        maskWidth <= 0 ||
        maskHeight <= 0
      ) {
        throw new Error("SAM response box coordinates are invalid.");
      }
      const raster = samDecodeMaskToRaster(
        payload.startsWith("~") ? "lossless" : "one_bit",
        payload,
        maskWidth,
        maskHeight,
      );
      let foreground = 0;
      for (const v of raster) foreground += v;
      instances.push({
        id,
        box: { x1, y1, x2: x2 + 1, y2: y2 + 1 },
        sentWidth,
        sentHeight,
        maskWidth,
        maskHeight,
        mask: Buffer.from(raster),
        foreground,
      });
      remainder = remainder.slice(m[0].length);
    }
  }
  return instances;
}

export interface SegmentArgs {
  buffer: Buffer;
  mime: string;
  // Short noun phrase naming the product, e.g. "brown leather shoe".
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

export interface SegmentResult {
  instances: SegmentInstance[];
  model: string;
  ms: number;
}

function responsesEndpoint(): string {
  const base = process.env.META_API_BASE;
  if (!base) throw new Error("Missing META_API_BASE environment variable");
  if (base.endsWith("/responses")) return base;
  return `${base.replace(/\/+$/, "")}/responses`;
}

export async function segment(args: SegmentArgs): Promise<SegmentResult> {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) throw new Error("Missing META_API_KEY environment variable");
  const model = args.model ?? process.env.META_SAM_MODEL;
  if (!model) throw new Error("Missing META_SAM_MODEL environment variable");
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error("segment needs a text prompt naming the product.");
  const timeoutMs = args.timeoutMs ?? SAM_TIMEOUT_MS;
  const url = responsesEndpoint();
  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:${args.mime};base64,${args.buffer.toString("base64")}`,
          },
        ],
      },
    ],
  };

  const started = Date.now();
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(errorMessage(res.status, await res.text()));
        continue;
      }
      if (!res.ok) {
        throw new Error(errorMessage(res.status, await res.text()));
      }
      const raw = (await res.json()) as {
        model?: string;
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };
      const lanes: string[] = [];
      for (const item of raw.output ?? []) {
        if (item?.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part?.type === "output_text" && part.text) lanes.push(part.text);
        }
      }
      return {
        instances: parseSegmentationText(lanes.join("\n")),
        model:
          typeof raw.model === "string" && raw.model ? raw.model : model,
        ms: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Meta API ")) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Meta API request failed after retries");
}
