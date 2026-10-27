import { after } from "next/server";
import {
  createCompany,
  getDecision,
  getWhatsappUser,
  hasWhatsappSeen,
  markWhatsappSeen,
  setDecisionStatus,
  upsertWhatsappUser,
  type WhatsappUser,
} from "@/lib/db";
import { runTeam } from "@/lib/agents/run";
import { applyDecision } from "@/lib/decisions";
import {
  downloadMedia,
  sendProposalButtons,
  sendText,
  verifySignature,
} from "@/lib/whatsapp";
import { MediaError, processMedia } from "@/lib/media";

export const maxDuration = 300;

interface WaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface WaMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
}

interface WaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: WaMessage[] };
    }>;
  }>;
}

const SORRY = "Sorry, something went wrong. Please try again.";

// Sends are best-effort: a failed send must never abort the run (which would
// skip the reply, the proposals or the kickoff). Logic errors still reach
// the catch in handleMessage, which sends SORRY.
async function trySend(
  phone: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(
      `whatsapp send (${label}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function dashboardUrlFor(accessToken: string): string {
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (host) return `https://${host}/d/${accessToken}`;
  return `/d/${accessToken}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    mode === "subscribe" &&
    expected &&
    token === expected &&
    challenge
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    return new Response("forbidden", { status: 403 });
  }
  let payload: WaPayload = {};
  try {
    payload = JSON.parse(raw) as WaPayload;
  } catch {
    return Response.json({ ok: true });
  }
  after(() =>
    handleWebhook(payload).catch((err) =>
      console.error(
        "whatsapp after() failed:",
        err instanceof Error ? err.message : err,
      ),
    ),
  );
  return Response.json({ ok: true });
}

async function handleWebhook(payload: WaPayload): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        await handleMessage(message);
      }
    }
  }
}

async function handleMessage(message: WaMessage): Promise<void> {
  const id = message.id;
  const from = message.from;
  if (!id || !from) return;
  try {
    if (await hasWhatsappSeen(id)) return;
    await markWhatsappSeen(id);
    if (message.type === "text" && message.text?.body) {
      await handleText(from, message.text.body);
    } else if (
      message.type === "interactive" &&
      message.interactive?.type === "button_reply" &&
      message.interactive.button_reply?.id
    ) {
      await handleButton(from, message.interactive.button_reply.id);
    } else if (
      (message.type === "image" && message.image?.id) ||
      (message.type === "audio" && message.audio?.id) ||
      (message.type === "video" && message.video?.id)
    ) {
      const media =
        message.type === "image"
          ? message.image
          : message.type === "audio"
            ? message.audio
            : message.video;
      await handleMedia(from, media as WaMedia);
    } else {
      await trySend(from, "unsupported", () =>
        sendText(
          from,
          "Sorry, I can use photos, voice notes, short videos and text. Please send one of those.",
        ),
      );
    }
  } catch (err) {
    console.error(
      `whatsapp message ${id} failed:`,
      err instanceof Error ? err.message : err,
    );
    await trySend(from, "sorry", () => sendText(from, SORRY));
  }
}

async function sendReplyWithProposals(
  phone: string,
  reply: string,
  decisions: Array<{
    decision_id: string;
    title: string;
    description: string;
  }>,
): Promise<void> {
  await trySend(phone, "reply", () => sendText(phone, reply));
  for (const d of decisions) {
    await trySend(phone, "proposal-buttons", () =>
      sendProposalButtons(phone, d.title, d.description, d.decision_id),
    );
  }
}

async function handleMedia(phone: string, media: WaMedia): Promise<void> {
  const user = await getWhatsappUser(phone);
  if (!user || !user.company_id) {
    const step = user?.onboarding_step ?? "start";
    if (step === "start") {
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_name",
        onboardingData: {},
      });
      await trySend(phone, "greeting", () =>
        sendText(
          phone,
          "Hello! I'm your AI business team. Let's set you up first — what's your name? (Please resend your photo, voice note or video after.)",
        ),
      );
    } else {
      await trySend(phone, "onboarding-nudge", () =>
        sendText(
          phone,
          "One thing at a time — please answer the question above first, then resend your photo, voice note or video.",
        ),
      );
    }
    return;
  }
  let downloaded;
  try {
    downloaded = await downloadMedia(media.id as string);
  } catch (err) {
    console.error(
      "whatsapp media download failed:",
      err instanceof Error ? err.message : err,
    );
    await trySend(phone, "download-failed", () =>
      sendText(
        phone,
        "Sorry, I couldn't fetch that file. Please send it again.",
      ),
    );
    return;
  }
  let processed;
  try {
    processed = await processMedia({
      companyId: user.company_id,
      buffer: downloaded.buffer,
      mime: downloaded.mimeType,
    });
  } catch (err) {
    if (err instanceof MediaError) {
      await trySend(phone, "media-limit", () =>
        sendText(phone, err.userMessage),
      );
      return;
    }
    throw err;
  }
  if (processed.kind === "audio" && processed.transcript) {
    await trySend(phone, "heard", () =>
      sendText(phone, `I heard: "${processed.transcript}"`),
    );
  }
  await trySend(phone, "ack", () =>
    sendText(phone, "Got it — the team is on it."),
  );
  const caption = media.caption?.trim();
  const fallbackText =
    processed.kind === "audio"
      ? "(Sent a voice note)"
      : processed.kind === "video"
        ? "(Sent a video)"
        : "(Sent a photo)";
  const result = await runTeam({
    companyId: user.company_id,
    channelId: "whatsapp",
    message: caption || fallbackText,
    source: "whatsapp",
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
  await sendReplyWithProposals(phone, result.reply, result.decisions);
}

async function handleText(phone: string, body: string): Promise<void> {
  const user = await getWhatsappUser(phone);
  if (!user || !user.company_id) {
    await handleOnboarding(phone, user, body);
    return;
  }
  if (user.awaiting_note_for) {
    const decisionId = user.awaiting_note_for;
    const decision = await getDecision(user.company_id, decisionId);
    await upsertWhatsappUser({ phone, awaitingNoteFor: null });
    if (!decision) {
      await trySend(phone, "gone", () =>
        sendText(phone, "That proposal is no longer available."),
      );
      return;
    }
    await setDecisionStatus(
      user.company_id,
      decisionId,
      "changes_requested",
      body,
    );
    const result = await runTeam({
      companyId: user.company_id,
      channelId: "whatsapp",
      message: `The owner requested changes on "${decision.title}": ${body}`,
      source: "whatsapp",
    });
    await sendReplyWithProposals(phone, result.reply, result.decisions);
    return;
  }
  await trySend(phone, "ack", () =>
    sendText(phone, "Got it — the team is on it."),
  );
  const result = await runTeam({
    companyId: user.company_id,
    channelId: "whatsapp",
    message: body,
    source: "whatsapp",
  });
  await sendReplyWithProposals(phone, result.reply, result.decisions);
}

async function handleButton(phone: string, buttonId: string): Promise<void> {
  const sep = buttonId.lastIndexOf(":");
  const decisionId = sep > 0 ? buttonId.slice(0, sep) : "";
  const status = sep > 0 ? buttonId.slice(sep + 1) : "";
  if (
    !decisionId ||
    (status !== "approved" &&
      status !== "rejected" &&
      status !== "changes_requested")
  ) {
    await trySend(phone, "stale-button", () =>
      sendText(phone, "Sorry, that button is no longer valid."),
    );
    return;
  }
  const user = await getWhatsappUser(phone);
  if (!user?.company_id) {
    await trySend(phone, "no-team", () =>
      sendText(
        phone,
        "Your team isn't set up on this number yet. Please send Hi to start.",
      ),
    );
    return;
  }
  const decision = await getDecision(user.company_id, decisionId);
  if (!decision) {
    await trySend(phone, "gone", () =>
      sendText(phone, "That proposal is no longer available."),
    );
    return;
  }
  if (status === "changes_requested") {
    await upsertWhatsappUser({ phone, awaitingNoteFor: decisionId });
    await trySend(phone, "ask-note", () =>
      sendText(phone, "What should change?"),
    );
    return;
  }
  await setDecisionStatus(user.company_id, decisionId, status);
  if (status === "approved") {
    try {
      await applyDecision(user.company_id, decisionId);
    } catch (err) {
      console.error(
        `whatsapp apply failed for ${decisionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await trySend(phone, "decided", () =>
    sendText(
      phone,
      status === "approved"
        ? `Approved: ${decision.title}. The team will build on it.`
        : `OK, rejected: ${decision.title}.`,
    ),
  );
}

async function handleOnboarding(
  phone: string,
  user: WhatsappUser | null,
  body: string,
): Promise<void> {
  const step = user?.onboarding_step ?? "start";
  const data = (user?.onboarding_data as Record<string, string> | null) ?? {};
  const answer = body.trim();

  switch (step) {
    case "await_name": {
      if (!answer) {
        await trySend(phone, "ask-name", () =>
          sendText(phone, "What's your name?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_biz",
        onboardingData: { ...data, name: answer },
      });
      await trySend(phone, "ask-biz", () =>
        sendText(
          phone,
          `Nice to meet you, ${answer}! What's your business name?`,
        ),
      );
      return;
    }
    case "await_biz": {
      if (!answer) {
        await trySend(phone, "ask-biz", () =>
          sendText(phone, "What's your business name?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_sells",
        onboardingData: { ...data, biz: answer },
      });
      await trySend(phone, "ask-sells", () =>
        sendText(phone, "What do you sell or plan to build?"),
      );
      return;
    }
    case "await_sells": {
      if (!answer) {
        await trySend(phone, "ask-sells", () =>
          sendText(phone, "What do you sell or plan to build?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_goal",
        onboardingData: { ...data, sells: answer },
      });
      await trySend(phone, "ask-goal", () =>
        sendText(phone, "What's your goal for the next 3 months?"),
      );
      return;
    }
    case "await_goal": {
      if (!answer) {
        await trySend(phone, "ask-goal", () =>
          sendText(phone, "What's your goal for the next 3 months?"),
        );
        return;
      }
      const sells = data.sells ?? "";
      const company = await createCompany({
        ownerName: data.name ?? "Owner",
        name: data.biz ?? "My Business",
        oneLiner: sells.slice(0, 140) || "New WhatsApp business",
        description: sells,
        goals: answer,
        stage: "Idea",
        source: "whatsapp",
        whatsappPhone: phone,
      });
      await upsertWhatsappUser({
        phone,
        companyId: company.id,
        onboardingStep: "done",
        onboardingData: {},
      });
      await trySend(phone, "setting-up", () =>
        sendText(phone, "Setting up your team — this takes about a minute."),
      );
      const kickoff = await runTeam({
        companyId: company.id,
        channelId: "whatsapp",
        message: "(New business signed up)",
        source: "whatsapp",
        isKickoff: true,
      });
      await sendReplyWithProposals(phone, kickoff.reply, kickoff.decisions);
      await trySend(phone, "dashboard", () =>
        sendText(
          phone,
          `Your dashboard: ${dashboardUrlFor(company.access_token)}`,
        ),
      );
      return;
    }
    default: {
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_name",
        onboardingData: {},
      });
      await trySend(phone, "greeting", () =>
        sendText(
          phone,
          "Hello! I'm your AI business team. First, what's your name?",
        ),
      );
      return;
    }
  }
}
