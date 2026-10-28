// lib/video.ts — promo video rendering + background job runner (AGENTS.md
// section 15). Cuts the owner's own footage into a vertical promo with
// burned-in captions and an end card. Rendering runs as a media_jobs row
// (queued → running → done/failed) so the chat never waits on it.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";
import {
  claimMediaJob,
  getClient,
  getCompany,
  getFile,
  getMediaJob,
  getRecentMessages,
  listQueuedMediaJobs,
  saveDecisions,
  saveFile,
  saveMessage,
  setMediaJobDone,
  setMediaJobFailed,
} from "./db";
import { getProvider } from "./whatsapp";

export const VIDEO_JOB_KIND = "marketing_video";
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const SIZE_BUDGET_BYTES = 15 * 1024 * 1024; // stay safely under the limit
const MAX_FOOTAGE_SEC = 28; // + 2 s end card = 30 s max
const ENDCARD_SEC = 2;
const AUDIO_BITRATE = 96_000;
const DEFAULT_TIMEOUT_MS = 240_000;

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

function fontPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "assets", "fonts", file),
    join(process.cwd(), "assets", "fonts", file),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`video: cannot find font ${file}`);
}

function runFfmpeg(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { stdio: "pipe" });
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new Error("video render timed out."));
    }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stderr });
      } else {
        reject(
          new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-500)}`),
        );
      }
    });
  });
}

export interface ProbedVideo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probeVideo(input: Buffer): Promise<ProbedVideo> {
  const inPath = join(tmpdir(), `naija-probe-${randomUUID()}`);
  try {
    writeFileSync(inPath, input);
    let stderr = "";
    try {
      const r = await runFfmpeg(
        ["-hide_banner", "-i", inPath, "-f", "null", "-"],
        { timeoutMs: 30_000 },
      );
      stderr = r.stderr;
    } catch (err) {
      stderr = err instanceof Error ? err.message : "";
    }
    const dur = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const video = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (!dur || !video) {
      throw new Error("video: could not read that file.");
    }
    const duration =
      Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("video: could not read that file.");
    }
    return {
      duration,
      width: Number(video[1]),
      height: Number(video[2]),
      hasAudio: /Stream #\d+:\d+[^:]*: Audio:/.test(stderr),
    };
  } finally {
    try {
      unlinkSync(inPath);
    } catch {
      // Already gone; nothing to do.
    }
  }
}

export interface VideoMoment {
  start: number;
  end: number;
  caption: string;
}

interface Segment extends VideoMoment {
  duration: number;
}

// Clamp moments into the footage, drop overlaps and empties, cap the total
// at 28 s (plus the 2 s end card = 30 s max).
function normalizeMoments(
  moments: VideoMoment[],
  srcDuration: number,
): Segment[] {
  const sorted = [...moments].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let total = 0;
  for (const m of sorted.slice(0, 5)) {
    if (segments.length >= 5) break;
    const start = Math.min(Math.max(m.start, 0), srcDuration);
    let end = Math.min(Math.max(m.end, 0), srcDuration);
    const prevEnd = segments.length
      ? segments[segments.length - 1].end
      : 0;
    const clampedStart = Math.max(start, prevEnd);
    if (end - clampedStart < 0.8) continue;
    if (total + (end - clampedStart) > MAX_FOOTAGE_SEC) {
      end = clampedStart + (MAX_FOOTAGE_SEC - total);
      if (end - clampedStart < 0.8) break;
    }
    total += end - clampedStart;
    segments.push({
      start: clampedStart,
      end,
      caption: m.caption,
      duration: end - clampedStart,
    });
    if (total >= MAX_FOOTAGE_SEC) break;
  }
  return segments;
}

// Greedy wrap for burned-in captions: short lines, at most 2.
function wrapCaption(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (trial.length > 22 && current) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
    if (lines.length === 2) break;
  }
  if (current && lines.length < 2) lines.push(current);
  return lines.slice(0, 2).join("\n");
}

// Escape a path for use inside a quoted ffmpeg filter option.
function escapeFilterPath(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function dayStamp(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export interface RenderPromoArgs {
  source: Buffer;
  moments: VideoMoment[];
  opening: string;
  businessName: string;
  endcardColor?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export interface RenderPromoResult {
  buffer: Buffer;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
}

async function renderOnce(args: {
  source: Buffer;
  segments: Segment[];
  probed: ProbedVideo;
  opening: string;
  businessName: string;
  endcardColor: string;
  width: number;
  height: number;
  timeoutMs: number;
}): Promise<RenderPromoResult> {
  const { segments, probed, width: W, height: H } = args;
  const tempFiles: string[] = [];
  const track = (p: string): string => {
    tempFiles.push(p);
    return p;
  };
  try {
    const inPath = track(join(tmpdir(), `naija-vid-in-${randomUUID()}`));
    writeFileSync(inPath, args.source);
    const outPath = track(join(tmpdir(), `naija-vid-out-${randomUUID()}.mp4`));

    const captionFont = fontPath("WorkSans-Variable.ttf");
    const displayFont = fontPath("Anton-Regular.ttf");
    const captionFiles = segments.map((s, i) => {
      const p = track(join(tmpdir(), `naija-cap-${randomUUID()}-${i}.txt`));
      writeFileSync(p, wrapCaption(s.caption));
      return p;
    });
    const openingFile = track(join(tmpdir(), `naija-cap-${randomUUID()}-open.txt`));
    writeFileSync(openingFile, wrapCaption(args.opening));
    const nameFile = track(join(tmpdir(), `naija-cap-${randomUUID()}-name.txt`));
    writeFileSync(nameFile, args.businessName);
    const ctaFile = track(join(tmpdir(), `naija-cap-${randomUUID()}-cta.txt`));
    writeFileSync(ctaFile, "Order on WhatsApp");

    // Segment boundaries on the final timeline (footage, then end card).
    const bounds: Array<{ from: number; to: number }> = [];
    let cursor = 0;
    for (const s of segments) {
      bounds.push({ from: cursor, to: cursor + s.duration });
      cursor += s.duration;
    }
    const footage = cursor;
    const total = footage + ENDCARD_SEC;

    const filters: string[] = [];
    segments.forEach((s, i) => {
      filters.push(
        `[0:v]trim=start=${s.start.toFixed(2)}:end=${s.end.toFixed(2)},` +
          `setpts=PTS-STARTPTS,crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',` +
          `scale=${W}:${H}:flags=lanczos,setsar=1,fps=30,format=yuv420p[v${i}]`,
      );
    });
    // Audio: the owner's sound under the footage, silence under the end
    // card (and under everything when the source has no audio track).
    const silenceNeeded = (probed.hasAudio ? 0 : segments.length) + 1;
    if (silenceNeeded > 1) {
      const outs = Array.from(
        { length: silenceNeeded },
        (_, i) => `[sil${i}]`,
      ).join("");
      filters.push(`[2:a]asplit=${silenceNeeded}${outs}`);
    }
    const silEnd = silenceNeeded > 1 ? `[sil${silenceNeeded - 1}]` : "[2:a]";
    segments.forEach((s, i) => {
      if (probed.hasAudio) {
        filters.push(
          `[0:a]atrim=start=${s.start.toFixed(2)}:end=${s.end.toFixed(2)},` +
            `asetpts=PTS-STARTPTS,aresample=44100,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
        );
      } else {
        filters.push(
          `[sil${i}]atrim=start=0:end=${s.duration.toFixed(2)},` +
            `asetpts=PTS-STARTPTS,aresample=44100,` +
            `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
        );
      }
    });
    filters.push(
      `${silEnd}atrim=start=0:end=${ENDCARD_SEC},asetpts=PTS-STARTPTS,` +
        `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[enda]`,
    );
    filters.push(
      `[1:v]format=yuv420p,setsar=1,fps=30,` +
        `drawtext=fontfile=${escapeFilterPath(displayFont)}:textfile=${escapeFilterPath(nameFile)}:expansion=none:fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-70,` +
        `drawtext=fontfile=${escapeFilterPath(captionFont)}:textfile=${escapeFilterPath(ctaFile)}:expansion=none:fontsize=46:fontcolor=white:box=1:boxcolor=white@0.18:boxborderw=28:x=(w-text_w)/2:y=(h-text_h)/2+70[endv]`,
    );
    const concatInputs =
      segments.map((_, i) => `[v${i}][a${i}]`).join("") + "[endv][enda]";
    filters.push(
      `${concatInputs}concat=n=${segments.length + 1}:v=1:a=1[vcat][acat]`,
    );
    const captionDraws = segments.map((_, i) => {
      const b = bounds[i];
      return (
        `drawtext=fontfile=${escapeFilterPath(captionFont)}:` +
        `textfile=${escapeFilterPath(captionFiles[i])}:expansion=none:` +
        `fontsize=54:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=22:` +
        `x=(w-text_w)/2:y=h-420:enable='between(t,${b.from.toFixed(2)},${b.to.toFixed(2)})'`
      );
    });
    const openingDraw =
      `drawtext=fontfile=${escapeFilterPath(captionFont)}:` +
      `textfile=${escapeFilterPath(openingFile)}:expansion=none:` +
      `fontsize=60:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=22:` +
      `x=(w-text_w)/2:y=300:enable='between(t,0,${Math.min(3, footage).toFixed(2)})'`;
    filters.push(`[vcat]${[...captionDraws, openingDraw].join(",")}[vout]`);

    // Bitrate math keeps the file under the size budget by construction.
    const videoBitrate = Math.min(
      8_000,
      Math.max(
        300,
        Math.floor((SIZE_BUDGET_BYTES * 8) / total - AUDIO_BITRATE) / 1000,
      ),
    );
    const maxrate = Math.ceil(videoBitrate * 1.5);
    const bufsize = Math.ceil(videoBitrate * 3);
    const color = `0x${args.endcardColor.replace(/^#/, "")}`;

    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inPath,
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=${W}x${H}:r=30:d=${ENDCARD_SEC}`,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo:d=60",
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[vout]",
        "-map",
        "[acat]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        `${videoBitrate}k`,
        "-maxrate",
        `${maxrate}k`,
        "-bufsize",
        `${bufsize}k`,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ar",
        "44100",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeoutMs: args.timeoutMs },
    );
    const buffer = readFileSync(outPath);
    return {
      buffer,
      durationSec: total,
      width: W,
      height: H,
      sizeBytes: buffer.length,
    };
  } finally {
    for (const p of tempFiles) {
      try {
        unlinkSync(p);
      } catch {
        // Already gone; nothing to do.
      }
    }
  }
}

export async function renderPromo(
  args: RenderPromoArgs,
): Promise<RenderPromoResult> {
  const opening = args.opening.trim();
  const businessName = args.businessName.trim() || "Our Business";
  if (!opening) throw new Error("renderPromo needs an opening line.");
  if (args.moments.length === 0) {
    throw new Error("renderPromo needs at least one moment.");
  }
  const probed = await probeVideo(args.source);
  const segments = normalizeMoments(args.moments, probed.duration);
  if (segments.length === 0) {
    throw new Error(
      "None of those moments fit inside the video. Pick start and end times within it.",
    );
  }
  const full = await renderOnce({
    source: args.source,
    segments,
    probed,
    opening: opening.slice(0, 80),
    businessName: businessName.slice(0, 60),
    endcardColor: args.endcardColor ?? "#14532d",
    width: args.width ?? 1080,
    height: args.height ?? 1920,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  // Too heavy: re-render lighter at 720x1280 (AGENTS.md section 15).
  if (full.sizeBytes > MAX_VIDEO_BYTES && full.width > 720) {
    const light = await renderOnce({
      source: args.source,
      segments,
      probed,
      opening: opening.slice(0, 80),
      businessName: businessName.slice(0, 60),
      endcardColor: args.endcardColor ?? "#14532d",
      width: 720,
      height: 1280,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (light.sizeBytes > MAX_VIDEO_BYTES) {
      throw new Error("The finished video is still over 16 MB.");
    }
    return light;
  }
  if (full.sizeBytes > MAX_VIDEO_BYTES) {
    throw new Error("The finished video is over 16 MB.");
  }
  return full;
}

// ---------------------------------------------------------------------------
// Job input validation (shared by the make_video tool and the runner).
// ---------------------------------------------------------------------------

export interface ValidVideoJobInput {
  fileId: string;
  channelId: string;
  source: "tryit" | "whatsapp";
  moments: VideoMoment[];
  opening: string;
}

export function validateVideoJobInput(input: unknown): ValidVideoJobInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("make_video needs file_id, moments and an opening line.");
  }
  const obj = input as Record<string, unknown>;
  const rawFileId = obj.file_id ?? obj.fileId;
  const fileId =
    typeof rawFileId === "string" ? rawFileId.trim() : "";
  if (!fileId) throw new Error("make_video needs a file_id.");
  const rawChannel = obj.channel_id ?? obj.channelId;
  const channelId =
    typeof rawChannel === "string" && rawChannel.trim()
      ? rawChannel.trim()
      : "marketing";
  const source = obj.source === "whatsapp" ? "whatsapp" : "tryit";
  const rawMoments = obj.moments;
  if (!Array.isArray(rawMoments) || rawMoments.length === 0) {
    throw new Error("make_video needs 1 to 5 moments.");
  }
  if (rawMoments.length > 5) {
    throw new Error("make_video takes at most 5 moments.");
  }
  const moments: VideoMoment[] = rawMoments.map((raw, i) => {
    const label = `moment ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${label} is not readable.`);
    }
    const m = raw as Record<string, unknown>;
    const start = m.start;
    const end = m.end;
    if (
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start < 0 ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      throw new Error(
        `${label} needs start and end in seconds with end after start.`,
      );
    }
    const caption = typeof m.caption === "string" ? m.caption.trim() : "";
    if (!caption) throw new Error(`${label} needs a caption.`);
    return { start, end, caption: caption.slice(0, 60) };
  });
  const opening =
    typeof obj.opening === "string" ? obj.opening.trim().slice(0, 80) : "";
  if (!opening) throw new Error("make_video needs an opening line.");
  return { fileId, channelId, source, moments, opening };
}

// ---------------------------------------------------------------------------
// Job runner: queued → running → done/failed. Routes run this in after() so
// the chat never waits on a render.
// ---------------------------------------------------------------------------

export interface VideoJobTimings {
  downloadMs: number;
  renderMs: number;
  uploadMs: number;
  totalMs: number;
}

export interface RunJobResult {
  ran: boolean;
  jobId: string;
  status: "done" | "failed" | "skipped";
  timings?: VideoJobTimings;
  fileId?: string;
  decisionId?: string;
  error?: string;
}

async function downloadFile(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`could not download the video (HTTP ${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function runMarketingVideoJob(
  jobId: string,
): Promise<RunJobResult> {
  const started = Date.now();
  const job = await getMediaJob(jobId);
  if (!job || job.kind !== VIDEO_JOB_KIND || job.status !== "queued") {
    return { ran: false, jobId, status: "skipped" };
  }
  const companyId = job.company_id;
  if (!(await claimMediaJob(companyId, jobId))) {
    return { ran: false, jobId, status: "skipped" };
  }

  let phone: string | null = null;
  let source: "tryit" | "whatsapp" = "tryit";
  let channelId = "marketing";
  const fail = async (message: string): Promise<RunJobResult> => {
    await setMediaJobFailed(companyId, jobId, message);
    const note =
      "Sorry, your video didn't work out. Please send the clip again, or a shorter one, and I'll try again.";
    if (source === "whatsapp" && phone) {
      try {
        await getProvider().sendText(phone, note);
      } catch (err) {
        console.error(
          `video job ${jobId} failure notice failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else if (source === "tryit") {
      // No push channel on web: leave the note in the chat history so the
      // owner sees it next time they open the channel.
      try {
        await saveMessage({
          companyId,
          channelId,
          agentKey: "marketing",
          agentName: "Promotion",
          ownerMessage: "",
          reply: note,
          source: "tryit",
        });
      } catch (err) {
        console.error(
          `video job ${jobId} failure note failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { ran: true, jobId, status: "failed", error: message };
  };

  try {
    const input = validateVideoJobInput(job.input);
    source = input.source;
    channelId = input.channelId;
    const company = await getCompany(companyId);
    if (!company) throw new Error("Company not found.");
    phone = company.whatsapp_phone;
    const file = await getFile(input.fileId);
    if (!file || file.company_id !== companyId) {
      throw new Error("The source video was not found.");
    }

    const tDownload = Date.now();
    const sourceBuffer = await downloadFile(file.url);
    const downloadMs = Date.now() - tDownload;

    const tRender = Date.now();
    const rendered = await renderPromo({
      source: sourceBuffer,
      moments: input.moments,
      opening: input.opening,
      businessName: company.name,
    });
    const renderMs = Date.now() - tRender;

    const tUpload = Date.now();
    const path = `${companyId}/${dayStamp()}/${randomUUID()}.mp4`;
    const { error: uploadError } = await getClient()
      .storage.from("files")
      .upload(path, rendered.buffer, {
        contentType: "video/mp4",
        upsert: false,
      });
    if (uploadError) {
      throw new Error(`video upload failed: ${uploadError.message}`);
    }
    const url = getClient().storage.from("files").getPublicUrl(path).data
      .publicUrl;

    // The run that enqueued this job saves its message after the tool
    // call, so the trigger is the oldest message in the channel created
    // at or after the job.
    const recent = await getRecentMessages(companyId, input.channelId, 10);
    const sorted = [...recent].sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1,
    );
    const trigger =
      sorted.find((m) => m.created_at >= job.created_at) ??
      sorted[sorted.length - 1];
    if (!trigger) throw new Error("No message found for this video job.");

    const savedFile = await saveFile({
      companyId,
      kind: "marketing_video",
      url,
      mime: "video/mp4",
      madeBy: "team",
      messageId: trigger.id,
      meta: {
        size: rendered.sizeBytes,
        duration: Math.round(rendered.durationSec),
        width: rendered.width,
        height: rendered.height,
        source_file_id: input.fileId,
      },
    });
    const [proposal] = await saveDecisions({
      companyId,
      messageId: trigger.id,
      channelId: input.channelId,
      decisions: [
        {
          title: "Promo video from your shop video",
          description:
            "A short vertical video with captions and an end card, ready for WhatsApp Status. Approve it before it is posted anywhere.",
          category: "marketing",
          owner: "marketing",
          priority: "high",
          kind: "video",
          payload: { file_id: savedFile.id },
        },
      ],
    });
    const uploadMs = Date.now() - tUpload;
    const timings: VideoJobTimings = {
      downloadMs,
      renderMs,
      uploadMs,
      totalMs: Date.now() - started,
    };
    await setMediaJobDone(companyId, jobId, {
      file_id: savedFile.id,
      url,
      decision_id: proposal.decision_id,
      duration_sec: Math.round(rendered.durationSec),
      width: rendered.width,
      height: rendered.height,
      size_bytes: rendered.sizeBytes,
      timings,
    });

    if (source === "whatsapp" && phone) {
      try {
        const wa = getProvider();
        await wa.sendMedia(
          phone,
          url,
          "Your promo video is ready — approve it before it is posted anywhere.",
        );
        await wa.sendProposals(phone, [
          {
            decision_id: proposal.decision_id,
            title: proposal.title,
            description: proposal.description,
          },
        ]);
      } catch (err) {
        console.error(
          `video job ${jobId} done-notice failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return {
      ran: true,
      jobId,
      status: "done",
      timings,
      fileId: savedFile.id,
      decisionId: proposal.decision_id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

// Runs every queued marketing video for a company, one at a time (parallel
// ffmpeg renders would blow Vercel's memory). Routes call this in after().
export async function drainCompanyVideoJobs(
  companyId: string,
): Promise<RunJobResult[]> {
  const queued = await listQueuedMediaJobs(companyId, VIDEO_JOB_KIND);
  const results: RunJobResult[] = [];
  for (const job of queued) {
    results.push(await runMarketingVideoJob(job.id));
  }
  return results;
}
