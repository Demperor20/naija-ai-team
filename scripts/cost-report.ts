// scripts/cost-report.ts — Meta API usage and estimated cost per business,
// from the model/duration/token counts logged into agent_runs.
// Run: npx tsx scripts/cost-report.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listAgentRunUsage, listCompanies } from "../lib/db";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

// USD per million tokens, standard tier, checked Oct 28 2026:
// Spark $1.25 in / $4.25 out, Wonder $4 in / $20 out (Meta Model API).
// Image, SAM and Transcribe have no published per-token price, so calls
// to models outside this table count tokens but add no cost.
const RATES: Array<{ match: string; inputPerM: number; outputPerM: number }> = [
  { match: "spark", inputPerM: 1.25, outputPerM: 4.25 },
  { match: "wonder", inputPerM: 4.0, outputPerM: 20.0 },
];

function rateFor(
  model: string,
  provider: string | null,
): { inputPerM: number; outputPerM: number } | null {
  // Baseten serves the open-weight model under its own pricing: never apply
  // Meta Model API rates to it (its id also contains "spark").
  if (provider === "baseten") return null;
  const lower = model.toLowerCase();
  for (const r of RATES) {
    if (lower.includes(r.match)) return r;
  }
  return null;
}

async function main(): Promise<void> {
  const companies = await listCompanies();
  console.log(`businesses: ${companies.length}`);
  let totalCalls = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let totalUnpriced = 0;
  let totalNoTokens = 0;
  for (const c of companies) {
    const rows = await listAgentRunUsage(c.id);
    const calls = rows.filter((r) => r.step === "think" || r.step === "final");
    let input = 0;
    let output = 0;
    let cost = 0;
    let unpriced = 0;
    let noTokens = 0;
    for (const r of calls) {
      if (r.inputTokens === null && r.outputTokens === null) {
        noTokens++;
        continue;
      }
      const i = r.inputTokens ?? 0;
      const o = r.outputTokens ?? 0;
      input += i;
      output += o;
      const rate = rateFor(r.model, r.provider);
      if (!rate) {
        unpriced++;
        continue;
      }
      cost += (i * rate.inputPerM + o * rate.outputPerM) / 1_000_000;
    }
    totalCalls += calls.length;
    totalIn += input;
    totalOut += output;
    totalCost += cost;
    totalUnpriced += unpriced;
    totalNoTokens += noTokens;
    console.log(
      `- ${c.name} (${c.id.slice(0, 8)}): ${calls.length} calls, ` +
        `${input.toLocaleString()} in / ${output.toLocaleString()} out tokens, ` +
        `est. $${cost.toFixed(4)}` +
        (unpriced > 0 ? ` (${unpriced} calls unpriced)` : "") +
        (noTokens > 0 ? ` (${noTokens} calls without token counts)` : ""),
    );
  }
  console.log(
    `TOTAL: ${totalCalls} calls, ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens, est. $${totalCost.toFixed(4)}`,
  );
  if (totalUnpriced > 0) {
    console.log(
      `note: ${totalUnpriced} calls used models outside the price table (no published per-token price).`,
    );
  }
  if (totalNoTokens > 0) {
    console.log(
      `note: ${totalNoTokens} calls logged no token counts (made before schema-v4.sql or by models that don't report usage). Run supabase/schema-v4.sql to log new calls.`,
    );
  }
}

main().catch((err) => {
  console.error("COST REPORT FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
