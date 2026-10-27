// lib/agents/run.ts — runTeam(): the agent loop (AGENTS.md section 7).

import {
  chat,
  type MetaContentPart,
  type MetaMessage,
  type MetaToolCallRequest,
} from "../meta";
import {
  getApprovedDecisions,
  getCompany,
  getRecentMessages,
  listConfirmedLedgerEntries,
  saveAgentRun,
  saveDecisions,
  saveMessage,
  type Company,
  type Decision,
  type LedgerEntryRow,
} from "../db";
import { validateLedgerPayload } from "../decisions";
import { agentForChannel, getAgent, isAgentKey } from "./team";
import { loadSystemPrompt } from "./prompts";
import {
  buildContextBlock,
  buildDelegateContext,
  type ContextAttachment,
} from "./context";
import {
  getToolsFor,
  handleBooksSummary,
  handleWebSearch,
  handleWhoOwesMe,
} from "./tools";

export interface RunTeamInput {
  companyId: string;
  channelId: string;
  message: string;
  source: "tryit" | "whatsapp";
  isKickoff?: boolean;
  attachments?: ContextAttachment[];
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
  kind: string;
  payload: unknown;
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
          kind: {
            type: "string",
            enum: [
              "general",
              "ledger",
              "product",
              "flyer",
              "video",
              "catalogue",
              "statement",
            ],
          },
          payload: { type: "object" },
        },
        required: [
          "title",
          "description",
          "category",
          "owner",
          "priority",
          "kind",
          "payload",
        ],
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
  kind: string;
  payload: Record<string, unknown>;
}

const PROPOSAL_KINDS = [
  "general",
  "ledger",
  "product",
  "flyer",
  "video",
  "catalogue",
  "statement",
];

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
  ledgerRecent?: LedgerEntryRow[];
}

// Images over this size are described by text only (the full file stays in
// Storage and on the message row); smaller ones also go to the model.
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;

async function fetchImagePart(url: string): Promise<MetaContentPart | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_INLINE_IMAGE_BYTES) return null;
    const mime =
      res.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
    return {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
    };
  } catch {
    return null;
  }
}

// Server-side checks before saving ledger proposals (AGENTS.md section 13):
// invalid entries are dropped, everything else is flagged in the reply.
function gateLedgerProposals(
  reply: string,
  decisions: NormalizedProposal[],
): { reply: string; decisions: NormalizedProposal[] } {
  const kept: NormalizedProposal[] = [];
  const flags: string[] = [];
  for (const d of decisions) {
    if (d.kind !== "ledger") {
      kept.push(d);
      continue;
    }
    const validated = validateLedgerPayload(d.payload);
    if (validated.entries.length === 0) {
      flags.push(
        `“${d.title}”: I couldn't read any valid sales lines, so nothing was recorded.`,
      );
      continue;
    }
    for (const w of validated.warnings) {
      flags.push(`“${d.title}”: ${w}.`);
    }
    kept.push({
      ...d,
      payload: { ...d.payload, entries: validated.entries },
    });
  }
  // Always return `kept`: even with zero warnings the ledger payloads in
  // `kept` are the validated/normalized ones, never the raw model output.
  if (flags.length === 0) return { reply, decisions: kept };
  return {
    reply: `${reply}\n\n_Please double-check:_\n${flags.map((f) => `- ${f}`).join("\n")}`,
    decisions: kept,
  };
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
    kind: d.kind,
    payload: d.payload,
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
    const kind =
      typeof item.kind === "string" && PROPOSAL_KINDS.includes(item.kind)
        ? item.kind
        : "general";
    const payload =
      typeof item.payload === "object" &&
      item.payload !== null &&
      !Array.isArray(item.payload)
        ? (item.payload as Record<string, unknown>)
        : {};
    normalized.push({
      title: item.title.trim().slice(0, 200),
      description:
        typeof item.description === "string" ? item.description : "",
      category: typeof item.category === "string" ? item.category : "general",
      owner,
      priority,
      kind,
      payload,
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

  if (call.name === "books_summary" || call.name === "who_owes_me") {
    const args = parseToolArgs(call.arguments);
    if (!args) return fail(`could not parse ${call.name} arguments as JSON.`);
    try {
      const result =
        call.name === "books_summary"
          ? await handleBooksSummary(ctx.company.id, args)
          : await handleWhoOwesMe(ctx.company.id);
      return {
        text: short(JSON.stringify(result), 4000),
        steps: [
          {
            agentKey: parentAgentKey,
            model: parentModel,
            step: "tool",
            detail: short(
              call.name === "books_summary"
                ? `books_summary(${(args.period as string) ?? "week"})`
                : "who_owes_me()",
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

function withLedgerSection(
  agentKey: string,
  userContent: string | MetaContentPart[],
  entries: LedgerEntryRow[] | undefined,
): string | MetaContentPart[] {
  if (agentKey !== "books" || !entries?.length) return userContent;
  const lines = entries.map((e) => {
    const qty =
      e.quantity !== null && e.quantity !== undefined
        ? ` ×${e.quantity}`
        : "";
    const price =
      e.unit_price !== null && e.unit_price !== undefined
        ? ` @₦${Number(e.unit_price).toLocaleString("en-NG")}`
        : "";
    const who = e.counterparty ? ` (${e.counterparty})` : "";
    return `- ${e.entry_date} | ${e.kind} | ${e.item ?? "(no item)"}${qty}${price} = ₦${Number(e.amount).toLocaleString("en-NG")}${who}`;
  });
  const section = `\n\nRECENT CONFIRMED ENTRIES (for duplicate checks — do not record these again; flag possible duplicates):\n${lines.join("\n")}`;
  if (typeof userContent === "string") return userContent + section;
  return userContent.map((p) =>
    p.type === "text" ? { ...p, text: p.text + section } : p,
  );
}

async function runLoop(args: {
  agentKey: string;
  system: string;
  userContent: string | MetaContentPart[];
  ctx: LoopContext;
}): Promise<LoopResult> {
  const { agentKey, system, ctx } = args;
  const userContent = withLedgerSection(
    agentKey,
    args.userContent,
    ctx.ledgerRecent,
  );
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
        const gated = gateLedgerProposals(parsed.reply, parsed.decisions);
        reply = gated.reply;
        decisions = gated.decisions;
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
          const gated = gateLedgerProposals(reparsed.reply, reparsed.decisions);
          reply = gated.reply;
          decisions = gated.decisions;
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
  // The Books agent gets the last 30 confirmed entries for duplicate checks
  // (loaded for the CEO too, since it may delegate to Books).
  const ledgerRecent =
    agent.key === "books" || agent.key === "ceo"
      ? await listConfirmedLedgerEntries(input.companyId, 30)
      : undefined;
  const ctx: LoopContext = {
    company,
    approved,
    deadline,
    source: input.source,
    today,
    ledgerRecent,
  };
  // Image attachments go to the model itself, not just as descriptions.
  const imageParts: MetaContentPart[] = [];
  for (const a of input.attachments ?? []) {
    if (a.mime?.startsWith("image/") && a.url) {
      const part = await fetchImagePart(a.url);
      if (part) imageParts.push(part);
    }
  }
  const contextText = buildContextBlock({
    company,
    approvedDecisions: approved,
    recentMessages: recent,
    isKickoff: input.isKickoff ?? false,
    message: input.message,
    attachments: input.attachments,
  });
  const loop = await runLoop({
    agentKey: agent.key,
    system: systemPromptFor(agent.key, ctx),
    userContent:
      imageParts.length > 0
        ? [{ type: "text", text: contextText }, ...imageParts]
        : contextText,
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
