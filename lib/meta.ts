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
