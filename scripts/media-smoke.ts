// scripts/media-smoke.ts — runs every file in test-media/ through lib/media.ts.
// Run: npx tsx scripts/media-smoke.ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { createCompany, deleteCompany, getClient } from "../lib/db";
import { processMedia } from "../lib/media";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
config({ path: join(root, ".env.local") });

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

async function main(): Promise<void> {
  const dir = join(root, "test-media");
  const files = readdirSync(dir)
    .filter((f) => MIME_BY_EXT[extname(f).toLowerCase()] !== undefined)
    .sort();
  if (files.length === 0) throw new Error("no test media found");

  const company = await createCompany({
    ownerName: "Media Owner",
    name: `Media Smoke ${Date.now()}`,
    description: "Temporary, deleted at the end of the smoke test",
    goals: "Verify lib/media.ts",
    stage: "Idea",
  });
  const paths: string[] = [];
  try {
    for (const name of files) {
      const mime = MIME_BY_EXT[extname(name).toLowerCase()];
      const buffer = readFileSync(join(dir, name));
      console.log(`--- ${name} (${mime}, ${buffer.length} bytes) ---`);
      const started = Date.now();
      const m = await processMedia({ companyId: company.id, buffer, mime });
      paths.push(m.path);
      console.log(`kind: ${m.kind} | file: ${m.fileId} | total ms: ${Date.now() - started}`);
      if (m.category) console.log(`category: ${m.category}`);
      if (m.transcript) console.log(`transcript: ${m.transcript}`);
      if (m.products?.length) {
        console.log(
          `products: ${m.products.map((p) => `${p.name} @${p.seconds}s`).join("; ")}`,
        );
      }
      console.log(`description: ${m.description}`);
    }
  } finally {
    if (paths.length) {
      await getClient().storage.from("files").remove(paths);
    }
    await deleteCompany(company.id);
  }
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
