// lib/agents/context.ts — builds the context block for each run.

import type { Company, Decision, Message } from "../db";

export interface ContextInput {
  company: Company;
  approvedDecisions: Decision[];
  recentMessages: Message[]; // oldest first
  isKickoff: boolean;
  message: string;
}

function profileLines(company: Company): string[] {
  const lines = [
    "COMPANY PROFILE",
    `Business: ${company.name}`,
    `Owner: ${company.owner_name}`,
  ];
  if (company.one_liner) lines.push(`One-liner: ${company.one_liner}`);
  if (company.description) lines.push(`Description: ${company.description}`);
  lines.push(`Target customer: ${company.target_customer || "(not given)"}`);
  if (company.goals) lines.push(`Goals: ${company.goals}`);
  lines.push(`Stage: ${company.stage}`);
  return lines;
}

function approvedLines(approved: Decision[]): string[] {
  const lines = ["APPROVED DECISIONS"];
  if (approved.length === 0) {
    lines.push("None yet.");
    return lines;
  }
  approved.forEach((d, i) => {
    const note = d.owner_note ? ` (Owner note: ${d.owner_note})` : "";
    lines.push(`${i + 1}. ${d.title} — ${d.description}${note}`);
  });
  return lines;
}

export function buildContextBlock(input: ContextInput): string {
  const lines: string[] = [...profileLines(input.company), ""];
  lines.push(...approvedLines(input.approvedDecisions), "");
  lines.push("RECENT CONVERSATION");
  if (input.recentMessages.length === 0) {
    lines.push("No previous messages in this channel.");
  } else {
    for (const m of input.recentMessages) {
      if (m.owner_message) lines.push(`Owner: ${m.owner_message}`);
      lines.push(`${m.agent_name}: ${m.reply}`);
    }
  }
  lines.push("");
  if (input.isKickoff) {
    const c = input.company;
    lines.push("NEW COMPANY CREATED — this is the kickoff. Intake answers:");
    lines.push(`Owner name: ${c.owner_name}`);
    lines.push(`Business name: ${c.name}`);
    lines.push(`What they sell or plan to build: ${c.description || c.one_liner || "(not given)"}`);
    lines.push(`Target customer: ${c.target_customer || "(not given)"}`);
    lines.push(`Goals: ${c.goals || "(not given)"}`);
    lines.push(`Stage: ${c.stage}`);
  } else {
    lines.push("OWNER MESSAGE");
    lines.push(input.message);
  }
  return lines.join("\n");
}

// Shorter context for a delegate_* sub-run: the brief carries the task,
// so the recent conversation is left out.
export function buildDelegateContext(
  company: Company,
  approvedDecisions: Decision[],
  brief: string,
): string {
  const lines: string[] = [...profileLines(company), ""];
  lines.push(...approvedLines(approvedDecisions), "");
  lines.push("TASK BRIEF FROM THE CEO");
  lines.push(brief);
  return lines.join("\n");
}
