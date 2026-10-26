// lib/meta.ts — the ONLY place in this project that calls the Meta Model API.
// Every AI call (chat, and later image/transcribe/segment) goes through here.
// Model IDs come from environment variables. The API key is never logged.

export interface MetaToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface MetaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Set on assistant turns that made tool calls (echoed back on the next round).
  toolCalls?: MetaToolCallRequest[];
  // Set on tool turns: the id of the call this result answers.
  toolCallId?: string;
}

export interface MetaTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatResult {
  text: string;
  toolCalls: MetaToolCallRequest[];
  raw: unknown;
  model: string;
  ms: number;
}

export interface ChatArgs {
  messages: MetaMessage[];
  tools?: MetaTool[];
  // JSON Schema for the whole response object; sent as a structured-output
  // json_schema response_format.
  jsonSchema?: Record<string, unknown>;
  // Enforce the schema strictly (no extra keys). Only set true with a
  // strict-compliant schema: every object sets additionalProperties false
  // and lists all its keys in required.
  strictJson?: boolean;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

function endpoint(): string {
  const base = process.env.META_API_BASE;
  if (!base) throw new Error("Missing META_API_BASE environment variable");
  if (base.endsWith("/chat/completions")) return base;
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function toWireMessage(m: MetaMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.role === "tool" && m.toolCallId) {
    out.tool_call_id = m.toolCallId;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) {
    return `Meta API auth failed (HTTP ${status}). Check META_API_KEY.`;
  }
  if (status === 404) {
    return `Meta API endpoint not found (HTTP 404). Check META_API_BASE.`;
  }
  if (status === 429) {
    return `Meta API rate limited (HTTP 429)${snippet ? `: ${snippet}` : ""}`;
  }
  return `Meta API request failed (HTTP ${status})${snippet ? `: ${snippet}` : ""}`;
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) throw new Error("Missing META_API_KEY environment variable");
  const model = args.model ?? process.env.META_TEXT_MODEL;
  if (!model) throw new Error("Missing META_TEXT_MODEL environment variable");
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = endpoint();

  const body: Record<string, unknown> = {
    model,
    messages: args.messages.map(toWireMessage),
  };
  if (args.tools?.length) body.tools = args.tools;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: args.strictJson ?? false,
        schema: args.jsonSchema,
      },
    };
  }

  const started = Date.now();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(errorMessage(res.status, await res.text()));
        continue; // retry
      }
      if (!res.ok) {
        throw new Error(errorMessage(res.status, await res.text()));
      }
      const raw = (await res.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }> | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const message = raw.choices?.[0]?.message ?? {};
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((p) => p?.type === "text" && p.text)
                .map((p) => p.text as string)
                .join("")
            : "";
      const toolCalls: MetaToolCallRequest[] = (
        message.tool_calls ?? []
      ).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "",
      }));
      return {
        text,
        toolCalls,
        raw,
        model:
          typeof raw.model === "string" && raw.model ? raw.model : model,
        ms: Date.now() - started,
      };
    } catch (err) {
      // Retry network errors and timeouts; rethrow API errors immediately.
      if (err instanceof Error && err.message.startsWith("Meta API ")) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Meta API request failed after retries");
}
