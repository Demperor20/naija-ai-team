// lib/agents/tools.ts — tool definitions for the model plus the web_search
// handler. delegate_* calls are executed by lib/agents/run.ts, which runs
// the specialist's own loop (this file must not import run.ts).

import { randomUUID } from "node:crypto";
import { generateImage, segment, type MetaTool } from "../meta";
import {
  createProduct,
  getClient,
  getCompany,
  getFile,
  getLedgerDaily,
  getWhoOwesMe,
  listApprovedProducts,
  listConfirmedLedgerEntriesInRange,
  saveFile,
} from "../db";
import {
  applyMask,
  DEFAULT_BRAND,
  renderCatalogue,
  renderFlyer,
  resizeForSegment,
  type BrandColours,
} from "../images";
import { createMediaJob } from "../db";
import { validateVideoJobInput } from "../video";
import {
  buildStatementPdf,
  monthRange,
  statementMonthLabel,
  validateStatementMonth,
} from "../statement";
import { SPECIALIST_KEYS } from "./team";

export const WEB_SEARCH_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current facts: competitors, prices, rules, trends. Returns up to 5 results with title, url and a short snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
};

const DELEGATE_DESCRIPTIONS: Record<string, string> = {
  books:
    "Ask Books: read sales notebooks, receipts, POS slips and spoken sales; keep the books; who owes the owner; weekly results.",
  product:
    "Ask Plans: what to offer or build first and how to test it.",
  marketing:
    "Ask Promotion: posts, captions, promo ideas and short marketing videos from the owner's footage.",
  design:
    "Ask Flyers & Catalogue: flyers, Status images, product cutouts and the catalogue.",
  engineering:
    "Ask Tools & Costs: which tools to use and what they cost.",
  sales:
    "Ask Prices & Customers: pricing, offers, customer replies and follow-ups.",
  compliance:
    "Ask Paperwork: business registration, tax ID, data protection and startup rules, with official sources.",
};

export function delegateToolFor(specialistKey: string): MetaTool {
  return {
    type: "function",
    function: {
      name: `delegate_${specialistKey}`,
      description: `${DELEGATE_DESCRIPTIONS[specialistKey] ?? `Ask the ${specialistKey} specialist.`} Include the business profile, the relevant approved decisions and a clear task in the brief.`,
      parameters: {
        type: "object",
        properties: {
          brief: {
            type: "string",
            description: "Task brief for the specialist.",
          },
        },
        required: ["brief"],
      },
    },
  };
}

export const BOOKS_SUMMARY_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "books_summary",
    description:
      "Read recorded sales from the books (confirmed entries only). Use when the owner asks how sales are doing. Period is one of: today, yesterday, week, month.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "yesterday", "week", "month"],
          description: "Which period to summarise.",
        },
      },
      required: ["period"],
    },
  },
};

export const WHO_OWES_ME_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "who_owes_me",
    description:
      "List customers who still owe the owner money, biggest debt first. Use when the owner asks who owes them.",
    parameters: { type: "object", properties: {} },
  },
};

export function getToolsFor(agentKey: string): MetaTool[] {
  if (agentKey === "ceo") {
    return [WEB_SEARCH_TOOL, ...SPECIALIST_KEYS.map(delegateToolFor)];
  }
  if (agentKey === "books") {
    return [
      WEB_SEARCH_TOOL,
      BOOKS_SUMMARY_TOOL,
      WHO_OWES_ME_TOOL,
      MAKE_STATEMENT_TOOL,
    ];
  }
  if (agentKey === "design") {
    return [
      WEB_SEARCH_TOOL,
      MAKE_CUTOUT_TOOL,
      MAKE_CATALOGUE_TOOL,
      MAKE_FLYER_TOOL,
    ];
  }
  if (agentKey === "marketing") {
    return [WEB_SEARCH_TOOL, MAKE_VIDEO_TOOL];
  }
  return [WEB_SEARCH_TOOL];
}

export interface BooksSummary {
  period: string;
  start: string;
  end: string;
  days: Array<{ day: string; sales: number; expenses: number; profit: number }>;
  totalSales: number;
  totalExpenses: number;
  totalProfit: number;
}

export interface WhoOwesResult {
  customer: string;
  owed: number;
}

function lagosDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function handleBooksSummary(
  companyId: string,
  args: { period?: unknown },
): Promise<BooksSummary | { error: string }> {
  const period =
    args.period === "today" ||
    args.period === "yesterday" ||
    args.period === "week" ||
    args.period === "month"
      ? args.period
      : "week";
  const start =
    period === "today"
      ? lagosDay(0)
      : period === "yesterday"
        ? lagosDay(-1)
        : period === "week"
          ? lagosDay(-6)
          : lagosDay(-29);
  const end = period === "yesterday" ? lagosDay(-1) : lagosDay(0);
  const rows = await getLedgerDaily(companyId, start, end);
  const days = rows.map((r) => ({
    day: r.entry_date,
    sales: Number(r.sales) || 0,
    expenses: Number(r.expenses) || 0,
    profit: Number(r.profit) || 0,
  }));
  return {
    period,
    start,
    end,
    days,
    totalSales: days.reduce((acc, d) => acc + d.sales, 0),
    totalExpenses: days.reduce((acc, d) => acc + d.expenses, 0),
    totalProfit: days.reduce((acc, d) => acc + d.profit, 0),
  };
}

export async function handleWhoOwesMe(
  companyId: string,
): Promise<WhoOwesResult[] | { error: string }> {
  const rows = await getWhoOwesMe(companyId, 10);
  return rows
    .map((r) => ({
      customer: r.counterparty,
      owed: Number(r.balance) || 0,
    }))
    .filter((r) => r.owed > 0);
}

export const MAKE_CUTOUT_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "make_cutout",
    description:
      "Cut a product out of its photo onto a clean brand background. Creates the product (pending approval). Use the file_id of the owner's product photo and a short product name.",
    parameters: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "The file_id of the product photo.",
        },
        product_name: {
          type: "string",
          description:
            "Short product name in plain words, e.g. 'blue stripe Ankara gown'. Also used to find the product in the photo.",
        },
      },
      required: ["file_id", "product_name"],
    },
  },
};

export const MAKE_CATALOGUE_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "make_catalogue",
    description:
      "Lay out all approved products with cutouts into a 1080x1350 catalogue image (name and naira price under each). Call only when at least one product is approved; ask for missing prices first.",
    parameters: { type: "object", properties: {} },
  },
};

function dayStamp(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function downloadFile(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`could not download file (HTTP ${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function uploadTeamFile(
  companyId: string,
  kind: string,
  buffer: Buffer,
  messageId?: string,
  sourceFileId?: string,
): Promise<{ fileId: string; url: string }> {
  const path = `${companyId}/${dayStamp()}/${randomUUID()}.png`;
  const { error } = await getClient()
    .storage.from("files")
    .upload(path, buffer, { contentType: "image/png", upsert: false });
  if (error) throw new Error(`file upload failed: ${error.message}`);
  const url = getClient().storage.from("files").getPublicUrl(path).data
    .publicUrl;
  const file = await saveFile({
    companyId,
    kind,
    url,
    mime: "image/png",
    madeBy: "team",
    messageId,
    meta: { size: buffer.length, ...(sourceFileId ? { source_file_id: sourceFileId } : {}) },
  });
  return { fileId: file.id, url };
}

function brandFor(profile: unknown): BrandColours {
  const brand = { ...DEFAULT_BRAND };
  if (typeof profile === "object" && profile !== null) {
    const custom = (profile as Record<string, unknown>).brand;
    if (typeof custom === "object" && custom !== null) {
      for (const key of Object.keys(brand) as Array<keyof BrandColours>) {
        const value = (custom as Record<string, unknown>)[key];
        if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
          brand[key] = value;
        }
      }
    }
  }
  return brand;
}

export interface MakeCutoutResult {
  product_id: string;
  product_name: string;
  cutout_file_id: string;
  instances_found: number;
}

export async function handleMakeCutout(
  companyId: string,
  args: { file_id?: unknown; product_name?: unknown },
): Promise<MakeCutoutResult | { error: string }> {
  const fileId = typeof args.file_id === "string" ? args.file_id : "";
  const productName =
    typeof args.product_name === "string" ? args.product_name.trim() : "";
  if (!fileId) return { error: "make_cutout needs a file_id." };
  if (!productName) return { error: "make_cutout needs a product_name." };
  const file = await getFile(fileId);
  if (!file || file.company_id !== companyId) {
    return { error: "That photo was not found." };
  }
  try {
    const [company, photo] = await Promise.all([
      getCompany(companyId),
      downloadFile(file.url),
    ]);
    if (!company) return { error: "Company not found." };
    const small = await resizeForSegment(photo);
    const found = await segment({
      buffer: small.buffer,
      mime: "image/jpeg",
      prompt: productName.slice(0, 100),
    });
    if (found.instances.length === 0) {
      return {
        error: `I couldn't find "${productName}" in that photo. Try a clearer photo or a simpler name.`,
      };
    }
    const best = found.instances.reduce((a, b) =>
      b.foreground > a.foreground ? b : a,
    );
    const cutout = await applyMask({
      photo,
      instance: best,
      background: brandFor(company.profile).background,
    });
    const saved = await uploadTeamFile(companyId, "cutout", cutout, undefined, fileId);
    const product = await createProduct({
      companyId,
      name: productName.slice(0, 200),
      photoFileId: fileId,
      cutoutFileId: saved.fileId,
    });
    return {
      product_id: product.id,
      product_name: product.name,
      cutout_file_id: saved.fileId,
      instances_found: found.instances.length,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `make_cutout failed: ${detail}` };
  }
}

export interface MakeCatalogueResult {
  catalogue_file_id: string;
  url: string;
  included: number;
  total_approved: number;
}

export async function handleMakeCatalogue(
  companyId: string,
): Promise<MakeCatalogueResult | { error: string }> {
  try {
    const company = await getCompany(companyId);
    if (!company) return { error: "Company not found." };
    const approved = await listApprovedProducts(companyId);
    const withCutout = approved.filter((p) => p.cutout_file_id);
    if (withCutout.length === 0) {
      return {
        error:
          approved.length === 0
            ? "No products are approved yet. Add products with make_cutout and get the owner to approve them first."
            : "None of the approved products has a cutout yet. Run make_cutout for each first.",
      };
    }
    const items = [];
    for (const p of withCutout) {
      const cutout = await getFile(p.cutout_file_id as string);
      if (!cutout || cutout.company_id !== companyId) continue;
      items.push({
        name: p.name,
        price: typeof p.price === "number" ? p.price : p.price === null ? null : Number(p.price),
        cutout: await downloadFile(cutout.url),
      });
    }
    if (items.length === 0) {
      return { error: "The approved products' cutouts are missing." };
    }
    const brand = brandFor(company.profile);
    const rendered = await renderCatalogue({
      businessName: company.name,
      products: items,
      brand,
    });
    const saved = await uploadTeamFile(companyId, "catalogue", rendered.png);
    return {
      catalogue_file_id: saved.fileId,
      url: saved.url,
      included: rendered.included,
      total_approved: approved.length,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `make_catalogue failed: ${detail}` };
  }
}

export const MAKE_FLYER_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "make_flyer",
    description:
      "Make a 1080x1920 promo flyer image: an AI background plus the exact words printed on top. Use only prices and details the owner gave or approved; never invent a phone number, address or price.",
    parameters: {
      type: "object",
      properties: {
        background: {
          type: "string",
          description:
            "Background picture to generate: subject, style, colours. No words will be drawn in it.",
        },
        headline: {
          type: "string",
          description: "Headline, 6 words or fewer.",
        },
        offer: {
          type: "string",
          description: "The offer in one short sentence.",
        },
        price: {
          type: "string",
          description: "Exact price words, e.g. '₦500 per cup'.",
        },
        cta: {
          type: "string",
          description: "Call to action, e.g. 'Chat us on WhatsApp'.",
        },
      },
      required: ["background", "headline"],
    },
  },
};

export interface MakeFlyerResult {
  flyer_file_id: string;
  url: string;
}

export async function handleMakeFlyer(
  companyId: string,
  args: Record<string, unknown>,
): Promise<MakeFlyerResult | { error: string }> {
  const str = (v: unknown): string =>
    typeof v === "string" ? v.trim() : "";
  const background = str(args.background);
  const headline = str(args.headline);
  if (!background) return { error: "make_flyer needs a background." };
  if (!headline) return { error: "make_flyer needs a headline." };
  try {
    const company = await getCompany(companyId);
    if (!company) return { error: "Company not found." };
    const generated = await generateImage({
      prompt: `${background}, no text, no words, no letters, no logos, no watermark`,
    });
    const flyer = await renderFlyer({
      background: generated.buffer,
      words: {
        headline: headline.slice(0, 60),
        offer: str(args.offer).slice(0, 140),
        price: str(args.price).slice(0, 60),
        cta: str(args.cta).slice(0, 60),
        businessName: company.name,
      },
      brand: brandFor(company.profile),
    });
    const saved = await uploadTeamFile(companyId, "flyer", flyer);
    return { flyer_file_id: saved.fileId, url: saved.url };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The chat only shows the model's paraphrase; log the real cause here.
    console.error(`make_flyer failed for company ${companyId}: ${detail}`);
    return { error: `make_flyer failed: ${detail}` };
  }
}

export const MAKE_VIDEO_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "make_video",
    description:
      "Start a promo video job from the owner's shop video: it cuts your 3 to 5 best moments (15 to 30 seconds total), burns in your captions, and adds an end card. The render runs in the background and the finished video arrives as its own proposal later — after calling this tool, tell the owner: Your video is cooking, I'll send it in a few minutes. Do not make a video proposal yourself.",
    parameters: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "The file_id of the owner's video.",
        },
        moments: {
          type: "array",
          description:
            "3 to 5 best moments from the highlight list, 15 to 30 seconds total.",
          items: {
            type: "object",
            properties: {
              start: {
                type: "number",
                description: "Start time in seconds.",
              },
              end: { type: "number", description: "End time in seconds." },
              caption: {
                type: "string",
                description:
                  "Caption burned on screen, 5 words or fewer. Only words and prices the owner gave or approved.",
              },
            },
            required: ["start", "end", "caption"],
          },
        },
        opening: {
          type: "string",
          description:
            "Opening line shown over the first seconds, e.g. 'Fresh zobo in Yaba!'.",
        },
      },
      required: ["file_id", "moments", "opening"],
    },
  },
};

export interface MakeVideoResult {
  job_id: string;
  status: "queued";
  segments: number;
  footage_sec: number;
  tell_owner: string;
}

export async function handleMakeVideo(
  companyId: string,
  args: Record<string, unknown>,
  channelId: string,
  source: "tryit" | "whatsapp",
): Promise<MakeVideoResult | { error: string }> {
  try {
    const input = validateVideoJobInput({
      ...args,
      source,
      channel_id: channelId,
    });
    const file = await getFile(input.fileId);
    if (!file || file.company_id !== companyId) {
      return { error: "That video was not found." };
    }
    if (file.kind !== "video") {
      return { error: "That file is not a video." };
    }
    const job = await createMediaJob({
      companyId,
      kind: "marketing_video",
      jobInput: input,
    });
    const footage = input.moments.reduce((acc, m) => acc + (m.end - m.start), 0);
    return {
      job_id: job.id,
      status: "queued",
      segments: input.moments.length,
      footage_sec: Math.round(footage),
      tell_owner: "Your video is cooking, I'll send it in a few minutes.",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: detail };
  }
}

export const MAKE_STATEMENT_TOOL: MetaTool = {
  type: "function",
  function: {
    name: "make_statement",
    description:
      "Build the monthly statement PDF from CONFIRMED entries: totals, week-by-week sales, top items, money owed and every entry. Use when the owner asks for their statement. Then propose it (kind statement with payload.file_id) so the owner approves it before sharing.",
    parameters: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description:
            'The month as YYYY-MM, e.g. "2026-10". Use the current month unless the owner names another.',
        },
      },
      required: ["month"],
    },
  },
};

export interface MakeStatementResult {
  statement_file_id: string;
  url: string;
  month: string;
  entries: number;
  sales: number;
  costs: number;
  profit: number;
}

export async function handleMakeStatement(
  companyId: string,
  args: { month?: unknown },
): Promise<MakeStatementResult | { error: string }> {
  try {
    const month = validateStatementMonth(args.month);
    const company = await getCompany(companyId);
    if (!company) return { error: "Company not found." };
    const { start, end } = monthRange(month);
    const [rows, owedRows] = await Promise.all([
      listConfirmedLedgerEntriesInRange(companyId, start, end),
      getWhoOwesMe(companyId, 50),
    ]);
    if (rows.length === 0) {
      return {
        error: `No confirmed entries for ${statementMonthLabel(month)}. Record and approve sales first.`,
      };
    }
    const pdf = await buildStatementPdf({
      businessName: company.name,
      ownerName: company.owner_name,
      month,
      entries: rows.map((r) => ({
        entryDate: r.entry_date,
        kind: r.kind,
        item: r.item,
        quantity: r.quantity !== null ? Number(r.quantity) : null,
        unitPrice: r.unit_price !== null ? Number(r.unit_price) : null,
        amount: Number(r.amount) || 0,
        counterparty: r.counterparty,
        paymentMethod: r.payment_method,
        sourceFileId: r.source_file_id,
      })),
      owed: owedRows.map((r) => ({
        counterparty: r.counterparty,
        balance: Number(r.balance) || 0,
      })),
    });
    const path = `${companyId}/${dayStamp()}/${randomUUID()}-statement-${month}.pdf`;
    const { error } = await getClient()
      .storage.from("files")
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });
    if (error) return { error: `statement upload failed: ${error.message}` };
    const url = getClient().storage.from("files").getPublicUrl(path).data
      .publicUrl;
    const file = await saveFile({
      companyId,
      kind: "statement",
      url,
      mime: "application/pdf",
      madeBy: "team",
      meta: { size: pdf.length, month, entries: rows.length },
    });
    let sales = 0;
    let costs = 0;
    for (const r of rows) {
      if (r.kind === "sale") sales += Number(r.amount) || 0;
      else if (r.kind === "expense") costs += Number(r.amount) || 0;
    }
    return {
      statement_file_id: file.id,
      url,
      month,
      entries: rows.length,
      sales,
      costs,
      profit: sales - costs,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: detail };
  }
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function handleWebSearch(args: {
  query?: unknown;
}): Promise<WebSearchResult[] | { error: string }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "web_search needs a query string." };
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    return { error: "web_search is not configured (missing FIRECRAWL_API_KEY)." };
  }
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, limit: 5 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { error: `web_search failed (HTTP ${res.status}).` };
  const json = (await res.json()) as {
    data?: Array<{ title?: string; url?: string; description?: string }>;
  };
  const data = Array.isArray(json.data) ? json.data : [];
  return data.slice(0, 5).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    snippet: (r.description ?? "").slice(0, 300),
  }));
}
