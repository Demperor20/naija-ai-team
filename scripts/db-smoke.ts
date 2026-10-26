// scripts/db-smoke.ts — smoke test for lib/db.ts.
// Run: npx tsx scripts/db-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createCompany,
  deleteCompany,
  getApprovedDecisions,
  getCompany,
  getCompanyByToken,
  getRecentMessages,
  hasWhatsappSeen,
  listDecisions,
  markWhatsappSeen,
  saveAgentRun,
  saveDecisions,
  saveMessage,
  setDecisionStatus,
} from "../lib/db";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}

function show(label: string, value: unknown): void {
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const tag = `Smoke ${Date.now()}`;
  const company = await createCompany({
    ownerName: "Smoke Owner",
    name: tag,
    oneLiner: "Smoke test business",
    description: "Temporary row, deleted at the end of the smoke test",
    goals: "Verify lib/db.ts",
    stage: "Idea",
  });
  show("created company", company);

  try {
    const readBack = await getCompany(company.id);
    assert(readBack?.name === tag, "getCompany reads the company back");

    const byToken = await getCompanyByToken(company.access_token);
    assert(byToken?.id === company.id, "getCompanyByToken finds it by token");

    const message = await saveMessage({
      companyId: company.id,
      channelId: "general",
      agentKey: "ceo",
      agentName: "AI Co-Founder / CEO",
      ownerMessage: "Hello team",
      reply: "Hello owner",
    });
    show("saved message", message);

    const [decision] = await saveDecisions({
      companyId: company.id,
      messageId: message.id,
      channelId: "general",
      decisions: [
        {
          title: "Smoke proposal",
          description: "A test proposal",
          category: "test",
          owner: "ceo",
          priority: "low",
        },
      ],
    });
    assert(decision?.status === "pending", "new decision starts as pending");
    show("saved decision", decision);

    const messages = await getRecentMessages(company.id, "general", 10);
    assert(
      messages.length === 1 && messages[0].id === message.id,
      "getRecentMessages returns the message",
    );

    const pending = await listDecisions(company.id, "pending");
    assert(pending.length === 1, "listDecisions finds 1 pending decision");

    const run = await saveAgentRun({
      companyId: company.id,
      messageId: message.id,
      agentKey: "ceo",
      model: "smoke-model",
      step: "final",
      detail: "smoke test run",
      ms: 12,
    });
    assert(run.step === "final", "saveAgentRun saves the trace row");

    const seenId = `smoke-${Date.now()}`;
    assert(!(await hasWhatsappSeen(seenId)), "unknown id is not seen");
    await markWhatsappSeen(seenId);
    assert(await hasWhatsappSeen(seenId), "marked id is seen");

    const approved = await setDecisionStatus(
      company.id,
      decision.decision_id,
      "approved",
    );
    assert(approved.status === "approved", "decision ends as approved");
    show("approved decision", approved);

    const approvedList = await getApprovedDecisions(company.id);
    assert(approvedList.length === 1, "getApprovedDecisions returns it");
  } finally {
    await deleteCompany(company.id);
    const gone = await getCompany(company.id);
    assert(gone === null, "test company is deleted");
  }

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
