// scripts/render-smoke.ts — offline render check for lib/images.ts.
// Renders one flyer and one catalogue from solid-colour backgrounds (no
// Meta API, no database) and asserts valid PNG output at the exact sizes
// the product needs. Catches missing/unreadable fonts, sharp breakage and
// text-layout crashes in the flyer/catalogue path.
// Run: npx tsx scripts/render-smoke.ts
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderCatalogue, renderFlyer } from "../lib/images";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(msg: string): never {
  throw new Error(msg);
}

function assertPng(buf: Buffer, label: string): void {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 10_000 || !buf.subarray(0, 8).equals(magic)) {
    fail(`${label}: not a plausible PNG (bytes=${buf.length}).`);
  }
}

async function main(): Promise<void> {
  const bg = await sharp({
    create: {
      width: 1280,
      height: 1920,
      channels: 3,
      background: "#7c2d12",
    },
  })
    .png()
    .toBuffer();

  const flyer = await renderFlyer({
    background: bg,
    words: {
      headline: "Weekend Zobo Promo",
      offer: "This Saturday only",
      price: "₦500 per cup",
      cta: "Chat us on WhatsApp",
      businessName: "Mama Nkechi Kitchen",
    },
  });
  assertPng(flyer, "flyer");
  const flyerMeta = await sharp(flyer).metadata();
  console.log(
    `flyer: bytes=${flyer.length} ${flyerMeta.width}x${flyerMeta.height}`,
  );
  if (flyerMeta.width !== 1080 || flyerMeta.height !== 1920) {
    fail(
      `flyer: expected 1080x1920, got ${flyerMeta.width}x${flyerMeta.height}.`,
    );
  }

  const cutout = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: "#f6f2e9",
    },
  })
    .png()
    .toBuffer();
  const catalogue = await renderCatalogue({
    businessName: "Mama Nkechi Kitchen",
    products: [
      { name: "Zobo", price: 500, cutout },
      { name: "Small chops", price: 2500, cutout },
    ],
  });
  assertPng(catalogue.png, "catalogue");
  const catMeta = await sharp(catalogue.png).metadata();
  console.log(
    `catalogue: bytes=${catalogue.png.length} ${catMeta.width}x${catMeta.height} included=${catalogue.included}/${catalogue.total}`,
  );
  if (catMeta.width !== 1080 || catMeta.height !== 1350) {
    fail(
      `catalogue: expected 1080x1350, got ${catMeta.width}x${catMeta.height}.`,
    );
  }
  if (catalogue.included !== 2) fail("catalogue: expected 2 products.");

  const outDir = join(root, "test-media", "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "render-flyer.png"), flyer);
  writeFileSync(join(outDir, "render-catalogue.png"), catalogue.png);
  console.log("saved: test-media/out/render-flyer.png");
  console.log("saved: test-media/out/render-catalogue.png");

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
