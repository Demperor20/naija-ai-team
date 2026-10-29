import { after, NextResponse } from "next/server";
import { getSessionCompanyId } from "@/lib/session";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MediaError,
  processMedia,
} from "@/lib/media";
import { runTeam } from "@/lib/agents/run";
import { drainCompanyVideoJobs } from "@/lib/video";
import {
  checkCompanyRateLimit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit";

export const maxDuration = 300;

// POST /api/upload (multipart): file + optional message + channelId.
// Runs the file through lib/media.ts, then the team, and returns the
// message response plus the processed media info.
export async function POST(request: Request) {
  const companyId = await getSessionCompanyId();
  if (!companyId) {
    return NextResponse.json(
      {
        ok: false,
        error: "Your session expired. Please start again from the Try-it page.",
      },
      { status: 401 },
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Please send a photo, voice note or video." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Please attach a photo, voice note or video." },
      { status: 400 },
    );
  }
  const rawChannel = form.get("channelId");
  const channelId =
    typeof rawChannel === "string" && rawChannel ? rawChannel : "general";
  const rawMessage = form.get("message");
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";

  if (!(await checkCompanyRateLimit(companyId)).allowed) {
    return NextResponse.json(
      { ok: false, error: RATE_LIMIT_MESSAGE },
      { status: 429 },
    );
  }
  // Reject oversized uploads before buffering them into memory: photos
  // over 10 MB, anything else over 16 MB (processMedia re-checks by type).
  const uploadCap = file.type.startsWith("image/")
    ? MAX_IMAGE_BYTES
    : MAX_VIDEO_BYTES;
  if (file.size > uploadCap) {
    const capMb = Math.round(uploadCap / 1024 / 1024);
    return NextResponse.json(
      {
        ok: false,
        error: `That file is too big for me (over ${capMb} MB). Please send a smaller one.`,
      },
      { status: 400 },
    );
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    const processed = await processMedia({ companyId, buffer, mime });
    const fallbackText =
      processed.kind === "audio"
        ? "(Sent a voice note)"
        : processed.kind === "video"
          ? "(Sent a video)"
          : "(Sent a photo)";
    const result = await runTeam({
      companyId,
      channelId,
      message: message || fallbackText,
      source: "tryit",
      attachments: [
        {
          kind: processed.fileKind,
          url: processed.url,
          fileId: processed.fileId,
          mime: processed.mime,
          description: processed.description,
        },
      ],
    });
    // Queued video renders run after the response (see team route).
    after(() =>
      drainCompanyVideoJobs(companyId).catch((err) =>
        console.error(
          "upload video drain failed:",
          err instanceof Error ? err.message : err,
        ),
      ),
    );
    return NextResponse.json({
      ...result,
      media: {
        fileId: processed.fileId,
        url: processed.url,
        kind: processed.kind,
        mime: processed.mime,
        transcript: processed.transcript ?? null,
        category: processed.category ?? null,
      },
    });
  } catch (err) {
    if (err instanceof MediaError) {
      return NextResponse.json(
        { ok: false, error: err.userMessage },
        { status: 400 },
      );
    }
    console.error(
      "POST /api/upload failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { ok: false, error: "Sorry, something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
