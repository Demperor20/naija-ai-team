// lib/statement.ts — monthly statement PDF (AGENTS.md section 16). Built
// from CONFIRMED ledger entries only, with pdf-lib and the embedded Work
// Sans / Anton fonts (so ₦ prints correctly).

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STATEMENT_FOOTER =
  "Records confirmed by the owner from their own notebook photos, receipts and voice notes. " +
  "Designed to share with lenders; not audited accounts.";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.11, 0.1, 0.09);
const GREY = rgb(0.42, 0.4, 0.37);
const ACCENT = rgb(0.08, 0.33, 0.18);
const RULE = rgb(0.85, 0.82, 0.77);

export interface StatementEntry {
  entryDate: string;
  kind: string;
  item: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  counterparty: string | null;
  paymentMethod: string | null;
  sourceFileId: string | null;
}

export interface StatementOwed {
  counterparty: string;
  balance: number;
}

export function validateStatementMonth(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error('make_statement needs a month like "2026-10".');
  }
  const todayMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  if (value > todayMonth) {
    throw new Error("That month hasn't happened yet.");
  }
  return value;
}

export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dd = String(endDay).padStart(2, "0");
  return { start: `${month}-01`, end: `${month}-${dd}` };
}

export function statementMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  return `${name} ${y}`;
}

function fontBytes(file: string): Buffer {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "assets", "fonts", file),
    join(process.cwd(), "assets", "fonts", file),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`statement: cannot find font ${file}`);
}

export function naira(n: number): string {
  const rounded = Math.round(n);
  return `₦${rounded.toLocaleString("en-NG")}`;
}

function shortDay(day: string): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${months[m - 1]}`;
}

interface WeekBucket {
  label: string;
  start: string;
  end: string;
  sales: number;
  costs: number;
}

// Calendar weeks (Monday–Sunday) clipped to the month.
function monthWeeks(month: string): WeekBucket[] {
  const { start, end } = monthRange(month);
  const weeks: WeekBucket[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const back = (cursor.getUTCDay() + 6) % 7; // days back to Monday
  cursor.setUTCDate(cursor.getUTCDate() - back);
  while (cursor.toISOString().slice(0, 10) <= end) {
    const wStart = cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 6);
    const wEnd = cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const clipStart = wStart < start ? start : wStart;
    const clipEnd = wEnd > end ? end : wEnd;
    weeks.push({
      label: `${shortDay(clipStart)} – ${shortDay(clipEnd)}`,
      start: clipStart,
      end: clipEnd,
      sales: 0,
      costs: 0,
    });
  }
  return weeks;
}

class Doc {
  doc!: PDFDocument;
  body!: PDFFont;
  head!: PDFFont;
  page!: PDFPage;
  y = 0;
  pageNo = 0;

  static async create(): Promise<Doc> {
    const d = new Doc();
    d.doc = await PDFDocument.create();
    d.doc.registerFontkit(fontkit);
    d.body = await d.doc.embedFont(fontBytes("WorkSans-Variable.ttf"));
    d.head = await d.doc.embedFont(fontBytes("Anton-Regular.ttf"));
    d.newPage();
    return d;
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pageNo++;
    this.y = PAGE_H - MARGIN;
    // Footer on every page.
    this.page.drawText(STATEMENT_FOOTER, {
      x: MARGIN,
      y: 30,
      size: 7.5,
      font: this.body,
      color: GREY,
      maxWidth: CONTENT_W - 60,
      lineHeight: 10,
    });
    this.page.drawText(`Page ${this.pageNo}`, {
      x: PAGE_W - MARGIN - 40,
      y: 30,
      size: 7.5,
      font: this.body,
      color: GREY,
    });
  }

  need(space: number): void {
    if (this.y - space < 64) this.newPage();
  }

  text(
    str: string,
    opts?: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number },
  ): void {
    const size = opts?.size ?? 10;
    this.page.drawText(str, {
      x: MARGIN,
      y: this.y - size,
      size,
      font: opts?.font ?? this.body,
      color: opts?.color ?? INK,
    });
    this.y -= size + (opts?.gap ?? 4);
  }

  right(str: string, size: number, font?: PDFFont): void {
    const f = font ?? this.body;
    const w = f.widthOfTextAtSize(str, size);
    this.page.drawText(str, {
      x: PAGE_W - MARGIN - w,
      y: this.y - size,
      size,
      font: f,
      color: INK,
    });
    this.y -= size + 4;
  }

  row(cells: Array<{ text: string; x: number; bold?: boolean; color?: ReturnType<typeof rgb> }>, size = 9): void {
    for (const c of cells) {
      this.page.drawText(c.text, {
        x: MARGIN + c.x,
        y: this.y - size,
        size,
        font: c.bold ? this.head : this.body,
        color: c.color ?? INK,
      });
    }
    this.y -= size + 5;
  }

  rule(): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= 10;
  }

  heading(str: string): void {
    this.need(30);
    this.y -= 6;
    this.page.drawText(str, {
      x: MARGIN,
      y: this.y - 13,
      size: 13,
      font: this.head,
      color: ACCENT,
    });
    this.y -= 13 + 6;
  }
}

const KIND_LABEL: Record<string, string> = {
  sale: "Sale",
  expense: "Cost",
  debt_given: "Given",
  debt_paid: "Repaid",
  stock_in: "Stock",
};

function entryCode(sourceFileId: string | null): string {
  if (!sourceFileId) return "—";
  return `#${sourceFileId.replace(/-/g, "").slice(0, 8)}`;
}

export async function buildStatementPdf(args: {
  businessName: string;
  ownerName: string;
  month: string;
  entries: StatementEntry[];
  owed: StatementOwed[];
}): Promise<Buffer> {
  const { businessName, ownerName, month, entries, owed } = args;
  const d = await Doc.create();

  // Title block.
  d.page.drawText(businessName.slice(0, 60), {
    x: MARGIN,
    y: d.y - 22,
    size: 22,
    font: d.head,
    color: INK,
  });
  d.y -= 22 + 6;
  d.text(`Monthly sales statement — ${statementMonthLabel(month)}`, {
    size: 12,
    color: ACCENT,
  });
  d.text(`Owner: ${ownerName}  ·  ${entries.length} confirmed entries`, {
    size: 9.5,
    color: GREY,
    gap: 8,
  });
  d.rule();

  // Totals.
  let sales = 0;
  let costs = 0;
  for (const e of entries) {
    if (e.kind === "sale") sales += e.amount;
    else if (e.kind === "expense") costs += e.amount;
  }
  const profit = sales - costs;
  d.heading("Totals");
  d.need(60);
  d.row([
    { text: "Sales", x: 0 },
    { text: naira(sales), x: 200 },
  ]);
  d.row([
    { text: "Costs", x: 0 },
    { text: naira(costs), x: 200 },
  ]);
  d.row([
    { text: "Profit", x: 0, bold: true, color: ACCENT },
    { text: naira(profit), x: 200, bold: true, color: ACCENT },
  ]);

  // Weekly breakdown.
  const weeks = monthWeeks(month);
  for (const e of entries) {
    const w = weeks.find((wk) => e.entryDate >= wk.start && e.entryDate <= wk.end);
    if (!w) continue;
    if (e.kind === "sale") w.sales += e.amount;
    else if (e.kind === "expense") w.costs += e.amount;
  }
  d.heading("Week by week");
  d.need(20 + weeks.length * 15);
  d.row(
    [
      { text: "Week", x: 0, color: GREY },
      { text: "Sales", x: 200, color: GREY },
      { text: "Costs", x: 300, color: GREY },
      { text: "Profit", x: 400, color: GREY },
    ],
    8.5,
  );
  for (const w of weeks) {
    d.need(15);
    d.row([
      { text: w.label, x: 0 },
      { text: naira(w.sales), x: 200 },
      { text: naira(w.costs), x: 300 },
      { text: naira(w.sales - w.costs), x: 400 },
    ]);
  }

  // Top items.
  const revenue = new Map<string, { qty: number; total: number }>();
  for (const e of entries) {
    if (e.kind !== "sale" || !e.item) continue;
    const hit = revenue.get(e.item) ?? { qty: 0, total: 0 };
    hit.qty += e.quantity ?? 0;
    hit.total += e.amount;
    revenue.set(e.item, hit);
  }
  const top = [...revenue.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);
  d.heading("Top items");
  if (top.length === 0) {
    d.text("No sales with item names this month.", { size: 9.5, color: GREY });
  } else {
    d.need(20 + top.length * 15);
    d.row(
      [
        { text: "Item", x: 0, color: GREY },
        { text: "Qty", x: 280, color: GREY },
        { text: "Sales", x: 350, color: GREY },
      ],
      8.5,
    );
    for (const [item, r] of top) {
      d.need(15);
      d.row([
        { text: item.slice(0, 34), x: 0 },
        { text: r.qty > 0 ? String(Math.round(r.qty * 10) / 10) : "—", x: 280 },
        { text: naira(r.total), x: 350 },
      ]);
    }
  }

  // Money owed.
  const debtors = owed.filter((o) => o.balance > 0);
  d.heading("Money owed to the business");
  if (debtors.length === 0) {
    d.text("Nobody owes the business money.", { size: 9.5, color: GREY });
  } else {
    d.need(20 + debtors.length * 15);
    for (const o of debtors) {
      d.need(15);
      d.row([
        { text: o.counterparty.slice(0, 40), x: 0 },
        { text: naira(o.balance), x: 300 },
      ]);
    }
  }

  // Every entry.
  d.heading("Every entry");
  d.need(20);
  d.row(
    [
      { text: "Date", x: 0, color: GREY },
      { text: "Code", x: 62, color: GREY },
      { text: "Type", x: 130, color: GREY },
      { text: "Item", x: 180, color: GREY },
      { text: "Amount", x: 420, color: GREY },
    ],
    8.5,
  );
  const sorted = [...entries].sort((a, b) =>
    a.entryDate < b.entryDate ? -1 : 1,
  );
  for (const e of sorted) {
    d.need(15);
    const detail = e.counterparty ? `${e.item ?? e.kind} (${e.counterparty})` : (e.item ?? "—");
    d.row([
      { text: shortDay(e.entryDate), x: 0 },
      { text: entryCode(e.sourceFileId), x: 62 },
      { text: KIND_LABEL[e.kind] ?? e.kind, x: 130 },
      { text: detail.slice(0, 30), x: 180 },
      { text: naira(e.amount), x: 420 },
    ]);
  }

  return Buffer.from(await d.doc.save());
}
