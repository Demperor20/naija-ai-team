// scripts/team-smoke.ts — smoke test for lib/agents/run.ts.
// Run: npx tsx scripts/team-smoke.ts
// Keeps the test company (prints its id at the end).
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createCompany,
  getRecentMessages,
  listAgentRunsByMessage,
} from "../lib/db";
import { runTeam, type RunTeamResult } from "../lib/agents/run";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

function showResult(label: string, result: RunTeamResult): void {
  console.log(`--- ${label} ---`);
  console.log(`agent: ${result.agentName} (${result.agent})`);
  console.log("reply:");
  console.log(result.reply);
  console.log("decisions:");
  console.log(JSON.stringify(result.decisions, null, 2));
}

async function showTrace(
  companyId: string,
  channelId: string,
  label: string,
): Promise<void> {
  const [message] = await getRecentMessages(companyId, channelId, 1);
  if (!message) {
    console.log(`--- ${label}: no message found ---`);
    return;
  }
  const runs = await listAgentRunsByMessage(message.id);
  console.log(`--- ${label} (${runs.length} steps) ---`);
  for (const r of runs) {
    console.log(
      `${r.agent_key} | ${r.step} | ${r.model} | ${r.ms ?? "?"}ms | ${(r.detail ?? "").slice(0, 120)}`,
    );
  }
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

  const kickoff = await runTeam({
    companyId: company.id,
    channelId: "general",
    message: "Hi team, we just signed up!",
    source: "tryit",
    isKickoff: true,
  });
  showResult("kickoff", kickoff);
  await showTrace(company.id, "general", "kickoff trace");

  const sales = await runTeam({
    companyId: company.id,
    channelId: "sales",
    message: "How should I price small chops for parties?",
    source: "tryit",
  });
  showResult("sales", sales);
  await showTrace(company.id, "sales", "sales trace");

  console.log(`kept company: ${company.id}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
