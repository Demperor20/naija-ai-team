// scripts/seed-demo.ts — builds the demo business for the dashboard.
// Creates a fresh "Mama Nkechi Kitchen" and fills it by running the REAL
// pipeline (no typed-in fake data): six sales batches over the last two
// weeks through Books, a catalogue, a flyer, a promo video and a monthly
// statement — approving each proposal like the owner would. Prints the
// dashboard link at the end. Run: npx tsx scripts/seed-demo.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  createCompany,
  getFile,
  getProduct,
  listConfirmedLedgerEntries,
  listDecisions,
  setDecisionStatus,
  setProductPrice,
} from "../lib/db";
import { applyDecision } from "../lib/decisions";
import { processMedia } from "../lib/media";
import { transcribe } from "../lib/meta";
import { runTeam, type DecisionDTO } from "../lib/agents/run";
import { drainCompanyVideoJobs } from "../lib/video";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
};

function fail(msg: string): never {
  throw new Error(msg);
}

// Past dates in Africa/Lagos, e.g. daysAgo(13) -> "2026-10-15".
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function monthLabelOf(day: string): string {
  const [y, m] = day.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  return `${name} ${y}`;
}

async function approveAll(
  companyId: string,
  decisions: DecisionDTO[],
  kind: string,
): Promise<number> {
  let applied = 0;
  for (const d of decisions) {
    if (d.kind !== kind) continue;
    await setDecisionStatus(companyId, d.decision_id, "approved");
    const result = await applyDecision(companyId, d.decision_id);
    console.log(
      `  approved ${d.kind} "${d.title.slice(0, 50)}" applied=${result.applied}`,
    );
    if (result.applied) applied++;
  }
  return applied;
}

async function main(): Promise<void> {
  const company = await createCompany({
    ownerName: "Nkechi",
    name: "Mama Nkechi Kitchen",
    oneLiner: "Jollof, small chops and zobo in Yaba, Lagos",
    description: "Sells jollof, small chops and zobo in Yaba, Lagos",
    targetCustomer: "office workers and party hosts",
    goals: "50 regular customers in 90 days",
    stage: "Running",
  });
  console.log(`company: ${company.id} (${company.name})`);

  // --- 1. Two weeks of sales through the real Books pipeline. ---
  const batches: Array<{ file: string; ago: number; note: string }> = [
    { file: "notebook.jpg", ago: 13, note: "notebook page" },
    { file: "receipt1.jpg", ago: 11, note: "receipt" },
    { file: "receipt2.jpg", ago: 9, note: "receipt" },
    { file: "voice-english.m4a", ago: 7, note: "voice note" },
    { file: "notebook.jpg", ago: 4, note: "second notebook page" },
    { file: "receipt1.jpg", ago: 2, note: "receipt" },
  ];
  for (const b of batches) {
    const day = daysAgo(b.ago);
    console.log(`--- batch: ${b.file} for ${day} ---`);
    const buffer = readFileSync(join(root, "test-media", b.file));
    const mime = MIME_BY_EXT[extname(b.file).toLowerCase()];
    if (b.file.endsWith(".m4a")) {
      const voice = await transcribe(buffer, mime);
      console.log(`  transcript (${voice.via}): ${voice.text.slice(0, 120)}`);
      const result = await runTeam({
        companyId: company.id,
        channelId: "books",
        message: `Voice note transcript: "${voice.text}" — record these sales for ${day}.`,
        source: "tryit",
      });
      console.log(`  reply: ${result.reply.slice(0, 200)}`);
      const n = await approveAll(company.id, result.decisions, "ledger");
      if (n === 0) console.log("  WARNING: no ledger proposal this batch.");
      continue;
    }
    const media = await processMedia({ companyId: company.id, buffer, mime });
    const result = await runTeam({
      companyId: company.id,
      channelId: "books",
      message: `Record these sales from my ${b.note} for ${day}.`,
      source: "tryit",
      attachments: [
        {
          kind: media.fileKind,
          url: media.url,
          fileId: media.fileId,
          mime: media.mime,
          description: media.description,
        },
      ],
    });
    console.log(`  reply: ${result.reply.slice(0, 200)}`);
    const n = await approveAll(company.id, result.decisions, "ledger");
    if (n === 0) console.log("  WARNING: no ledger proposal this batch.");
  }
  const confirmed = await listConfirmedLedgerEntries(company.id, 200);
  const dates = confirmed.map((e) => e.entry_date).sort();
  console.log(
    `confirmed entries: ${confirmed.length} (${dates[0] ?? "?"} to ${dates[dates.length - 1] ?? "?"})`,
  );
  if (confirmed.length === 0) fail("no confirmed entries; cannot seed demo.");

  // --- 2. Catalogue from the real Design pipeline. ---
  console.log("--- catalogue ---");
  const photos: Array<{ fileId: string; url: string }> = [];
  for (const name of ["product1.jpg", "product2.jpg"]) {
    const media = await processMedia({
      companyId: company.id,
      buffer: readFileSync(join(root, "test-media", name)),
      mime: "image/jpeg",
    });
    photos.push({ fileId: media.fileId, url: media.url });
  }
  const add = await runTeam({
    companyId: company.id,
    channelId: "design",
    message:
      "Add these two products to my catalogue. Photo 1 is brown leather brogue shoes; photo 2 is white sneakers. " +
      "Use the cutout tool on each photo now and propose them as new products; I will give you the prices after.",
    source: "tryit",
    attachments: photos.map((p, i) => ({
      kind: "photo" as const,
      url: p.url,
      fileId: p.fileId,
      mime: "image/jpeg",
      description: `Photo ${i + 1} for the catalogue`,
    })),
  });
  const productIds = add.decisions
    .filter((d) => d.kind === "product")
    .flatMap((d) => {
      const payload = d.payload as Record<string, unknown> | null;
      return Array.isArray(payload?.product_ids)
        ? (payload.product_ids as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
    });
  if (productIds.length === 0) fail("no products proposed.");
  const prices = [45000, 38000];
  for (let i = 0; i < productIds.length; i++) {
    await setProductPrice(company.id, productIds[i], prices[i] ?? 25000);
    const product = await getProduct(company.id, productIds[i]);
    console.log(`  price: ${product?.name} -> ₦${(prices[i] ?? 25000).toLocaleString("en-NG")}`);
  }
  const productsApplied = await approveAll(company.id, add.decisions, "product");
  if (productsApplied === 0) fail("product proposals were not applied.");
  const cat = await runTeam({
    companyId: company.id,
    channelId: "design",
    message: "Make my catalogue now. All products are approved with prices.",
    source: "tryit",
  });
  const catApplied = await approveAll(company.id, cat.decisions, "catalogue");
  if (catApplied === 0) fail("catalogue proposal was not applied.");
  console.log("  catalogue done");

  // --- 3. Flyer from the real Design pipeline. ---
  console.log("--- flyer ---");
  const flyer = await runTeam({
    companyId: company.id,
    channelId: "design",
    message:
      "Make me a weekend promo flyer for zobo and small chops. " +
      "Zobo is ₦500 per cup and small chops platters start at ₦2,500. " +
      "This Saturday only, chat us on WhatsApp to order.",
    source: "tryit",
  });
  const flyerApplied = await approveAll(company.id, flyer.decisions, "flyer");
  if (flyerApplied === 0) fail("flyer proposal was not applied.");
  console.log("  flyer done");

  // --- 4. Promo video from the real Promotion pipeline. ---
  console.log("--- video ---");
  const shopMedia = await processMedia({
    companyId: company.id,
    buffer: readFileSync(join(root, "test-media", "shop.MOV")),
    mime: "video/quicktime",
  });
  const promo = await runTeam({
    companyId: company.id,
    channelId: "marketing",
    message:
      "Make me a short promo video from this shop video for WhatsApp Status. " +
      "Use your best moments with captions.",
    source: "tryit",
    attachments: [
      {
        kind: shopMedia.fileKind,
        url: shopMedia.url,
        fileId: shopMedia.fileId,
        mime: shopMedia.mime,
        description: shopMedia.description,
      },
    ],
  });
  console.log(`  reply: ${promo.reply.slice(0, 120)}`);
  const drained = await drainCompanyVideoJobs(company.id);
  const videoDone = drained.some((r) => r.status === "done");
  if (!videoDone) fail("video job did not finish.");
  const pendingVideo = (await listDecisions(company.id, "pending")).find(
    (d) => d.kind === "video",
  );
  if (!pendingVideo) fail("no pending video proposal after the job.");
  await setDecisionStatus(company.id, pendingVideo.decision_id, "approved");
  const videoApplied = await applyDecision(company.id, pendingVideo.decision_id);
  console.log(`  video done applied=${videoApplied.applied}`);

  // --- 5. Monthly statement from the real Books pipeline. ---
  console.log("--- statement ---");
  const statementDay = daysAgo(7);
  const statementLabel = monthLabelOf(statementDay);
  const statement = await runTeam({
    companyId: company.id,
    channelId: "books",
    message: `Send my statement for ${statementLabel}.`,
    source: "tryit",
  });
  console.log(`  reply: ${statement.reply.slice(0, 200)}`);
  const statementApplied = await approveAll(
    company.id,
    statement.decisions,
    "statement",
  );
  if (statementApplied === 0) fail("statement proposal was not applied.");
  const statementFile = statement.decisions
    .map((d) => (d.payload as Record<string, unknown> | null)?.file_id)
    .find((v): v is string => typeof v === "string");
  if (statementFile) {
    const file = await getFile(statementFile);
    if (file) {
      const dl = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
      const pdf = Buffer.from(await dl.arrayBuffer());
      const doc = await PDFDocument.load(pdf);
      console.log(
        `  statement PDF: ${doc.getPageCount()} page(s), ${pdf.length} bytes`,
      );
    }
  }

  console.log(`dashboard: http://localhost:3000/d/${company.access_token}`);
  console.log("SEED OK");
}

main().catch((err) => {
  console.error("SEED FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
