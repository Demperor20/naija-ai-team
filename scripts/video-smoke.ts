// scripts/video-smoke.ts — promo video end-to-end (AGENTS.md section 15).
// Runs test-media/shop.MOV through processMedia, asks Promotion for a
// promo video, drains the queued job, approves the video proposal, and
// saves a copy to test-media/out/promo.mp4, printing the job timings.
// Run: npx tsx scripts/video-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createCompany,
  findCompaniesByName,
  getFile,
  getMediaJob,
  getRecentMessages,
  listAgentRunsByMessage,
  listDecisions,
  setDecisionStatus,
} from "../lib/db";
import { applyDecision } from "../lib/decisions";
import { processMedia } from "../lib/media";
import { runTeam } from "../lib/agents/run";
import {
  drainCompanyVideoJobs,
  MAX_VIDEO_BYTES,
  probeVideo,
} from "../lib/video";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

function fail(msg: string): never {
  throw new Error(msg);
}

async function main(): Promise<void> {
  const existing =
    process.env.VIDEO_SMOKE_FRESH === "1"
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

  const shopVideo = readFileSync(join(root, "test-media", "shop.MOV"));
  console.log(`shop.MOV: ${shopVideo.length} bytes`);
  const processed = await processMedia({
    companyId: company.id,
    buffer: shopVideo,
    mime: "video/quicktime",
  });
  console.log(
    `media: file=${processed.fileId.slice(0, 8)} duration=${processed.durationSec ?? "?"}s ` +
      `highlights=${processed.highlights?.length ?? 0} ms=${processed.ms}`,
  );
  console.log(`description: ${processed.description.slice(0, 300)}`);

  const res = await runTeam({
    companyId: company.id,
    channelId: "marketing",
    message:
      "Make me a short promo video from this shop video for WhatsApp Status. " +
      "Use your best moments with captions.",
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
  console.log(`reply: ${res.reply.slice(0, 400)}`);

  const [message] = await getRecentMessages(company.id, "marketing", 1);
  if (message) {
    const runs = await listAgentRunsByMessage(message.id);
    console.log(`--- trace (${runs.length} steps) ---`);
    for (const r of runs) {
      console.log(
        `${r.agent_key} | ${r.step} | ${(r.detail ?? "").slice(0, 100)}`,
      );
    }
  }
  for (const d of res.decisions) {
    console.log(
      `proposal: kind=${d.kind} | ${d.title} | preview=${d.previewUrl ? "yes" : "no"}`,
    );
  }

  const tDrain = Date.now();
  const drained = await drainCompanyVideoJobs(company.id);
  console.log(`drained ${drained.length} job(s) in ${Date.now() - tDrain}ms`);
  if (drained.length === 0) {
    fail("no video job was queued (the agent never called make_video).");
  }
  for (const r of drained) {
    const job = await getMediaJob(r.jobId);
    const out = (job?.output ?? {}) as Record<string, unknown>;
    const timings = (out.timings ?? {}) as Record<string, unknown>;
    console.log(
      `job ${r.jobId.slice(0, 8)}: status=${r.status} ` +
        `download=${timings.downloadMs ?? "?"}ms render=${timings.renderMs ?? "?"}ms ` +
        `upload=${timings.uploadMs ?? "?"}ms total=${timings.totalMs ?? "?"}ms` +
        (r.error ? ` error=${r.error}` : ""),
    );
  }
  const done = drained.find((r) => r.status === "done");
  if (!done?.fileId || !done.decisionId) {
    fail("no video job finished successfully.");
  }

  const pending = await listDecisions(company.id, "pending");
  const proposal = pending.find((d) => d.decision_id === done.decisionId);
  if (!proposal || proposal.kind !== "video") {
    fail("finished job left no pending video proposal.");
  }
  console.log(
    `proposal: kind=video | ${proposal.title} | payload=${JSON.stringify(proposal.payload)}`,
  );

  await setDecisionStatus(company.id, proposal.decision_id, "approved");
  const applied = await applyDecision(company.id, proposal.decision_id);
  console.log(
    `approved video applied=${applied.applied} file=${applied.fileId?.slice(0, 8) ?? "-"}`,
  );
  if (!applied.applied || !applied.fileId) {
    fail("video proposal was not applied.");
  }
  const file = await getFile(applied.fileId);
  const meta = (file?.meta ?? {}) as Record<string, unknown>;
  console.log(`file kind=${file?.kind} approved=${meta.approved === true}`);
  if (file?.kind !== "marketing_video" || meta.approved !== true) {
    fail("video file was not marked approved.");
  }

  const dl = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) fail(`could not download video (HTTP ${dl.status}).`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const outDir = join(root, "test-media", "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "promo.mp4"), bytes);
  console.log("saved: test-media/out/promo.mp4");

  const probed = await probeVideo(bytes);
  console.log(
    `promo: ${probed.width}x${probed.height} ${probed.duration.toFixed(1)}s ` +
      `audio=${probed.hasAudio} bytes=${bytes.length}`,
  );
  if (bytes.length > MAX_VIDEO_BYTES) fail("promo.mp4 is over 16 MB.");
  if (probed.duration > 30.5) fail("promo.mp4 is over 30 s.");
  if (
    !(
      (probed.width === 1080 && probed.height === 1920) ||
      (probed.width === 720 && probed.height === 1280)
    )
  ) {
    fail(`promo.mp4 has the wrong size: ${probed.width}x${probed.height}.`);
  }

  console.log(`kept company: ${company.id}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
