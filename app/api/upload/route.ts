import { NextResponse } from "next/server";
import { getSessionCompanyId } from "@/lib/session";
import { MediaError, processMedia } from "@/lib/media";
import { runTeam } from "@/lib/agents/run";

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
