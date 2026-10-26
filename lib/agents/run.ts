// lib/agents/run.ts — runTeam(): the agent loop (AGENTS.md section 7).

import { chat, type MetaMessage, type MetaToolCallRequest } from "../meta";
import {
  getApprovedDecisions,
  getCompany,
  getRecentMessages,
  saveAgentRun,
  saveDecisions,
  saveMessage,
  type Company,
  type Decision,
} from "../db";
import { agentForChannel, getAgent, isAgentKey } from "./team";
import { loadSystemPrompt } from "./prompts";
import { buildContextBlock, buildDelegateContext } from "./context";
import { getToolsFor, handleWebSearch } from "./tools";

export interface RunTeamInput {
  companyId: string;
  channelId: string;
  message: string;
  source: "tryit" | "whatsapp";
  isKickoff?: boolean;
  attachments?: Array<{ kind: string; url: string; mime?: string }>;
}

export interface DecisionDTO {
  decision_id: string;
  title: string;
  description: string;
  category: string | null;
  owner: string | null;
  priority: string | null;
  status: string;
  channel_id: string;
  owner_note: string | null;
  createdAt: string;
}

export interface RunTeamResult {
  ok: true;
  reply: string;
  agent: string;
  agentName: string;
  channelId: string;
  decisions: DecisionDTO[];
}

const RUN_BUDGET_MS = 280_000;
const CHAT_TIMEOUT_MS = 90_000;
const CEO_MAX_ROUNDS = 8;
const SPECIALIST_MAX_ROUNDS = 5;

const FINAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          owner: { type: "string" },
          priority: { type: "string" },
        },
        required: ["title", "description", "category", "owner", "priority"],
      },
    },
  },
  required: ["reply", "decisions"],
} as Record<string, unknown>;

interface NormalizedProposal {
  title: string;
  description: string;
  category: string;
  owner: string;
  priority: "high" | "medium" | "low";
}

interface StepRecord {
  agentKey: string;
  model: string;
  step: string;
  detail?: string;
  ms?: number;
}

interface LoopResult {
  reply: string;
  decisions: NormalizedProposal[];
  steps: StepRecord[];
  model: string;
}

interface LoopContext {
  company: Company;
  approved: Decision[];
  deadline: number;
  source: "tryit" | "whatsapp";
  today: string;
}

function short(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function decisionToDTO(d: Decision): DecisionDTO {
  return {
    decision_id: d.decision_id,
    title: d.title,
    description: d.description,
    category: d.category,
    owner: d.owner,
    priority: d.priority,
    status: d.status,
    channel_id: d.channel_id,
    owner_note: d.owner_note,
    createdAt: d.created_at,
  };
}

function systemPromptFor(agentKey: string, ctx: LoopContext): string {
  const source = ctx.source === "whatsapp" ? "whatsapp" : "web";
  return `${loadSystemPrompt(agentKey)}\n\nToday is ${ctx.today} (Africa/Lagos).\nSOURCE: ${source}`;
}

function tryParseFinal(
  text: string,
  agentKey: string,
): { reply: string; decisions: NormalizedProposal[] } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const { reply, decisions } = obj as {
    reply?: unknown;
    decisions?: unknown;
  };
  if (typeof reply !== "string" || !Array.isArray(decisions)) return null;
  const normalized: NormalizedProposal[] = [];
  for (const d of decisions) {
    if (typeof d !== "object" || d === null) continue;
    const item = d as Record<string, unknown>;
    if (typeof item.title !== "string" || !item.title.trim()) continue;
    const owner =
      typeof item.owner === "string" && isAgentKey(item.owner)
        ? item.owner
        : agentKey;
    const priority =
      item.priority === "high" ||
      item.priority === "medium" ||
      item.priority === "low"
        ? item.priority
        : "medium";
    normalized.push({
      title: item.title.trim().slice(0, 200),
      description:
        typeof item.description === "string" ? item.description : "",
      category: typeof item.category === "string" ? item.category : "general",
      owner,
      priority,
    });
  }
  return { reply, decisions: normalized };
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(raw || "{}");
    if (typeof obj === "object" && obj !== null) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function executeTool(
  call: MetaToolCallRequest,
  ctx: LoopContext,
  parentAgentKey: string,
  parentModel: string,
): Promise<{ text: string; steps: StepRecord[] }> {
  const started = Date.now();
  const fail = (detail: string): { text: string; steps: StepRecord[] } => ({
    text: `Error: ${detail}`,
    steps: [
      {
        agentKey: parentAgentKey,
        model: parentModel,
        step: "error",
        detail: short(`${call.name}: ${detail}`),
        ms: Date.now() - started,
      },
    ],
  });

  if (call.name === "web_search") {
    const args = parseToolArgs(call.arguments);
    if (!args) return fail("could not parse web_search arguments as JSON.");
    try {
      const result = await handleWebSearch(args);
      const text = short(JSON.stringify(result), 4000);
      const query = typeof args.query === "string" ? args.query : "";
      return {
        text,
        steps: [
          {
            agentKey: parentAgentKey,
            model: parentModel,
            step: "web_search",
            detail: short(`query: ${query}`),
            ms: Date.now() - started,
          },
        ],
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(`web_search failed: ${detail}`);
    }
  }

  if (call.name.startsWith("delegate_")) {
    const specialistKey = call.name.slice("delegate_".length);
    const specialist = getAgent(specialistKey);
    if (specialist.key !== specialistKey || specialistKey === "ceo") {
      return fail(`unknown specialist: ${specialistKey}.`);
    }
    const args = parseToolArgs(call.arguments);
    const brief = args && typeof args.brief === "string" ? args.brief.trim() : "";
    if (!brief) return fail(`${call.name} needs a brief string.`);
    try {
      const sub = await runLoop({
        agentKey: specialistKey,
        system: systemPromptFor(specialistKey, ctx),
        userContent: buildDelegateContext(ctx.company, ctx.approved, brief),
        ctx,
      });
      const text = short(
        JSON.stringify({ reply: sub.reply, decisions: sub.decisions }),
        6000,
      );
      return {
        text,
        steps: [
          ...sub.steps,
          {
            agentKey: parentAgentKey,
            model: sub.model,
            step: "delegate",
            detail: short(
              `${call.name}: ${sub.decisions.length} proposal(s)`,
            ),
            ms: Date.now() - started,
          },
        ],
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(`${call.name} failed: ${detail}`);
    }
  }

  return fail(`unknown tool: ${call.name}.`);
}

async function runLoop(args: {
  agentKey: string;
  system: string;
  userContent: string;
  ctx: LoopContext;
}): Promise<LoopResult> {
  const { agentKey, system, userContent, ctx } = args;
  const tools = getToolsFor(agentKey);
  const maxRounds =
    agentKey === "ceo" ? CEO_MAX_ROUNDS : SPECIALIST_MAX_ROUNDS;
  const messages: MetaMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
  const steps: StepRecord[] = [];
  let lastText = "";
  let lastModel = "";

  for (let round = 1; round <= maxRounds; round++) {
    if (Date.now() >= ctx.deadline) {
      steps.push({
        agentKey,
        model: lastModel,
        step: "error",
        detail: "run budget exceeded",
      });
      break;
    }
    const result = await chat({
      messages,
      tools,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    lastText = result.text;
    lastModel = result.model;
    if (result.toolCalls.length === 0) break;
    steps.push({
      agentKey,
      model: result.model,
      step: "think",
      detail: short(
        result.text
          ? `round ${round}: ${result.text}`
          : `round ${round}: ${result.toolCalls.length} tool call(s)`,
      ),
      ms: result.ms,
    });
    messages.push({
      role: "assistant",
      content: result.text,
      toolCalls: result.toolCalls,
    });
    const outcomes = await Promise.all(
      result.toolCalls.map((call) =>
        executeTool(call, ctx, agentKey, result.model),
      ),
    );
    result.toolCalls.forEach((call, i) => {
      steps.push(...outcomes[i].steps);
      messages.push({
        role: "tool",
        content: outcomes[i].text,
        toolCallId: call.id,
      });
    });
  }

  // Drop a trailing assistant turn with unanswered tool calls (max rounds or
  // deadline hit) so the final call is valid.
  while (
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    (messages[messages.length - 1].toolCalls?.length ?? 0) > 0
  ) {
    messages.pop();
  }

  // Final round: structured JSON.
  let reply = lastText;
  let decisions: NormalizedProposal[] = [];
  if (Date.now() < ctx.deadline) {
    const finalMessages: MetaMessage[] = [
      ...messages,
      { role: "user", content: "Return your final answer now." },
    ];
    try {
      const first = await chat({
        messages: finalMessages,
        jsonSchema: FINAL_JSON_SCHEMA,
        temperature: 0,
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      lastModel = first.model;
      steps.push({
        agentKey,
        model: first.model,
        step: "final",
        detail: short(first.text || "(empty)"),
        ms: first.ms,
      });
      const parsed = tryParseFinal(first.text, agentKey);
      if (parsed) {
        reply = parsed.reply;
        decisions = parsed.decisions;
      } else {
        const retry = await chat({
          messages: [
            ...finalMessages,
            { role: "assistant", content: first.text },
            {
              role: "user",
              content: "Return only valid JSON matching the schema.",
            },
          ],
          jsonSchema: FINAL_JSON_SCHEMA,
          temperature: 0,
          timeoutMs: CHAT_TIMEOUT_MS,
        });
        lastModel = retry.model;
        const reparsed = tryParseFinal(retry.text, agentKey);
        if (reparsed) {
          reply = reparsed.reply;
          decisions = reparsed.decisions;
        } else {
          steps.push({
            agentKey,
            model: retry.model,
            step: "error",
            detail: "final JSON parse failed twice; using raw text",
          });
          reply = retry.text || lastText;
          decisions = [];
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({
        agentKey,
        model: lastModel,
        step: "error",
        detail: short(`final round failed: ${detail}`),
      });
      reply = lastText;
      decisions = [];
    }
  }

  if (!reply) {
    reply =
      "Sorry, I couldn't prepare a proper reply. Please try again.";
  }
  return { reply, decisions, steps, model: lastModel };
}

export async function runTeam(input: RunTeamInput): Promise<RunTeamResult> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const company = await getCompany(input.companyId);
  if (!company) {
    throw new Error(`Company not found: ${input.companyId}`);
  }
  const [approved, recent] = await Promise.all([
    getApprovedDecisions(input.companyId),
    getRecentMessages(input.companyId, input.channelId, 10),
  ]);
  const agent = agentForChannel(input.channelId, input.isKickoff);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const ctx: LoopContext = {
    company,
    approved,
    deadline,
    source: input.source,
    today,
  };
  const loop = await runLoop({
    agentKey: agent.key,
    system: systemPromptFor(agent.key, ctx),
    userContent: buildContextBlock({
      company,
      approvedDecisions: approved,
      recentMessages: recent,
      isKickoff: input.isKickoff ?? false,
      message: input.message,
    }),
    ctx,
  });

  const message = await saveMessage({
    companyId: input.companyId,
    channelId: input.channelId,
    agentKey: agent.key,
    agentName: agent.displayName,
    ownerMessage: input.message,
    reply: loop.reply,
    source: input.source,
    attachments: input.attachments ?? [],
  });
  const savedDecisions = await saveDecisions({
    companyId: input.companyId,
    messageId: message.id,
    channelId: input.channelId,
    decisions: loop.decisions,
  });
  for (const s of loop.steps) {
    await saveAgentRun({
      companyId: input.companyId,
      messageId: message.id,
      agentKey: s.agentKey,
      model: s.model || "unknown",
      step: s.step,
      detail: s.detail,
      ms: s.ms,
    });
  }

  return {
    ok: true,
    reply: loop.reply,
    agent: agent.key,
    agentName: agent.displayName,
    channelId: input.channelId,
    decisions: savedDecisions.map(decisionToDTO),
  };
}
