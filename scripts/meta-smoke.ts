// scripts/meta-smoke.ts — smoke test for lib/meta.ts.
// Run: npx tsx scripts/meta-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chat } from "../lib/meta";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

async function main(): Promise<void> {
  // 1. Plain chat.
  const simple = await chat({
    messages: [
      {
        role: "user",
        content:
          "Reply with one short sentence: what is the capital of Nigeria?",
      },
    ],
  });
  console.log("--- 1. plain chat ---");
  console.log(`model: ${simple.model}`);
  console.log(`text: ${simple.text}`);
  console.log(`ms: ${simple.ms}`);
  if (!simple.text) throw new Error("plain chat returned empty text");

  // 2. Structured output.
  const structured = await chat({
    messages: [
      {
        role: "user",
        content:
          "Suggest one idea to grow a Lagos food business. Reply with the JSON object only.",
      },
    ],
    jsonSchema: {
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
            },
            required: ["title", "description"],
          },
        },
      },
      required: ["reply", "decisions"],
    },
  });
  console.log("--- 2. structured output ---");
  console.log(`ms: ${structured.ms}`);
  const parsed = JSON.parse(structured.text) as {
    reply: string;
    decisions: Array<{ title: string; description: string }>;
  };
  console.log(JSON.stringify(parsed, null, 2));
  if (typeof parsed.reply !== "string" || !Array.isArray(parsed.decisions)) {
    throw new Error("structured output did not match the schema");
  }

  // 3. Tool calling.
  const withTool = await chat({
    messages: [
      { role: "user", content: "What time is it right now? Use get_time." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Returns the current time.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  console.log("--- 3. tool calling ---");
  console.log(`ms: ${withTool.ms}`);
  console.log(JSON.stringify(withTool.toolCalls, null, 2));
  if (!withTool.toolCalls.some((c) => c.name === "get_time")) {
    throw new Error("model did not ask to call get_time");
  }

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
