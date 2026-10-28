// lib/whatsapp/handle.ts — the shared WhatsApp flow for both providers
// (Meta Cloud API and Twilio Sandbox): duplicates, onboarding, rate limits,
// runTeam, decisions and video drains. Providers differ only in how bytes
// move (buttons vs letters); every decision here is identical.

import {
  createCompany,
  getDecision,
  getFile,
  getWhatsappUser,
  hasWhatsappSeen,
  listDecisions,
  markWhatsappSeen,
  setDecisionStatus,
  upsertWhatsappUser,
  type WhatsappUser,
} from "../db";
import { runTeam } from "../agents/run";
import { applyDecision } from "../decisions";
import { drainCompanyVideoJobs } from "../video";
import { MediaError, processMedia } from "../media";
import {
  checkCompanyRateLimit,
  checkPhoneRateLimit,
  RATE_LIMIT_MESSAGE,
} from "../rate-limit";
import {
  buildProposalList,
  parseLetterCommand,
  readLetters,
  storeLetters,
} from "./twilio";
import type {
  IncomingMessage,
  ProposalSummary,
  WhatsAppProvider,
} from "./types";

const SORRY = "Sorry, something went wrong. Please try again.";
const UNSUPPORTED =
  "Sorry, I can use photos, voice notes, short videos and text. Please send one of those.";

// Sends are best-effort: a failed send must never abort the run (which would
// skip the reply, the proposals or the kickoff). Logic errors still reach
// the catch in handleIncoming, which sends SORRY.
async function trySend(
  provider: WhatsAppProvider,
  phone: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(
      `whatsapp/${provider.id} send (${label}) to ${phone} failed:`,
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

export async function handleIncoming(
  provider: WhatsAppProvider,
  message: IncomingMessage,
): Promise<void> {
  const { from: phone, messageId: id } = message;
  try {
    if (await hasWhatsappSeen(id)) return;
    await markWhatsappSeen(id);
    if (message.type === "text") {
      await handleText(provider, phone, message.text);
    } else if (message.type === "reply" && message.replyId) {
      await handleReply(provider, phone, message.replyId);
    } else if (
      (message.type === "image" ||
        message.type === "audio" ||
        message.type === "video") &&
      message.media
    ) {
      await handleMedia(provider, phone, message);
    } else {
      await trySend(provider, phone, "unsupported", () =>
        provider.sendText(phone, UNSUPPORTED),
      );
    }
  } catch (err) {
    console.error(
      `whatsapp/${provider.id} message ${id} failed:`,
      err instanceof Error ? err.message : err,
    );
    await trySend(provider, phone, "sorry", () => provider.sendText(phone, SORRY));
  }
}

async function sendReplyWithProposals(
  provider: WhatsAppProvider,
  phone: string,
  reply: string,
  decisions: ProposalSummary[],
): Promise<void> {
  if (provider.id === "twilio") {
    // One combined message (the Sandbox allows 1 message per 3 seconds).
    if (decisions.length === 0) {
      await trySend(provider, phone, "reply", () =>
        provider.sendText(phone, reply),
      );
      return;
    }
    const built = buildProposalList(decisions);
    await storeLetters(phone, built.map);
    await trySend(provider, phone, "reply", () =>
      provider.sendText(phone, `${reply}\n\n${built.text}`),
    );
    return;
  }
  await trySend(provider, phone, "reply", () => provider.sendText(phone, reply));
  if (decisions.length > 0) {
    await trySend(provider, phone, "proposal-buttons", () =>
      provider.sendProposals(phone, decisions),
    );
  }
}

// Video renders run after the reply is sent: the owner already got "your
// video is cooking" and the finished proposal arrives as its own message.
async function drainVideos(companyId: string): Promise<void> {
  try {
    await drainCompanyVideoJobs(companyId);
  } catch (err) {
    console.error(
      "whatsapp video drain failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function handleMedia(
  provider: WhatsAppProvider,
  phone: string,
  message: IncomingMessage,
): Promise<void> {
  const user = await getWhatsappUser(phone);
  if (!user || !user.company_id) {
    if (!checkPhoneRateLimit(phone).allowed) {
      await trySend(provider, phone, "rate-limit", () =>
        provider.sendText(phone, RATE_LIMIT_MESSAGE),
      );
      return;
    }
    const step = user?.onboarding_step ?? "start";
    if (step === "start") {
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_name",
        onboardingData: {},
      });
      await trySend(provider, phone, "greeting", () =>
        provider.sendText(
          phone,
          "Hello! I'm your AI business team. Let's set you up first — what's your name? (Please resend your photo, voice note or video after.)",
        ),
      );
    } else {
      await trySend(provider, phone, "onboarding-nudge", () =>
        provider.sendText(
          phone,
          "One thing at a time — please answer the question above first, then resend your photo, voice note or video.",
        ),
      );
    }
    return;
  }
  if (!(await checkCompanyRateLimit(user.company_id)).allowed) {
    await trySend(provider, phone, "rate-limit", () =>
      provider.sendText(phone, RATE_LIMIT_MESSAGE),
    );
    return;
  }
  let downloaded;
  try {
    downloaded = await message.media!.fetch();
  } catch (err) {
    console.error(
      `whatsapp/${provider.id} media download failed:`,
      err instanceof Error ? err.message : err,
    );
    await trySend(provider, phone, "download-failed", () =>
      provider.sendText(
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
      mime: downloaded.mime,
    });
  } catch (err) {
    if (err instanceof MediaError) {
      await trySend(provider, phone, "media-limit", () =>
        provider.sendText(phone, err.userMessage),
      );
      return;
    }
    throw err;
  }
  if (processed.kind === "audio" && processed.transcript) {
    await trySend(provider, phone, "heard", () =>
      provider.sendText(phone, `I heard: "${processed.transcript}"`),
    );
  }
  await trySend(provider, phone, "ack", () =>
    provider.sendText(phone, "Got it — the team is on it."),
  );
  const caption = message.caption?.trim();
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
  await sendReplyWithProposals(provider, phone, result.reply, result.decisions);
  await drainVideos(user.company_id);
}

async function handleText(
  provider: WhatsAppProvider,
  phone: string,
  body: string,
): Promise<void> {
  const user = await getWhatsappUser(phone);
  if (!user || !user.company_id) {
    if (!checkPhoneRateLimit(phone).allowed) {
      await trySend(provider, phone, "rate-limit", () =>
        provider.sendText(phone, RATE_LIMIT_MESSAGE),
      );
      return;
    }
    await handleOnboarding(provider, phone, user, body);
    return;
  }
  if (!(await checkCompanyRateLimit(user.company_id)).allowed) {
    await trySend(provider, phone, "rate-limit", () =>
      provider.sendText(phone, RATE_LIMIT_MESSAGE),
    );
    return;
  }
  // Twilio has no buttons: "yes A" style replies decide proposals. Anything
  // else falls through to the team as a normal message.
  if (provider.id === "twilio" && body.trim()) {
    const handled = await handleLetterCommand(provider, phone, user.company_id, body);
    if (handled) return;
  }
  if (!body.trim()) {
    await trySend(provider, phone, "unsupported", () =>
      provider.sendText(phone, UNSUPPORTED),
    );
    return;
  }
  if (user.awaiting_note_for) {
    const decisionId = user.awaiting_note_for;
    const decision = await getDecision(user.company_id, decisionId);
    await upsertWhatsappUser({ phone, awaitingNoteFor: null });
    if (!decision) {
      await trySend(provider, phone, "gone", () =>
        provider.sendText(phone, "That proposal is no longer available."),
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
    await sendReplyWithProposals(provider, phone, result.reply, result.decisions);
    await drainVideos(user.company_id);
    return;
  }
  await trySend(provider, phone, "ack", () =>
    provider.sendText(phone, "Got it — the team is on it."),
  );
  const result = await runTeam({
    companyId: user.company_id,
    channelId: "whatsapp",
    message: body,
    source: "whatsapp",
  });
  await sendReplyWithProposals(provider, phone, result.reply, result.decisions);
  await drainVideos(user.company_id);
}

// One decision tap (Meta button) or letter command (Twilio), shared.
async function decideById(
  provider: WhatsAppProvider,
  phone: string,
  companyId: string,
  decisionId: string,
  status: "approved" | "rejected" | "changes_requested",
  note?: string,
): Promise<boolean> {
  const decision = await getDecision(companyId, decisionId);
  if (!decision) {
    await trySend(provider, phone, "gone", () =>
      provider.sendText(phone, "That proposal is no longer available."),
    );
    return false;
  }
  if (status === "changes_requested" && !note) {
    await upsertWhatsappUser({ phone, awaitingNoteFor: decisionId });
    await trySend(provider, phone, "ask-note", () =>
      provider.sendText(phone, "What should change?"),
    );
    return true;
  }
  await setDecisionStatus(companyId, decisionId, status, note);
  if (status === "approved") {
    try {
      const result = await applyDecision(companyId, decisionId);
      // File proposals (catalogue, flyer, video, statement): send the
      // approved file ready to forward or post.
      if (result.fileId) {
        const file = await getFile(result.fileId);
        if (file && file.company_id === companyId) {
          const caption = `${decision.title} — ready to forward or post.`;
          await trySend(provider, phone, "approved-file", () =>
            provider.sendMedia(phone, file.url, caption),
          );
        }
      }
    } catch (err) {
      console.error(
        `whatsapp/${provider.id} apply failed for ${decisionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (status === "changes_requested") {
    const result = await runTeam({
      companyId,
      channelId: "whatsapp",
      message: `The owner requested changes on "${decision.title}": ${note}`,
      source: "whatsapp",
    });
    await sendReplyWithProposals(provider, phone, result.reply, result.decisions);
    await drainVideos(companyId);
    return true;
  }
  await trySend(provider, phone, "decided", () =>
    provider.sendText(
      phone,
      status === "approved"
        ? `Approved: ${decision.title}. The team will build on it.`
        : `OK, rejected: ${decision.title}.`,
    ),
  );
  return true;
}

async function handleReply(
  provider: WhatsAppProvider,
  phone: string,
  replyId: string,
): Promise<void> {
  const sep = replyId.lastIndexOf(":");
  const decisionId = sep > 0 ? replyId.slice(0, sep) : "";
  const status = sep > 0 ? replyId.slice(sep + 1) : "";
  if (
    !decisionId ||
    (status !== "approved" &&
      status !== "rejected" &&
      status !== "changes_requested")
  ) {
    await trySend(provider, phone, "stale-button", () =>
      provider.sendText(phone, "Sorry, that button is no longer valid."),
    );
    return;
  }
  const user = await getWhatsappUser(phone);
  if (!user?.company_id) {
    await trySend(provider, phone, "no-team", () =>
      provider.sendText(
        phone,
        "Your team isn't set up on this number yet. Please send Hi to start.",
      ),
    );
    return;
  }
  await decideById(provider, phone, user.company_id, decisionId, status);
}

async function handleLetterCommand(
  provider: WhatsAppProvider,
  phone: string,
  companyId: string,
  body: string,
): Promise<boolean> {
  const pending = await listDecisions(companyId, "pending");
  const letters = await readLetters(phone);
  const parsed = parseLetterCommand(
    body,
    letters,
    pending.map((d) => d.decision_id),
  );
  if (!parsed) return false;
  if (parsed.action === "approveAll") {
    let approved = 0;
    for (const d of pending) {
      await setDecisionStatus(companyId, d.decision_id, "approved");
      try {
        await applyDecision(companyId, d.decision_id);
        approved++;
      } catch (err) {
        console.error(
          `whatsapp/${provider.id} apply failed for ${d.decision_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await trySend(provider, phone, "decided", () =>
      provider.sendText(
        phone,
        approved === 1
          ? `Approved: ${pending[0].title}. The team will build on it.`
          : `Approved ${approved} proposals. The team will build on them.`,
      ),
    );
    return true;
  }
  if (parsed.action === "change" && parsed.note) {
    await decideById(
      provider,
      phone,
      companyId,
      parsed.decisionId,
      "changes_requested",
      parsed.note,
    );
    return true;
  }
  if (parsed.action === "change") {
    await decideById(provider, phone, companyId, parsed.decisionId, "changes_requested");
    return true;
  }
  await decideById(
    provider,
    phone,
    companyId,
    parsed.decisionId,
    parsed.action === "approve" ? "approved" : "rejected",
  );
  return true;
}

async function handleOnboarding(
  provider: WhatsAppProvider,
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
        await trySend(provider, phone, "ask-name", () =>
          provider.sendText(phone, "What's your name?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_biz",
        onboardingData: { ...data, name: answer },
      });
      await trySend(provider, phone, "ask-biz", () =>
        provider.sendText(
          phone,
          `Nice to meet you, ${answer}! What's your business name?`,
        ),
      );
      return;
    }
    case "await_biz": {
      if (!answer) {
        await trySend(provider, phone, "ask-biz", () =>
          provider.sendText(phone, "What's your business name?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_sells",
        onboardingData: { ...data, biz: answer },
      });
      await trySend(provider, phone, "ask-sells", () =>
        provider.sendText(phone, "What do you sell or plan to build?"),
      );
      return;
    }
    case "await_sells": {
      if (!answer) {
        await trySend(provider, phone, "ask-sells", () =>
          provider.sendText(phone, "What do you sell or plan to build?"),
        );
        return;
      }
      await upsertWhatsappUser({
        phone,
        onboardingStep: "await_goal",
        onboardingData: { ...data, sells: answer },
      });
      await trySend(provider, phone, "ask-goal", () =>
        provider.sendText(phone, "What's your goal for the next 3 months?"),
      );
      return;
    }
    case "await_goal": {
      if (!answer) {
        await trySend(provider, phone, "ask-goal", () =>
          provider.sendText(phone, "What's your goal for the next 3 months?"),
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
      await trySend(provider, phone, "setting-up", () =>
        provider.sendText(phone, "Setting up your team — this takes about a minute."),
      );
      const kickoff = await runTeam({
        companyId: company.id,
        channelId: "whatsapp",
        message: "(New business signed up)",
        source: "whatsapp",
        isKickoff: true,
      });
      await sendReplyWithProposals(provider, phone, kickoff.reply, kickoff.decisions);
      await trySend(provider, phone, "dashboard", () =>
        provider.sendText(
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
      await trySend(provider, phone, "greeting", () =>
        provider.sendText(
          phone,
          "Hello! I'm your AI business team. First, what's your name?",
        ),
      );
      return;
    }
  }
}
