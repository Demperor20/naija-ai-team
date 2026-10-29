// lib/decisions.ts — applies approved proposals (AGENTS.md section 12).
// Nothing in a proposal's payload takes effect until applyDecision() runs
// after the owner's Approve tap. Each decision is applied at most once,
// guarded by applied_at (see markDecisionApplied).

import {
  approveProducts,
  getDecision,
  getFile,
  getMessageById,
  insertLedgerEntries,
  markDecisionApplied,
  setFileApproved,
  type NewLedgerEntry,
} from "./db";

export type ProposalKind =
  | "general"
  | "ledger"
  | "product"
  | "flyer"
  | "video"
  | "catalogue"
  | "statement";

export interface ApplyResult {
  applied: boolean;
  kind: string;
  inserted?: number;
  // For file kinds (catalogue, flyer, video, statement): the approved
  // file, so callers can send it to the owner.
  fileId?: string;
}

// ---------------------------------------------------------------------------
// Ledger payload validation (AGENTS.md section 13). Runs before saving the
// proposal (warnings go back into the agent's reply) and again before
// inserting (defense in depth).
// ---------------------------------------------------------------------------

export interface ValidatedLedgerEntry {
  entryDate: string;
  kind: string;
  item: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  counterparty: string | null;
  paymentMethod: string | null;
  confidence: number | null;
}

export interface ValidatedLedgerPayload {
  entries: ValidatedLedgerEntry[];
  warnings: string[];
  fileId: string | null;
}

const ENTRY_KINDS = ["sale", "expense", "debt_given", "debt_paid", "stock_in"];

function todayLagos(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isGoodNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function naira(n: number): string {
  return `₦${n.toLocaleString("en-NG")}`;
}

export function validateLedgerPayload(payload: unknown): ValidatedLedgerPayload {
  const warnings: string[] = [];
  const entries: ValidatedLedgerEntry[] = [];
  const today = todayLagos();

  if (typeof payload !== "object" || payload === null) {
    warnings.push("the batch has no readable entries");
    return { entries, warnings, fileId: null };
  }
  const obj = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  if (rawEntries.length === 0) {
    warnings.push("the batch has no readable entries");
  }

  // Accept snake_case (agent output) and camelCase (our own validated
  // output): the pre-save gate stores validated entries, and applyDecision
  // re-validates them, so validation must be idempotent.
  const rawFileId = obj.file_id ?? obj.fileId;
  const fileId =
    typeof rawFileId === "string" && rawFileId.trim()
      ? rawFileId.trim()
      : null;

  rawEntries.forEach((raw, i) => {
    const label = `entry ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warnings.push(`${label}: not readable, skipped`);
      return;
    }
    const e = raw as Record<string, unknown>;

    const kind =
      typeof e.kind === "string" ? e.kind.trim().toLowerCase() : "";
    if (!ENTRY_KINDS.includes(kind)) {
      warnings.push(`${label}: unknown type, skipped`);
      return;
    }
    if (!isGoodNumber(e.amount) || (e.amount as number) < 0) {
      warnings.push(`${label}: amount is not a number ≥ 0, skipped`);
      return;
    }
    const amount = e.amount as number;

    let quantity: number | null = null;
    if (e.quantity !== undefined && e.quantity !== null) {
      if (!isGoodNumber(e.quantity) || (e.quantity as number) < 0) {
        warnings.push(`${label}: quantity is not a number ≥ 0, ignored`);
      } else {
        quantity = e.quantity as number;
      }
    }
    let unitPrice: number | null = null;
    const rawUnitPrice = e.unit_price ?? e.unitPrice;
    if (rawUnitPrice !== undefined && rawUnitPrice !== null) {
      if (!isGoodNumber(rawUnitPrice) || (rawUnitPrice as number) < 0) {
        warnings.push(`${label}: unit price is not a number ≥ 0, ignored`);
      } else {
        unitPrice = rawUnitPrice as number;
      }
    }
    if (quantity !== null && quantity > 0 && unitPrice !== null) {
      const expected = quantity * unitPrice;
      const tolerance = Math.max(1, Math.abs(amount) * 0.01);
      if (Math.abs(expected - amount) > tolerance) {
        warnings.push(
          `${label}: ${quantity} × ${naira(unitPrice)} = ${naira(expected)} but amount says ${naira(amount)}`,
        );
      }
    }

    const rawDate = e.entry_date ?? e.entryDate ?? e.date;
    let entryDate: string;
    if (!isValidDay(rawDate)) {
      entryDate = today;
      warnings.push(`${label}: no readable date, used today (${today})`);
    } else if ((rawDate as string) > today) {
      entryDate = today;
      warnings.push(`${label}: date ${(rawDate as string)} is in the future, used today`);
    } else {
      entryDate = rawDate as string;
    }

    entries.push({
      entryDate,
      kind,
      item: typeof e.item === "string" && e.item.trim() ? e.item.trim().slice(0, 200) : null,
      quantity,
      unitPrice,
      amount,
      counterparty:
        typeof e.counterparty === "string" && e.counterparty.trim()
          ? e.counterparty.trim().slice(0, 200)
          : null,
      paymentMethod: (() => {
        const pm = e.payment_method ?? e.paymentMethod;
        return typeof pm === "string" && pm.trim() ? pm.trim().slice(0, 50) : null;
      })(),
      confidence:
        isGoodNumber(e.confidence) &&
        (e.confidence as number) >= 0 &&
        (e.confidence as number) <= 1
          ? (e.confidence as number)
          : null,
    });
  });

  if (obj.total !== undefined && obj.total !== null) {
    if (isGoodNumber(obj.total)) {
      const sum = entries.reduce((acc, e) => acc + e.amount, 0);
      const tolerance = Math.max(1, Math.abs(sum) * 0.01);
      if (Math.abs(sum - (obj.total as number)) > tolerance) {
        warnings.push(
          `batch total says ${naira(obj.total as number)} but the entries add up to ${naira(sum)}`,
        );
      }
    } else {
      warnings.push("batch total is not a number, ignored");
    }
  }

  return { entries, warnings, fileId };
}

// The source file for a ledger batch: the agent's payload.file_id when it
// names one of this company's files, else the first file attached to the
// message that produced the proposal.
async function resolveSourceFileId(
  companyId: string,
  decision: { message_id: string | null; payload: unknown },
  payloadFileId: string | null,
): Promise<string | null> {
  if (payloadFileId) {
    const file = await getFile(payloadFileId);
    if (file && file.company_id === companyId) return file.id;
  }
  if (decision.message_id) {
    const message = await getMessageById(decision.message_id);
    const attachments = message?.attachments;
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        const fileId =
          typeof a === "object" && a !== null
            ? (a as Record<string, unknown>).fileId
            : null;
        if (typeof fileId === "string" && fileId) {
          const file = await getFile(fileId);
          if (file && file.company_id === companyId) return file.id;
        }
      }
    }
  }
  return null;
}

// Read-only half of the ledger apply: validates the payload and builds the
// rows without writing anything, so validation errors throw before the
// decision is claimed as applied.
async function prepareLedgerRows(
  companyId: string,
  decisionId: string,
  messageId: string | null,
  payload: unknown,
): Promise<NewLedgerEntry[]> {
  const validated = validateLedgerPayload(payload);
  if (validated.entries.length === 0) {
    throw new Error(
      `ledger batch has no valid entries (${validated.warnings.join("; ") || "empty batch"})`,
    );
  }
  const fileId = await resolveSourceFileId(
    companyId,
    { message_id: messageId, payload },
    validated.fileId,
  );
  return validated.entries.map((e) => ({
    decisionId,
    messageId,
    fileId,
    entryDate: e.entryDate,
    kind: e.kind,
    item: e.item,
    quantity: e.quantity,
    unitPrice: e.unitPrice,
    amount: e.amount,
    counterparty: e.counterparty,
    paymentMethod: e.paymentMethod,
    confidence: e.confidence,
  }));
}

export async function applyDecision(
  companyId: string,
  decisionId: string,
): Promise<ApplyResult> {
  const decision = await getDecision(companyId, decisionId);
  if (!decision) {
    throw new Error(`applyDecision: decision not found: ${decisionId}`);
  }
  const kind = decision.kind ?? "general";
  if (decision.status !== "approved") return { applied: false, kind };
  if (decision.applied_at) return { applied: false, kind };

  // Phase 1 — validate (reads only, no side effects). Errors here throw
  // before anything is claimed, so a fix + re-approve can retry cleanly.
  let ledgerRows: NewLedgerEntry[] | undefined;
  let productIds: string[] | undefined;
  let fileRef: string | undefined;
  switch (kind) {
    case "general":
      // Nothing else to do: the approved row itself is the effect the team
      // builds on. Claiming applied_at below records that it was applied.
      break;
    case "ledger": {
      ledgerRows = await prepareLedgerRows(
        companyId,
        decisionId,
        decision.message_id,
        decision.payload,
      );
      break;
    }
    case "product": {
      const payload = decision.payload as Record<string, unknown> | null;
      const ids = Array.isArray(payload?.product_ids)
        ? (payload.product_ids as unknown[]).filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
      if (ids.length === 0) {
        throw new Error("product proposal has no product_ids.");
      }
      productIds = ids;
      break;
    }
    case "catalogue":
    case "flyer":
    case "video":
    case "statement": {
      const payload = decision.payload as Record<string, unknown> | null;
      const id =
        typeof payload?.file_id === "string" ? payload.file_id : "";
      if (!id) throw new Error(`${kind} proposal has no file_id.`);
      const file = await getFile(id);
      if (!file || file.company_id !== companyId) {
        throw new Error(`${kind} file not found for this company.`);
      }
      fileRef = id;
      break;
    }
    default:
      console.warn(
        `applyDecision: kind not implemented yet: ${kind}; leaving decision ${decisionId} unapplied`,
      );
      return { applied: false, kind };
  }

  // Phase 2 — claim applied_at atomically. Two concurrent approves both
  // pass the check above, but only one wins this conditional update; the
  // loser returns unapplied with zero side effects, so ledger rows and
  // product approvals can never be written twice.
  const claimed = await markDecisionApplied(companyId, decisionId);
  if (!claimed) return { applied: false, kind };

  // Phase 3 — apply the validated plan. Failures here are rare (the plan
  // was just validated) and are reported to the caller, which logs them.
  let inserted: number | undefined;
  let fileId: string | undefined;
  if (ledgerRows) {
    inserted = (await insertLedgerEntries(companyId, ledgerRows)).length;
  }
  if (productIds) {
    inserted = await approveProducts(companyId, productIds);
  }
  if (fileRef) {
    await setFileApproved(companyId, fileRef);
    fileId = fileRef;
  }
  return { applied: true, kind, inserted, fileId };
}
