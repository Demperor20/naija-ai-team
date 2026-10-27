// scripts/books-smoke.ts — books/ledger end-to-end (AGENTS.md sections 12-13).
// Sends sales batches through runTeam for the Mama Nkechi Kitchen test
// company, approves every ledger proposal, then asks about the week and
// about debts. Keeps the company. Run: npx tsx scripts/books-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  createCompany,
  findCompaniesByName,
  getRecentMessages,
  listAgentRunsByMessage,
  listConfirmedLedgerEntries,
  setDecisionStatus,
} from "../lib/db";
import { applyDecision } from "../lib/decisions";
import { processMedia } from "../lib/media";
import { transcribe } from "../lib/meta";
import { runTeam, type DecisionDTO } from "../lib/agents/run";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

// Requested files, with transparent fallbacks when a fixture is missing.
const WANTED: Array<{ want: string; fallback: string }> = [
  { want: "notebook.jpg", fallback: "notebook.jpg" },
  { want: "receipt.jpg", fallback: "receipt1.jpg" },
  { want: "transfer.png", fallback: "receipt2.jpg" },
  { want: "voice-pidgin.m4a", fallback: "voice-english.m4a" },
];

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
};

function resolveFixture(want: string, fallback: string): string {
  if (existsSync(join(root, "test-media", want))) return want;
  console.log(`note: test-media/${want} missing, using ${fallback} instead`);
  return fallback;
}

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

async function main(): Promise<void> {
  // BOOKS_SMOKE_FRESH=1 starts a new company so reruns don't hit the
  // duplicate-batch check against already-confirmed entries.
  const existing =
    process.env.BOOKS_SMOKE_FRESH === "1"
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

  const ledgerIds: string[] = [];
  const collect = (decisions: DecisionDTO[]) => {
    for (const d of decisions) {
      console.log(`proposal: kind=${d.kind} | ${d.title}`);
      if (d.kind === "ledger") ledgerIds.push(d.decision_id);
    }
    if (decisions.length === 0) console.log("proposal: (none)");
  };

  // 1-3. Image batches through the books channel.
  for (const { want, fallback } of WANTED.slice(0, 3)) {
    const name = resolveFixture(want, fallback);
    const mime = MIME_BY_EXT[extname(name).toLowerCase()];
    const buffer = readFileSync(join(root, "test-media", name));
    console.log(`--- batch: ${name} ---`);
    const media = await processMedia({
      companyId: company.id,
      buffer,
      mime,
    });
    console.log(`media: ${media.kind} | category=${media.category ?? "-"}`);
    const result = await runTeam({
      companyId: company.id,
      channelId: "books",
      message: "Record these sales",
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
    console.log(`reply: ${result.reply.slice(0, 500)}`);
    collect(result.decisions);
  }

  // 4. Voice transcript through the books channel.
  const voiceName = resolveFixture(WANTED[3].want, WANTED[3].fallback);
  const voiceMime = MIME_BY_EXT[extname(voiceName).toLowerCase()];
  const voiceBuffer = readFileSync(join(root, "test-media", voiceName));
  console.log(`--- batch: ${voiceName} (transcript) ---`);
  const voice = await transcribe(voiceBuffer, voiceMime);
  console.log(`transcript (${voice.via}): ${voice.text}`);
  const voiceResult = await runTeam({
    companyId: company.id,
    channelId: "books",
    message: `Voice note transcript: "${voice.text}" — record these sales`,
    source: "tryit",
  });
  console.log(`reply: ${voiceResult.reply.slice(0, 500)}`);
  collect(voiceResult.decisions);

  // 5. Approve every ledger proposal (applies the entries).
  console.log(`--- approving ${ledgerIds.length} ledger proposals ---`);
  for (const id of ledgerIds) {
    await setDecisionStatus(company.id, id, "approved");
    const applied = await applyDecision(company.id, id);
    console.log(
      `approved ${id.slice(0, 8)}… applied=${applied.applied} inserted=${applied.inserted ?? 0}`,
    );
  }
  const confirmed = await listConfirmedLedgerEntries(company.id, 100);
  console.log(`confirmed entries in books: ${confirmed.length}`);

  // 6. Week summary + debts.
  for (const question of ["How did I do this week?", "Who owes me?"]) {
    const result = await runTeam({
      companyId: company.id,
      channelId: "books",
      message: question,
      source: "tryit",
    });
    console.log(`--- Q: ${question} ---`);
    console.log(result.reply);
    await showTrace(company.id, "books", "trace");
  }

  console.log(`kept company: ${company.id}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
