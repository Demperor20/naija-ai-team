// scripts/whatsapp-preview-smoke.ts — checks that Twilio proposal replies
// send file previews: one combined text plus one media message per
// preview, captioned with the matching proposal letter. Uses a recording
// fake provider; only the letter store touches the database.
// Run: npx tsx scripts/whatsapp-preview-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendReplyWithProposals } from "../lib/whatsapp/handle";
import { readLetters } from "../lib/whatsapp/twilio";
import type { WhatsAppProvider } from "../lib/whatsapp/types";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

function fail(msg: string): never {
  throw new Error(msg);
}

const FAKE_PHONE = "00000000000";

async function main(): Promise<void> {
  const texts: string[] = [];
  const media: Array<{ url: string; caption?: string }> = [];
  const fake: WhatsAppProvider = {
    id: "twilio",
    parseIncoming: () => Promise.reject(new Error("unused")),
    sendText: (to, text) => {
      void to;
      texts.push(text);
      return Promise.resolve();
    },
    sendMedia: (to, publicUrl, caption) => {
      void to;
      media.push({ url: publicUrl, caption });
      return Promise.resolve();
    },
    sendProposals: () => Promise.reject(new Error("unused")),
  };

  await sendReplyWithProposals(fake, FAKE_PHONE, "Your flyer draft is ready.", [
    {
      decision_id: "11111111-1111-1111-1111-111111111111",
      title: "Weekend Zobo Flyer",
      description: "1080x1920 promo flyer",
      previewUrl: "https://example.com/flyer.png",
    },
    {
      decision_id: "22222222-2222-2222-2222-222222222222",
      title: "Price list update",
      description: "Zobo ₦500 per cup",
      previewUrl: null,
    },
  ]);

  if (texts.length !== 1 || !texts[0].includes("Proposals:")) {
    fail(`expected one combined proposal text, got ${texts.length}.`);
  }
  if (!texts[0].includes("A. Weekend Zobo Flyer")) {
    fail("proposal text is missing letter A for the flyer.");
  }
  if (media.length !== 1) {
    fail(`expected 1 preview send, got ${media.length}.`);
  }
  if (media[0].url !== "https://example.com/flyer.png") {
    fail(`preview sent the wrong url: ${media[0].url}.`);
  }
  if (!media[0].caption?.startsWith("A. Weekend Zobo Flyer")) {
    fail(`preview caption misses the letter: ${media[0].caption}.`);
  }
  const letters = await readLetters(FAKE_PHONE);
  if (letters.A !== "11111111-1111-1111-1111-111111111111") {
    fail("letter map was not stored for the fake phone.");
  }
  console.log("text + 1 preview with letter caption; letters stored");
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
