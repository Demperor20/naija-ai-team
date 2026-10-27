// lib/images.ts — sharp-powered image work (AGENTS.md section 14).
// Cutouts from SAM masks and the product catalogue grid. All text drawn on
// images uses the embedded Work Sans / Anton TTFs in assets/fonts/ (glyph
// outlines via opentype.js, so no system fonts are needed on Vercel).

import sharp, { type OverlayOptions } from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as opentype from "opentype.js";
import type { SegmentInstance } from "./meta";

// --- Brand -----------------------------------------------------------------

export interface BrandColours {
  background: string; // page / cutout backdrop
  card: string; // product card
  ink: string; // headings and prices
  body: string; // secondary text
  accent: string; // rules and small highlights
}

export const DEFAULT_BRAND: BrandColours = {
  background: "#f6f2e9",
  card: "#ffffff",
  ink: "#1c1917",
  body: "#57534e",
  accent: "#14532d",
};

// --- Embedded fonts ----------------------------------------------------------

const fontCache = new Map<string, opentype.Font>();

function fontCandidates(name: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "..", "assets", "fonts", name),
    join(process.cwd(), "assets", "fonts", name),
  ];
}

function loadFont(file: string): opentype.Font {
  const hit = fontCache.get(file);
  if (hit) return hit;
  for (const path of fontCandidates(file)) {
    try {
      // turbopackIgnore: assets/fonts is shipped via outputFileTracingIncludes.
      const font = opentype.parse(
        readFileSync(/*turbopackIgnore: true*/ path),
      );
      fontCache.set(file, font);
      return font;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `images: cannot load font ${file} (tried ${fontCandidates(file).join(", ")})`,
  );
}

const anton = (): opentype.Font => loadFont("Anton-Regular.ttf");
const workSans = (): opentype.Font => loadFont("WorkSans-Variable.ttf");

function naira(n: number): string {
  return `₦${n.toLocaleString("en-NG")}`;
}

// sharp's flatten() ignores string colours; give it {r, g, b}.
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 246, g: 242, b: 233 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

// One line of text as an SVG path element, horizontally centred on cx with
// the given baseline. Faux-bold via a thin same-colour stroke.
function textPath(
  font: opentype.Font,
  text: string,
  cx: number,
  baseline: number,
  fontSize: number,
  fill: string,
  bold = false,
): string {
  const width = font.getAdvanceWidth(text, fontSize, { kerning: true });
  const path = font.getPath(text, cx - width / 2, baseline, fontSize, {
    kerning: true,
  });
  const stroke = bold
    ? ` stroke="${fill}" stroke-width="${(fontSize * 0.028).toFixed(1)}"`
    : "";
  return `<path d="${pathToSvgData(path)}" fill="${fill}"${stroke}/>`;
}

function round2(v: number): number {
  if (!Number.isFinite(v)) {
    throw new Error("images: non-finite glyph coordinate.");
  }
  return Math.round(v * 100) / 100;
}

// Own path serializer. opentype.js toPathData() is unusable here: it flips Y
// by default, and its rounder turns float-dust remainders (1e-14) into NaN
// via string exponent concatenation ("1e-14e+2"), which silently kills the
// rest of the path in the renderer.
function pathToSvgData(path: opentype.Path): string {
  let d = "";
  for (const cmd of path.commands) {
    if (cmd.type === "M") {
      d += `M${round2(cmd.x as number)} ${round2(cmd.y as number)}`;
    } else if (cmd.type === "L") {
      d += `L${round2(cmd.x as number)} ${round2(cmd.y as number)}`;
    } else if (cmd.type === "Q") {
      d += `Q${round2(cmd.x1 as number)} ${round2(cmd.y1 as number)} ${round2(cmd.x as number)} ${round2(cmd.y as number)}`;
    } else if (cmd.type === "C") {
      d += `C${round2(cmd.x1 as number)} ${round2(cmd.y1 as number)} ${round2(cmd.x2 as number)} ${round2(cmd.y2 as number)} ${round2(cmd.x as number)} ${round2(cmd.y as number)}`;
    } else if (cmd.type === "Z") {
      d += "Z";
    }
  }
  return d;
}

function fitText(
  font: opentype.Font,
  text: string,
  fontSize: number,
  maxWidth: number,
): string {
  if (font.getAdvanceWidth(text, fontSize, { kerning: true }) <= maxWidth) {
    return text;
  }
  let clipped = text;
  while (
    clipped.length > 1 &&
    font.getAdvanceWidth(`${clipped}…`, fontSize, { kerning: true }) > maxWidth
  ) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

// --- Segmentation input ------------------------------------------------------

export async function resizeForSegment(
  buffer: Buffer,
  maxSide = 1024,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer)
    .resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

// --- Cutout ------------------------------------------------------------------

export interface ApplyMaskArgs {
  photo: Buffer;
  instance: SegmentInstance;
  background?: string;
}

// Cuts the product out of the photo with the SAM mask and places it on a
// clean background in the brand colour, with a soft shadow. Returns PNG.
export async function applyMask(args: ApplyMaskArgs): Promise<Buffer> {
  const { instance } = args;
  const background = args.background ?? DEFAULT_BRAND.background;
  // Cap the working size so cutouts stay small enough to store and send.
  const photo = await sharp(args.photo)
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();
  const meta = await sharp(photo).metadata();
  const photoWidth = meta.width ?? instance.sentWidth;
  const photoHeight = meta.height ?? instance.sentHeight;
  const scale = photoWidth / instance.sentWidth;
  const boxX = Math.round(instance.box.x1 * scale);
  const boxY = Math.round(instance.box.y1 * scale);
  const boxW = Math.max(
    1,
    Math.round((instance.box.x2 - instance.box.x1) * scale),
  );
  const boxH = Math.max(
    1,
    Math.round((instance.box.y2 - instance.box.y1) * scale),
  );

  // Mask (0/1) -> full-photo alpha channel at the box offset, feathered.
  const maskBytes = new Uint8Array(
    instance.maskWidth * instance.maskHeight,
  );
  for (let i = 0; i < maskBytes.length; i++) {
    maskBytes[i] = instance.mask[i] ? 255 : 0;
  }
  const feather = Math.max(1, Math.round(photoWidth / 800));
  const boxMask = await sharp(Buffer.from(maskBytes), {
    raw: {
      width: instance.maskWidth,
      height: instance.maskHeight,
      channels: 1,
    },
  })
    .resize(boxW, boxH, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  // sharp `create` needs 3-4 channels, so stamp the box mask onto a
  // full-photo black canvas in JS, then feather with a blur.
  const canvas = Buffer.alloc(photoWidth * photoHeight, 0);
  for (let y = 0; y < boxH; y++) {
    const dy = boxY + y;
    if (dy < 0 || dy >= photoHeight) continue;
    for (let x = 0; x < boxW; x++) {
      const dx = boxX + x;
      if (dx < 0 || dx >= photoWidth) continue;
      canvas[dy * photoWidth + dx] = boxMask[y * boxW + x];
    }
  }
  const fullAlpha = await sharp(canvas, {
    raw: { width: photoWidth, height: photoHeight, channels: 1 },
  })
    .blur(feather)
    .greyscale()
    .raw()
    .toBuffer();

  // Materialize removeAlpha first: removeAlpha + joinChannel in one
  // pipeline silently drops the joined channel.
  const rgb = await sharp(photo).removeAlpha().toBuffer();
  const cutout = await sharp(rgb)
    .joinChannel(fullAlpha, {
      raw: { width: photoWidth, height: photoHeight, channels: 1 },
    })
    .png()
    .toBuffer();

  // Soft shadow: blurred silhouette on black, offset down. Opacity is
  // baked into the alpha (sharp 0.35 dropped the composite opacity option).
  const shadowSigma = Math.min(15, Math.max(3, feather * 4));
  const shadowAlpha = await sharp(fullAlpha, {
    raw: { width: photoWidth, height: photoHeight, channels: 1 },
  })
    .blur(shadowSigma)
    .greyscale()
    .raw()
    .toBuffer();
  for (let i = 0; i < shadowAlpha.length; i++) {
    shadowAlpha[i] = Math.round(shadowAlpha[i] * 0.32);
  }
  const shadow = await sharp({
    create: {
      width: photoWidth,
      height: photoHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .joinChannel(shadowAlpha, {
      raw: { width: photoWidth, height: photoHeight, channels: 1 },
    })
    .png()
    .toBuffer();

  const drop = Math.round(photoHeight * 0.015);
  return sharp({
    create: {
      width: photoWidth,
      height: photoHeight,
      channels: 3,
      background,
    },
  })
    .composite([
      { input: shadow, left: 0, top: drop },
      { input: cutout, left: 0, top: 0 },
    ])
    .flatten({ background: hexToRgb(background) })
    .png()
    .toBuffer();
}

// --- Catalogue ---------------------------------------------------------------

export interface CatalogueProduct {
  name: string;
  price: number | null; // naira; null until the owner gives it
  cutout: Buffer;
}

export interface CatalogueArgs {
  businessName: string;
  products: CatalogueProduct[];
  brand?: Partial<BrandColours>;
}

export interface CatalogueResult {
  png: Buffer;
  included: number;
  total: number;
}

const PAGE_W = 1080;
const PAGE_H = 1350;
const MARGIN = 60;
const MAX_PRODUCTS = 6;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

// Lays out approved products (cutout, name, price) in a grid, 1080x1350.
export async function renderCatalogue(
  args: CatalogueArgs,
): Promise<CatalogueResult> {
  const brand: BrandColours = { ...DEFAULT_BRAND, ...args.brand };
  const total = args.products.length;
  const products = args.products.slice(0, MAX_PRODUCTS);
  const cols = 2;
  const rows = Math.max(1, Math.ceil(products.length / cols));
  const gap = 30;
  const cardW = Math.floor((PAGE_W - MARGIN * 2 - gap * (cols - 1)) / cols);
  const rowH = 360;
  const imageH = 210;
  const headerEnd = 210;
  const footerStart = PAGE_H - 110;
  const gridH = rows * rowH + (rows - 1) * gap;
  const gridY = Math.max(
    headerEnd + 10,
    headerEnd + 10 + Math.floor((footerStart - headerEnd - 10 - gridH) / 2),
  );

  const cards: string[] = [];
  const texts: string[] = [];
  const cells: Array<{ x: number; y: number }> = [];
  products.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MARGIN + col * (cardW + gap);
    const y = gridY + row * (rowH + gap);
    cards.push(
      `<rect x="${x}" y="${y}" width="${cardW}" height="${rowH}" rx="24" fill="${brand.card}"/>`,
    );
    cells.push({ x, y });
    const cx = x + cardW / 2;
    texts.push(
      textPath(
        workSans(),
        escapeXml(fitText(workSans(), p.name, 36, cardW - 48)),
        cx,
        y + imageH + 62,
        36,
        brand.ink,
      ),
    );
    const priceText =
      p.price === null || !Number.isFinite(p.price)
        ? "Price on request"
        : naira(p.price);
    texts.push(
      textPath(
        workSans(),
        escapeXml(priceText),
        cx,
        y + imageH + 112,
        p.price === null ? 30 : 40,
        p.price === null ? brand.body : brand.ink,
        p.price !== null,
      ),
    );
  });

  const headerName = fitText(
    anton(),
    args.businessName.toUpperCase(),
    76,
    PAGE_W - MARGIN * 2,
  );
  const headerSvg =
    `<rect x="${MARGIN}" y="150" width="${PAGE_W - MARGIN * 2}" height="6" fill="${brand.accent}"/>` +
    textPath(anton(), escapeXml(headerName), PAGE_W / 2, 118, 76, brand.ink);
  const footerSvg = textPath(
    workSans(),
    escapeXml("Order on WhatsApp"),
    PAGE_W / 2,
    PAGE_H - 52,
    34,
    brand.body,
  );

  // Product images, contained in the top of each card. Resized first so
  // everything below goes into ONE composite call (later calls replace
  // earlier layers).
  const imageLayers: OverlayOptions[] = [];
  for (let i = 0; i < products.length; i++) {
    const resized = await sharp(products[i].cutout)
      .resize(cardW - 48, imageH - 16, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const info = await sharp(resized).metadata();
    const iw = info.width ?? cardW - 48;
    const ih = info.height ?? imageH - 16;
    imageLayers.push({
      input: resized,
      left: cells[i].x + Math.floor((cardW - iw) / 2),
      top: cells[i].y + 8 + Math.floor((imageH - 16 - ih) / 2),
    });
  }

  const png = await sharp({
    create: {
      width: PAGE_W,
      height: PAGE_H,
      channels: 3,
      background: brand.background,
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${PAGE_W}" height="${PAGE_H}">${cards.join("")}${headerSvg}</svg>`,
        ),
        left: 0,
        top: 0,
      },
      ...imageLayers,
      {
        input: Buffer.from(
          `<svg width="${PAGE_W}" height="${PAGE_H}">${texts.join("")}${footerSvg}</svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  return { png, included: products.length, total };
}
