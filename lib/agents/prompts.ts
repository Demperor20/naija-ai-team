// lib/agents/prompts.ts — loads prompts/_shared.md + prompts/<key>.md with fs
// at runtime. next.config.ts outputFileTracingIncludes ships the prompts
// folder in the Vercel server bundle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cache = new Map<string, string>();

function candidatePaths(name: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "..", "..", "prompts", name),
    join(process.cwd(), "prompts", name),
  ];
}

function loadFile(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  for (const path of candidatePaths(name)) {
    try {
      // turbopackIgnore: prompts/ is shipped via outputFileTracingIncludes.
      const text = readFileSync(
        /*turbopackIgnore: true*/ path,
        "utf8",
      );
      cache.set(name, text);
      return text;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `prompts: cannot load ${name} (tried ${candidatePaths(name).join(", ")})`,
  );
}

export function loadSystemPrompt(agentKey: string): string {
  return `${loadFile("_shared.md")}\n\n${loadFile(`${agentKey}.md`)}`;
}
