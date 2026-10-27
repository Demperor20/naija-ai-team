// scripts/catalogue-smoke.ts — cutout/products/catalogue end-to-end
// (AGENTS.md section 14). Runs product1.jpg and product2.jpg through the
// design agent (make_cutout), sets prices, approves the product proposal,
// makes the catalogue (make_catalogue), approves it and saves a copy to
// test-media/out/catalogue.png. Run: npx tsx scripts/catalogue-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createCompany,
  findCompaniesByName,
  getFile,
  getProduct,
  getRecentMessages,
  listAgentRunsByMessage,
  listApprovedProducts,
  setDecisionStatus,
  setProductPrice,
} from "../lib/db";
import { applyDecision } from "../lib/decisions";
import { processMedia } from "../lib/media";
import { runTeam, type DecisionDTO } from "../lib/agents/run";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

async function showTrace(
  companyId: string,
  channelId: string,
  label: string,
): Promise<void> {
  const [message] = await getRecentMessages(companyId, channelId, 1);
  if (!message) return;
  const runs = await listAgentRunsByMessage(message.id);
  console.log(`--- ${label} (${runs.length} steps) ---`);
  for (const r of runs) {
    console.log(
      `${r.agent_key} | ${r.step} | ${(r.detail ?? "").slice(0, 100)}`,
    );
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function main(): Promise<void> {
  const existing =
    process.env.CATALOGUE_SMOKE_FRESH === "1"
      ? []
      : await findCompaniesByName("Mama Nkechi Kitchen");
  const company =
    existing[0] ??
    (await createCompany({
      ownerName: "Nkechi",
      name: "Mama Nkechi Kitchen",
      oneLiner: "Jollof, small chops and zobo in Yaba, Lagos",
      description: "Sells jollof, small chops and zobo in Yaba, Lagos",
      targetCustomer: "office workers and party hosts",
      goals: "50 regular customers in 90 days",
      stage: "Running",
    }));
  console.log(`company: ${company.id} (${company.name})`);

  // 1. Upload the two product photos.
  const photos: Array<{ fileId: string; url: string }> = [];
  for (const name of ["product1.jpg", "product2.jpg"]) {
    const path = join(root, "test-media", name);
    if (!existsSync(path)) fail(`missing fixture: test-media/${name}`);
    const media = await processMedia({
      companyId: company.id,
      buffer: readFileSync(path),
      mime: "image/jpeg",
    });
    console.log(
      `upload: ${name} -> file ${media.fileId.slice(0, 8)}… category=${media.category ?? "-"}`,
    );
    photos.push({ fileId: media.fileId, url: media.url });
  }

  // 2. Design agent cuts out both products and proposes them.
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
  console.log(`reply: ${add.reply.slice(0, 400)}`);
  await showTrace(company.id, "design", "add-products trace");
  const productProposals = add.decisions.filter((d) => d.kind === "product");
  for (const d of add.decisions) {
    console.log(`proposal: kind=${d.kind} | ${d.title}`);
  }
  if (productProposals.length === 0) {
    fail("design agent returned no product proposal.");
  }
  const productIds = productProposals.flatMap((d) => {
    const payload = d.payload as Record<string, unknown> | null;
    return Array.isArray(payload?.product_ids)
      ? (payload.product_ids as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
  });
  console.log(`product ids: ${productIds.join(", ") || "(none)"}`);
  if (productIds.length === 0) fail("product proposal has no product_ids.");

  // 3. Owner sets prices, then approves.
  const prices = [45000, 38000];
  for (let i = 0; i < productIds.length; i++) {
    const product = await getProduct(company.id, productIds[i]);
    const price = prices[i] ?? 25000;
    await setProductPrice(company.id, productIds[i], price);
    console.log(
      `price: ${product?.name ?? productIds[i]} -> ₦${price.toLocaleString("en-NG")} (cutout: ${product?.cutout_file_id ? "yes" : "NO"})`,
    );
    if (!product?.cutout_file_id) fail("product has no cutout.");
  }
  for (const d of productProposals) {
    await setDecisionStatus(company.id, d.decision_id, "approved");
    const applied = await applyDecision(company.id, d.decision_id);
    console.log(
      `approved ${d.decision_id.slice(0, 8)}… applied=${applied.applied} inserted=${applied.inserted ?? 0}`,
    );
    if (!applied.applied) fail("product proposal was not applied.");
  }
  const approved = await listApprovedProducts(company.id);
  console.log(
    `approved products: ${approved.map((p) => `${p.name} ₦${Number(p.price).toLocaleString("en-NG")}`).join(" | ")}`,
  );

  // 4. Design agent makes the catalogue; owner approves it.
  const cat = await runTeam({
    companyId: company.id,
    channelId: "design",
    message:
      "Make my catalogue now. All products are approved with prices.",
    source: "tryit",
  });
  console.log(`reply: ${cat.reply.slice(0, 400)}`);
  await showTrace(company.id, "design", "catalogue trace");
  const catProposals = cat.decisions.filter((d) => d.kind === "catalogue");
  for (const d of cat.decisions) {
    console.log(
      `proposal: kind=${d.kind} | ${d.title} | preview=${d.previewUrl ? "yes" : "no"}`,
    );
  }
  if (catProposals.length === 0) fail("no catalogue proposal returned.");
  const catFileId = (
    catProposals[0].payload as Record<string, unknown> | null
  )?.file_id;
  if (typeof catFileId !== "string" || !catFileId) {
    fail("catalogue proposal has no file_id.");
  }
  await setDecisionStatus(company.id, catProposals[0].decision_id, "approved");
  const catApplied = await applyDecision(
    company.id,
    catProposals[0].decision_id,
  );
  console.log(
    `approved catalogue applied=${catApplied.applied} file=${catApplied.fileId?.slice(0, 8) ?? "-"}`,
  );
  if (!catApplied.applied || !catApplied.fileId) {
    fail("catalogue proposal was not applied.");
  }
  const file = await getFile(catApplied.fileId);
  const meta = (file?.meta ?? {}) as Record<string, unknown>;
  console.log(`file kind=${file?.kind} approved=${meta.approved === true}`);
  if (file?.kind !== "catalogue" || meta.approved !== true) {
    fail("catalogue file was not marked approved.");
  }

  // 5. Save a local copy.
  const res = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail(`could not download catalogue (HTTP ${res.status}).`);
  const outDir = join(root, "test-media", "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "catalogue.png");
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log(`saved: test-media/out/catalogue.png`);

  console.log(`kept company: ${company.id}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
