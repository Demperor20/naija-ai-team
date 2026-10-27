// scripts/flyer-smoke.ts — flyer end-to-end (AGENTS.md section 14). Asks
// the design agent for a weekend promo flyer, approves the flyer proposal,
// and saves a copy to test-media/out/flyer.png.
// Run: npx tsx scripts/flyer-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createCompany,
  findCompaniesByName,
  getFile,
  getRecentMessages,
  listAgentRunsByMessage,
  setDecisionStatus,
} from "../lib/db";
import { applyDecision } from "../lib/decisions";
import { runTeam } from "../lib/agents/run";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

function fail(msg: string): never {
  throw new Error(msg);
}

async function main(): Promise<void> {
  const existing =
    process.env.FLYER_SMOKE_FRESH === "1"
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

  const res = await runTeam({
    companyId: company.id,
    channelId: "design",
    message:
      "Make me a weekend promo flyer for zobo and small chops. " +
      "Zobo is ₦500 per cup and small chops platters start at ₦2,500. " +
      "This Saturday only, chat us on WhatsApp to order.",
    source: "tryit",
  });
  console.log(`reply: ${res.reply.slice(0, 400)}`);

  const [message] = await getRecentMessages(company.id, "design", 1);
  if (message) {
    const runs = await listAgentRunsByMessage(message.id);
    console.log(`--- trace (${runs.length} steps) ---`);
    for (const r of runs) {
      console.log(
        `${r.agent_key} | ${r.step} | ${(r.detail ?? "").slice(0, 100)}`,
      );
    }
  }

  const flyers = res.decisions.filter((d) => d.kind === "flyer");
  for (const d of res.decisions) {
    console.log(
      `proposal: kind=${d.kind} | ${d.title} | preview=${d.previewUrl ? "yes" : "no"}`,
    );
  }
  if (flyers.length === 0) fail("no flyer proposal returned.");
  const fileId = (flyers[0].payload as Record<string, unknown> | null)
    ?.file_id;
  if (typeof fileId !== "string" || !fileId) {
    fail("flyer proposal has no file_id.");
  }

  await setDecisionStatus(company.id, flyers[0].decision_id, "approved");
  const applied = await applyDecision(company.id, flyers[0].decision_id);
  console.log(
    `approved flyer applied=${applied.applied} file=${applied.fileId?.slice(0, 8) ?? "-"}`,
  );
  if (!applied.applied || !applied.fileId) {
    fail("flyer proposal was not applied.");
  }
  const file = await getFile(applied.fileId);
  const meta = (file?.meta ?? {}) as Record<string, unknown>;
  console.log(`file kind=${file?.kind} approved=${meta.approved === true}`);
  if (file?.kind !== "flyer" || meta.approved !== true) {
    fail("flyer file was not marked approved.");
  }

  const dl = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  if (!dl.ok) fail(`could not download flyer (HTTP ${dl.status}).`);
  const outDir = join(root, "test-media", "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outDir + "/flyer.png", Buffer.from(await dl.arrayBuffer()));
  console.log("saved: test-media/out/flyer.png");

  console.log(`kept company: ${company.id}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
