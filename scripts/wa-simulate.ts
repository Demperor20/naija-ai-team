// scripts/wa-simulate.ts — end-to-end WhatsApp webhook simulator for both
// providers. Posts signed webhook payloads (text, media, button / "yes A")
// at a local dev server and verifies the results in the database.
// Run the server first with dry-run sends:
//   WHATSAPP_DRY_RUN=1 npm run dev
// Then: npx tsx scripts/wa-simulate.ts --provider meta|twilio
import { config } from "dotenv";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createCompany,
  deleteCompany,
  getDecision,
  getRecentMessages,
  hasWhatsappSeen,
  saveDecisions,
  upsertWhatsappUser,
} from "../lib/db";
import { storeLetters } from "../lib/whatsapp/twilio";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

const BASE = process.env.WA_SIM_URL ?? "http://localhost:3000";
const PHONES = { meta: "2348000000001", twilio: "2348000000002" } as const;

function fail(msg: string): never {
  throw new Error(msg);
}

async function pollFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 150_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const hit = await fn().catch(() => null);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) fail(`timed out waiting for ${label}.`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function metaSign(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

// Twilio's documented signature: base64 HMAC-SHA1 over the full URL plus
// every POST field (keys sorted) concatenated as key+value.
function twilioSign(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

async function setupCompany(phone: string) {
  const company = await createCompany({
    ownerName: "Sim Owner",
    name: "Sim Test Shop",
    oneLiner: "Throwaway company for the WhatsApp simulator",
    description: "Sells sim akara in sim Lagos",
    goals: "Survive the simulator",
    stage: "Running",
  });
  await upsertWhatsappUser({
    phone,
    companyId: company.id,
    onboardingStep: "done",
    onboardingData: {},
  });
  return company;
}

async function seedDecisions(companyId: string, messageId: string, titles: string[]) {
  const rows = await saveDecisions({
    companyId,
    messageId,
    channelId: "whatsapp",
    decisions: titles.map((title) => ({
      title,
      description: `Simulator-seeded proposal: ${title}.`,
      category: "general",
      owner: "ceo",
      priority: "medium" as const,
      kind: "general" as const,
      payload: {},
    })),
  });
  return rows;
}

// ---------------------------------------------------------------- Meta ---

function metaPayload(message: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: { messages: [message] } }] }],
  };
}

async function testMeta(): Promise<void> {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) fail("WHATSAPP_APP_SECRET is not set in .env.local.");
  const phone = PHONES.meta;
  const company = await setupCompany(phone);
  console.log(`company: ${company.id} (${company.name})`);
  try {
    // 1. Text message -> 200, seen, agent reply in DB.
    const text = `Hello team, simulator ping ${Date.now()}`;
    const id = `sim-meta-${randomUUID()}`;
    const raw = JSON.stringify(
      metaPayload({ id, from: phone, timestamp: "0", type: "text", text: { body: text } }),
    );
    const res = await fetch(`${BASE}/api/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": metaSign(secret, raw),
      },
      body: raw,
    });
    if (res.status !== 200) fail(`text webhook returned HTTP ${res.status}.`);
    console.log("meta text: HTTP 200");
    await pollFor("whatsapp_seen", async () =>
      (await hasWhatsappSeen(id)) ? true : null,
    );
    const row = await pollFor("agent reply", async () => {
      const recent = await getRecentMessages(company.id, "whatsapp", 5);
      return recent.find((m) => m.owner_message === text) ?? null;
    });
    if (!row.reply) fail("agent reply is empty.");
    console.log(`meta text: reply saved (${row.reply.slice(0, 80)}…)`);

    // 2. Bad signature -> 403.
    const bad = await fetch(`${BASE}/api/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=deadbeef",
      },
      body: raw,
    });
    if (bad.status !== 403) fail(`bad signature returned HTTP ${bad.status}, want 403.`);
    console.log("meta bad signature: HTTP 403");

    // 3. Button tap approves a pending proposal.
    const [seeded] = await seedDecisions(company.id, row.id, ["Sim proposal Alpha"]);
    const buttonId = `${seeded.decision_id}:approved`;
    const rawButton = JSON.stringify(
      metaPayload({
        id: `sim-meta-${randomUUID()}`,
        from: phone,
        timestamp: "0",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: buttonId, title: "Approve" },
        },
      }),
    );
    const btn = await fetch(`${BASE}/api/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": metaSign(secret, rawButton),
      },
      body: rawButton,
    });
    if (btn.status !== 200) fail(`button webhook returned HTTP ${btn.status}.`);
    await pollFor(
      "approval",
      async () => {
        const d = await getDecision(company.id, seeded.decision_id);
        return d && d.status === "approved" ? true : null;
      },
      60_000,
    );
    console.log("meta button: proposal approved");
  } finally {
    await deleteCompany(company.id);
    console.log("cleaned up test company");
  }
}

// --------------------------------------------------------------- Twilio ---

const TWILIO_TEST_IMAGE = "https://demo.twilio.com/owl.png";

async function twilioPost(
  params: Record<string, string>,
  signature: string,
): Promise<Response> {
  return fetch(`${BASE}/api/twilio`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function testTwilio(): Promise<void> {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) fail("TWILIO_AUTH_TOKEN is not set in .env.local.");
  const url = `${BASE}/api/twilio`;
  const phone = PHONES.twilio;
  const from = `whatsapp:+${phone}`;
  const company = await setupCompany(phone);
  console.log(`company: ${company.id} (${company.name})`);
  try {
    // 1. Text message -> TwiML, seen, agent reply in DB.
    const text = `Hello team, twilio ping ${Date.now()}`;
    const sid = `SMsim${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const textParams = {
      MessageSid: sid,
      From: from,
      To: "whatsapp:+14155238886",
      Body: text,
      NumMedia: "0",
    };
    const res = await twilioPost(textParams, twilioSign(token, url, textParams));
    const twiml = await res.text();
    if (res.status !== 200 || !twiml.includes("<Response")) {
      fail(`text webhook returned HTTP ${res.status}: ${twiml.slice(0, 120)}`);
    }
    console.log("twilio text: HTTP 200 + TwiML");
    await pollFor("whatsapp_seen", async () =>
      (await hasWhatsappSeen(sid)) ? true : null,
    );
    const row = await pollFor("agent reply", async () => {
      const recent = await getRecentMessages(company.id, "whatsapp", 5);
      return recent.find((m) => m.owner_message === text) ?? null;
    });
    if (!row.reply) fail("agent reply is empty.");
    console.log(`twilio text: reply saved (${row.reply.slice(0, 80)}…)`);

    // 2. Bad signature -> 403.
    const bad = await twilioPost(textParams, "bogus");
    if (bad.status !== 403) fail(`bad signature returned HTTP ${bad.status}, want 403.`);
    console.log("twilio bad signature: HTTP 403");

    // 3. Photo via public URL -> downloaded, described, answered.
    const mediaSid = `SMsim${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const mediaParams = {
      MessageSid: mediaSid,
      From: from,
      To: "whatsapp:+14155238886",
      Body: "",
      NumMedia: "1",
      MediaUrl0: TWILIO_TEST_IMAGE,
      MediaContentType0: "image/png",
    };
    const media = await twilioPost(mediaParams, twilioSign(token, url, mediaParams));
    if (media.status !== 200) fail(`media webhook returned HTTP ${media.status}.`);
    const photoRow = await pollFor("photo reply", async () => {
      const recent = await getRecentMessages(company.id, "whatsapp", 5);
      return recent.find((m) => m.owner_message === "(Sent a photo)") ?? null;
    });
    if (!photoRow.reply) fail("photo reply is empty.");
    console.log(`twilio media: reply saved (${photoRow.reply.slice(0, 80)}…)`);

    // 4. "yes A" approves, "no B" rejects.
    const seeded = await seedDecisions(company.id, row.id, [
      "Sim proposal Alpha",
      "Sim proposal Beta",
    ]);
    await storeLetters(phone, {
      A: seeded[0].decision_id,
      B: seeded[1].decision_id,
    });
    const yesParams = {
      MessageSid: `SMsim${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      From: from,
      To: "whatsapp:+14155238886",
      Body: "yes A",
      NumMedia: "0",
    };
    const yes = await twilioPost(yesParams, twilioSign(token, url, yesParams));
    if (yes.status !== 200) fail(`yes A webhook returned HTTP ${yes.status}.`);
    await pollFor(
      "yes A approval",
      async () => {
        const d = await getDecision(company.id, seeded[0].decision_id);
        return d && d.status === "approved" ? true : null;
      },
      60_000,
    );
    console.log("twilio yes A: proposal A approved");
    const noParams = {
      ...yesParams,
      MessageSid: `SMsim${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      Body: "no B",
    };
    const no = await twilioPost(noParams, twilioSign(token, url, noParams));
    if (no.status !== 200) fail(`no B webhook returned HTTP ${no.status}.`);
    await pollFor(
      "no B rejection",
      async () => {
        const d = await getDecision(company.id, seeded[1].decision_id);
        return d && d.status === "rejected" ? true : null;
      },
      60_000,
    );
    console.log("twilio no B: proposal B rejected");
  } finally {
    await deleteCompany(company.id);
    console.log("cleaned up test company");
  }
}

async function main(): Promise<void> {
  const eq = process.argv.find((a) => a.startsWith("--provider="));
  let provider = eq ? (eq.split("=")[1] ?? "") : "";
  if (!provider) {
    const i = process.argv.indexOf("--provider");
    if (i >= 0) provider = process.argv[i + 1] ?? "";
  }
  if (provider !== "meta" && provider !== "twilio") {
    fail("usage: npx tsx scripts/wa-simulate.ts --provider meta|twilio");
  }
  try {
    const probe = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10_000) });
    await probe.arrayBuffer().catch(() => null);
  } catch {
    fail(`no server at ${BASE} — start it first: WHATSAPP_DRY_RUN=1 npm run dev`);
  }
  console.log(`provider: ${provider} (${BASE})`);
  if (provider === "meta") {
    await testMeta();
  } else {
    await testTwilio();
  }
  console.log("SIMULATE OK");
}

main().catch((err) => {
  console.error("SIMULATE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
