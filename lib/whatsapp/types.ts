// lib/whatsapp/types.ts — the common provider interface. Meta (Cloud API)
// and Twilio (Sandbox) both speak this shape so lib/whatsapp/handle.ts runs
// exactly the same flow for either one.

export type ProviderId = "meta" | "twilio";

export type IncomingType = "text" | "audio" | "image" | "video" | "reply";

export interface IncomingMedia {
  fetch(): Promise<{ buffer: Buffer; mime: string }>;
}

export interface IncomingMessage {
  from: string; // digits only, e.g. 2348031234567
  messageId: string; // provider id, used for duplicate detection
  type: IncomingType;
  text: string; // body for text; "" otherwise
  caption?: string; // media caption, if any
  replyId?: string; // type=reply: provider payload (Meta "<decisionId>:<status>")
  media?: IncomingMedia;
}

export interface ProposalSummary {
  decision_id: string;
  title: string;
  description: string;
}

export interface WhatsAppProvider {
  id: ProviderId;
  // Parse and authenticate one webhook request. Throws ProviderHttpError
  // (status 403) when the provider signature is invalid.
  parseIncoming(request: Request): Promise<IncomingMessage[]>;
  sendText(to: string, text: string): Promise<void>;
  // Send an image, video or PDF that already has a public URL.
  sendMedia(to: string, publicUrl: string, caption?: string): Promise<void>;
  // Present proposals for approval (Meta: buttons, Twilio: letters).
  sendProposals(to: string, decisions: ProposalSummary[]): Promise<void>;
}

export class ProviderHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isProviderId(value: string): value is ProviderId {
  return value === "meta" || value === "twilio";
}
