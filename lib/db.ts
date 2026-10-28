// lib/db.ts — server-only Supabase helpers (service-role key).
// Safe to import from API routes, lib/agents/* and scripts/*. Never import
// from client components: the service-role key must never reach the browser.
// Every helper that touches company data filters by companyId.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable",
      );
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

function fail(op: string, err: { message: string }): never {
  throw new Error(`db.${op} failed: ${err.message}`);
}

// IDs and tokens from URLs and buttons must be UUIDs before they touch a
// UUID column, or PostgREST throws instead of returning no rows.
export function isUuid(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

// --- Row types (snake_case matches supabase/schema.sql) ---

export interface Company {
  id: string;
  access_token: string;
  owner_name: string;
  name: string;
  one_liner: string;
  description: string;
  target_customer: string | null;
  goals: string;
  stage: string;
  source: string;
  whatsapp_phone: string | null;
  profile: unknown;
  created_at: string;
}

export interface Message {
  id: string;
  company_id: string;
  channel_id: string;
  agent_key: string;
  agent_name: string;
  owner_message: string;
  reply: string;
  source: string;
  attachments: unknown;
  created_at: string;
}

export type DecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested";

export interface Decision {
  decision_id: string;
  company_id: string;
  message_id: string | null;
  channel_id: string;
  title: string;
  description: string;
  category: string | null;
  owner: string | null;
  priority: string | null;
  status: DecisionStatus;
  owner_note: string | null;
  created_at: string;
  decided_at: string | null;
  kind: string;
  payload: unknown;
  applied_at: string | null;
}

export interface AgentRun {
  id: string;
  company_id: string;
  message_id: string | null;
  agent_key: string;
  model: string;
  step: string;
  detail: string | null;
  ms: number | null;
  created_at: string;
}

export interface WhatsappUser {
  phone: string;
  company_id: string | null;
  onboarding_step: string;
  onboarding_data: unknown;
  awaiting_note_for: string | null;
  last_seen_at: string;
}

export interface LedgerEntryRow {
  id: string;
  company_id: string;
  decision_id: string | null;
  source_file_id: string | null;
  source_message_id: string | null;
  entry_date: string;
  kind: string;
  item: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  counterparty: string | null;
  payment_method: string | null;
  confidence: number | null;
  status: string;
  created_at: string;
}

export interface LedgerDailyRow {
  company_id: string;
  entry_date: string;
  sales: number;
  expenses: number;
  profit: number;
}

export interface WhoOwesRow {
  company_id: string;
  counterparty: string;
  balance: number;
}

export interface FileRow {
  id: string;
  company_id: string;
  decision_id: string | null;
  kind: string;
  url: string;
  mime: string | null;
  made_by: string;
  message_id: string | null;
  meta: unknown;
  created_at: string;
}

// --- Companies ---

export interface NewCompany {
  ownerName: string;
  name: string;
  oneLiner?: string;
  description?: string;
  targetCustomer?: string;
  goals?: string;
  stage?: string;
  source?: string;
  whatsappPhone?: string;
}

export async function createCompany(input: NewCompany): Promise<Company> {
  const { data, error } = await getClient()
    .from("companies")
    .insert({
      owner_name: input.ownerName,
      name: input.name,
      one_liner: input.oneLiner ?? "",
      description: input.description ?? "",
      target_customer: input.targetCustomer ?? null,
      goals: input.goals ?? "",
      stage: input.stage ?? "Idea",
      source: input.source ?? "tryit",
      whatsapp_phone: input.whatsappPhone ?? null,
    })
    .select()
    .single();
  if (error) fail("createCompany", error);
  return data as Company;
}

export async function getCompany(companyId: string): Promise<Company | null> {
  const { data, error } = await getClient()
    .from("companies")
    .select()
    .eq("id", companyId)
    .maybeSingle();
  if (error) fail("getCompany", error);
  return data as Company | null;
}

export async function getCompanyByToken(
  token: string,
): Promise<Company | null> {
  // Dashboard tokens come from URLs owners type or paste; a malformed
  // token is "not found", not a database error (access_token is UUID).
  if (!isUuid(token)) {
    return null;
  }
  const { data, error } = await getClient()
    .from("companies")
    .select()
    .eq("access_token", token)
    .maybeSingle();
  if (error) fail("getCompanyByToken", error);
  return data as Company | null;
}

export async function deleteCompany(companyId: string): Promise<void> {
  const { error } = await getClient()
    .from("companies")
    .delete()
    .eq("id", companyId);
  if (error) fail("deleteCompany", error);
}

// Latest messages across all channels, newest first (for the dashboard).
export async function listCompanyMessages(
  companyId: string,
  limit: number,
): Promise<Message[]> {
  const { data, error } = await getClient()
    .from("messages")
    .select()
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("listCompanyMessages", error);
  return (data ?? []) as Message[];
}

// --- Messages ---

export interface NewMessage {
  companyId: string;
  channelId: string;
  agentKey: string;
  agentName: string;
  ownerMessage?: string;
  reply?: string;
  source?: string;
  attachments?: unknown;
}

export async function saveMessage(input: NewMessage): Promise<Message> {
  const { data, error } = await getClient()
    .from("messages")
    .insert({
      company_id: input.companyId,
      channel_id: input.channelId,
      agent_key: input.agentKey,
      agent_name: input.agentName,
      owner_message: input.ownerMessage ?? "",
      reply: input.reply ?? "",
      source: input.source ?? "tryit",
      attachments: input.attachments ?? [],
    })
    .select()
    .single();
  if (error) fail("saveMessage", error);
  return data as Message;
}

// Last `limit` messages in a channel, oldest first (for agent context).
export async function getRecentMessages(
  companyId: string,
  channelId: string,
  limit: number,
): Promise<Message[]> {
  const { data, error } = await getClient()
    .from("messages")
    .select()
    .eq("company_id", companyId)
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("getRecentMessages", error);
  return ((data ?? []) as Message[]).reverse();
}

// --- Decisions ---

export interface NewDecision {
  title: string;
  description?: string;
  category?: string;
  owner?: string;
  priority?: string;
  kind?: string;
  payload?: unknown;
}

export async function saveDecisions(args: {
  companyId: string;
  messageId: string;
  channelId: string;
  decisions: NewDecision[];
}): Promise<Decision[]> {
  if (args.decisions.length === 0) return [];
  const { data, error } = await getClient()
    .from("decisions")
    .insert(
      args.decisions.map((d) => ({
        company_id: args.companyId,
        message_id: args.messageId,
        channel_id: args.channelId,
        title: d.title,
        description: d.description ?? "",
        category: d.category ?? null,
        owner: d.owner ?? null,
        priority: d.priority ?? null,
        kind: d.kind ?? "general",
        payload: d.payload ?? {},
        status: "pending",
      })),
    )
    .select();
  if (error) fail("saveDecisions", error);
  return (data ?? []) as Decision[];
}

// Only the owner's tap may call this (web button or WhatsApp button).
export async function setDecisionStatus(
  companyId: string,
  decisionId: string,
  status: DecisionStatus,
  note?: string,
): Promise<Decision> {
  const patch: Record<string, string> = {
    status,
    decided_at: new Date().toISOString(),
  };
  if (note !== undefined) patch.owner_note = note;
  const { data, error } = await getClient()
    .from("decisions")
    .update(patch)
    .eq("company_id", companyId)
    .eq("decision_id", decisionId)
    .select()
    .maybeSingle();
  if (error) fail("setDecisionStatus", error);
  if (!data) {
    throw new Error("db.setDecisionStatus failed: decision not found");
  }
  return data as Decision;
}

// Atomically marks a decision applied, exactly once: only the caller whose
// update finds applied_at still null wins (returns true).
export async function markDecisionApplied(
  companyId: string,
  decisionId: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from("decisions")
    .update({ applied_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("decision_id", decisionId)
    .is("applied_at", null)
    .select("decision_id");
  if (error) fail("markDecisionApplied", error);
  return (data?.length ?? 0) > 0;
}

export async function listDecisions(
  companyId: string,
  status: DecisionStatus | "all",
): Promise<Decision[]> {
  let query = getClient()
    .from("decisions")
    .select()
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) fail("listDecisions", error);
  return (data ?? []) as Decision[];
}

export async function getDecision(
  companyId: string,
  decisionId: string,
): Promise<Decision | null> {
  const { data, error } = await getClient()
    .from("decisions")
    .select()
    .eq("company_id", companyId)
    .eq("decision_id", decisionId)
    .maybeSingle();
  if (error) fail("getDecision", error);
  return data as Decision | null;
}

export async function getApprovedDecisions(
  companyId: string,
): Promise<Decision[]> {
  const { data, error } = await getClient()
    .from("decisions")
    .select()
    .eq("company_id", companyId)
    .eq("status", "approved")
    .order("created_at", { ascending: true });
  if (error) fail("getApprovedDecisions", error);
  return (data ?? []) as Decision[];
}

// --- Agent runs ---

export interface NewAgentRun {
  companyId: string;
  messageId?: string;
  agentKey: string;
  model: string;
  step: string;
  detail?: string;
  ms?: number;
}

export async function saveAgentRun(input: NewAgentRun): Promise<AgentRun> {
  const { data, error } = await getClient()
    .from("agent_runs")
    .insert({
      company_id: input.companyId,
      message_id: input.messageId ?? null,
      agent_key: input.agentKey,
      model: input.model,
      step: input.step,
      detail: input.detail ?? null,
      ms: input.ms ?? null,
    })
    .select()
    .single();
  if (error) fail("saveAgentRun", error);
  return data as AgentRun;
}

export async function listAgentRunsByMessage(
  messageId: string,
): Promise<AgentRun[]> {
  const { data, error } = await getClient()
    .from("agent_runs")
    .select()
    .eq("message_id", messageId)
    .order("created_at", { ascending: true });
  if (error) fail("listAgentRunsByMessage", error);
  return (data ?? []) as AgentRun[];
}

// --- WhatsApp users ---

export async function getWhatsappUser(
  phone: string,
): Promise<WhatsappUser | null> {
  const { data, error } = await getClient()
    .from("whatsapp_users")
    .select()
    .eq("phone", phone)
    .maybeSingle();
  if (error) fail("getWhatsappUser", error);
  return data as WhatsappUser | null;
}

export async function upsertWhatsappUser(input: {
  phone: string;
  companyId?: string | null;
  onboardingStep?: string;
  onboardingData?: unknown;
  awaitingNoteFor?: string | null;
}): Promise<WhatsappUser> {
  const row: Record<string, unknown> = {
    phone: input.phone,
    last_seen_at: new Date().toISOString(),
  };
  if (input.companyId !== undefined) row.company_id = input.companyId;
  if (input.onboardingStep !== undefined)
    row.onboarding_step = input.onboardingStep;
  if (input.onboardingData !== undefined)
    row.onboarding_data = input.onboardingData;
  if (input.awaitingNoteFor !== undefined)
    row.awaiting_note_for = input.awaitingNoteFor;
  const { data, error } = await getClient()
    .from("whatsapp_users")
    .upsert(row, { onConflict: "phone" })
    .select()
    .single();
  if (error) fail("upsertWhatsappUser", error);
  return data as WhatsappUser;
}

// --- WhatsApp seen ids (duplicate-delivery guard) ---

export async function hasWhatsappSeen(
  waMessageId: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from("whatsapp_seen")
    .select("wa_message_id")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (error) fail("hasWhatsappSeen", error);
  return data !== null;
}

export async function markWhatsappSeen(waMessageId: string): Promise<void> {
  const { error } = await getClient()
    .from("whatsapp_seen")
    .upsert({ wa_message_id: waMessageId }, { onConflict: "wa_message_id" });
  if (error) fail("markWhatsappSeen", error);
}

// --- Files ---

export async function saveFile(input: {
  companyId: string;
  decisionId?: string;
  kind: string;
  url: string;
  mime?: string;
  madeBy?: string;
  messageId?: string;
  meta?: unknown;
}): Promise<FileRow> {
  const { data, error } = await getClient()
    .from("files")
    .insert({
      company_id: input.companyId,
      decision_id: input.decisionId ?? null,
      kind: input.kind,
      url: input.url,
      mime: input.mime ?? null,
      made_by: input.madeBy ?? "owner",
      message_id: input.messageId ?? null,
      meta: input.meta ?? {},
    })
    .select()
    .single();
  if (error) fail("saveFile", error);
  return data as FileRow;
}

export async function getFile(fileId: string): Promise<FileRow | null> {
  const { data, error } = await getClient()
    .from("files")
    .select()
    .eq("id", fileId)
    .maybeSingle();
  if (error) fail("getFile", error);
  return data as FileRow | null;
}

export async function getMessageById(
  messageId: string,
): Promise<Message | null> {
  const { data, error } = await getClient()
    .from("messages")
    .select()
    .eq("id", messageId)
    .maybeSingle();
  if (error) fail("getMessageById", error);
  return data as Message | null;
}

export async function findCompaniesByName(name: string): Promise<Company[]> {
  const { data, error } = await getClient()
    .from("companies")
    .select()
    .ilike("name", name)
    .order("created_at", { ascending: false });
  if (error) fail("findCompaniesByName", error);
  return (data ?? []) as Company[];
}

export async function listConfirmedLedgerEntries(
  companyId: string,
  limit: number,
): Promise<LedgerEntryRow[]> {
  const { data, error } = await getClient()
    .from("ledger_entries")
    .select()
    .eq("company_id", companyId)
    .eq("status", "confirmed")
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("listConfirmedLedgerEntries", error);
  return (data ?? []) as LedgerEntryRow[];
}

export async function listConfirmedLedgerEntriesInRange(
  companyId: string,
  startDay: string,
  endDay: string,
): Promise<LedgerEntryRow[]> {
  const { data, error } = await getClient()
    .from("ledger_entries")
    .select()
    .eq("company_id", companyId)
    .eq("status", "confirmed")
    .gte("entry_date", startDay)
    .lte("entry_date", endDay)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) fail("listConfirmedLedgerEntriesInRange", error);
  return (data ?? []) as LedgerEntryRow[];
}

export interface NewLedgerEntry {
  decisionId: string;
  messageId: string | null;
  fileId: string | null;
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

export async function insertLedgerEntries(
  companyId: string,
  entries: NewLedgerEntry[],
): Promise<LedgerEntryRow[]> {
  if (entries.length === 0) return [];
  const { data, error } = await getClient()
    .from("ledger_entries")
    .insert(
      entries.map((e) => ({
        company_id: companyId,
        decision_id: e.decisionId,
        source_file_id: e.fileId,
        source_message_id: e.messageId,
        entry_date: e.entryDate,
        kind: e.kind,
        item: e.item,
        quantity: e.quantity,
        unit_price: e.unitPrice,
        amount: e.amount,
        counterparty: e.counterparty,
        payment_method: e.paymentMethod,
        confidence: e.confidence,
        status: "confirmed",
      })),
    )
    .select();
  if (error) fail("insertLedgerEntries", error);
  return (data ?? []) as LedgerEntryRow[];
}

export async function getLedgerDaily(
  companyId: string,
  startDay: string,
  endDay: string,
): Promise<LedgerDailyRow[]> {
  const { data, error } = await getClient()
    .from("ledger_daily")
    .select()
    .eq("company_id", companyId)
    .gte("entry_date", startDay)
    .lte("entry_date", endDay)
    .order("entry_date", { ascending: true });
  if (error) fail("getLedgerDaily", error);
  return (data ?? []) as LedgerDailyRow[];
}

export async function getWhoOwesMe(
  companyId: string,
  limit: number,
): Promise<WhoOwesRow[]> {
  const { data, error } = await getClient()
    .from("who_owes_me")
    .select()
    .eq("company_id", companyId)
    .order("balance", { ascending: false })
    .limit(limit);
  if (error) fail("getWhoOwesMe", error);
  return (data ?? []) as WhoOwesRow[];
}

export async function listFiles(companyId: string): Promise<FileRow[]> {
  const { data, error } = await getClient()
    .from("files")
    .select()
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) fail("listFiles", error);
  return (data ?? []) as FileRow[];
}

// --- Products ---

export interface ProductRow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  price: number | null;
  photo_file_id: string | null;
  cutout_file_id: string | null;
  status: string;
  created_at: string;
}

export async function createProduct(input: {
  companyId: string;
  name: string;
  description?: string;
  price?: number;
  photoFileId?: string;
  cutoutFileId?: string;
}): Promise<ProductRow> {
  const { data, error } = await getClient()
    .from("products")
    .insert({
      company_id: input.companyId,
      name: input.name,
      description: input.description ?? null,
      price: input.price ?? null,
      photo_file_id: input.photoFileId ?? null,
      cutout_file_id: input.cutoutFileId ?? null,
      status: "pending",
    })
    .select()
    .single();
  if (error) fail("createProduct", error);
  return data as ProductRow;
}

export async function getProduct(
  companyId: string,
  productId: string,
): Promise<ProductRow | null> {
  const { data, error } = await getClient()
    .from("products")
    .select()
    .eq("id", productId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) fail("getProduct", error);
  return data as ProductRow | null;
}

export async function setProductPrice(
  companyId: string,
  productId: string,
  price: number | null,
): Promise<void> {
  const { error } = await getClient()
    .from("products")
    .update({ price })
    .eq("id", productId)
    .eq("company_id", companyId);
  if (error) fail("setProductPrice", error);
}

// Approves the given products (scoped to the company). Returns how many.
export async function approveProducts(
  companyId: string,
  productIds: string[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const { data, error } = await getClient()
    .from("products")
    .update({ status: "approved" })
    .in("id", productIds)
    .eq("company_id", companyId)
    .select("id");
  if (error) fail("approveProducts", error);
  return (data ?? []).length;
}

export async function listApprovedProducts(
  companyId: string,
): Promise<ProductRow[]> {
  const { data, error } = await getClient()
    .from("products")
    .select()
    .eq("company_id", companyId)
    .eq("status", "approved")
    .order("created_at", { ascending: true });
  if (error) fail("listApprovedProducts", error);
  return (data ?? []) as ProductRow[];
}

// --- Media jobs (long tasks: video, catalogue, statement) ---

export type MediaJobStatus = "queued" | "running" | "done" | "failed";

export interface MediaJob {
  id: string;
  company_id: string;
  kind: string;
  status: MediaJobStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function createMediaJob(input: {
  companyId: string;
  kind: string;
  jobInput?: unknown;
}): Promise<MediaJob> {
  const { data, error } = await getClient()
    .from("media_jobs")
    .insert({
      company_id: input.companyId,
      kind: input.kind,
      status: "queued",
      input: input.jobInput ?? {},
    })
    .select()
    .single();
  if (error) fail("createMediaJob", error);
  return data as MediaJob;
}

export async function getMediaJob(jobId: string): Promise<MediaJob | null> {
  const { data, error } = await getClient()
    .from("media_jobs")
    .select()
    .eq("id", jobId)
    .maybeSingle();
  if (error) fail("getMediaJob", error);
  return data as MediaJob | null;
}

// Oldest queued job of a kind for this company. Runners claim with
// claimMediaJob before doing any work.
export async function listQueuedMediaJobs(
  companyId: string,
  kind: string,
): Promise<MediaJob[]> {
  const { data, error } = await getClient()
    .from("media_jobs")
    .select()
    .eq("company_id", companyId)
    .eq("kind", kind)
    .eq("status", "queued")
    .order("created_at", { ascending: true });
  if (error) fail("listQueuedMediaJobs", error);
  return (data ?? []) as MediaJob[];
}

// Atomically moves a queued job to running. Only the caller whose update
// finds the job still queued wins (returns true); everyone else skips it.
export async function claimMediaJob(
  companyId: string,
  jobId: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from("media_jobs")
    .update({
      status: "running",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("company_id", companyId)
    .eq("status", "queued")
    .select("id");
  if (error) fail("claimMediaJob", error);
  return (data?.length ?? 0) > 0;
}

export async function setMediaJobDone(
  companyId: string,
  jobId: string,
  output: unknown,
): Promise<void> {
  const { error } = await getClient()
    .from("media_jobs")
    .update({
      status: "done",
      output: output ?? {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("company_id", companyId);
  if (error) fail("setMediaJobDone", error);
}

export async function setMediaJobFailed(
  companyId: string,
  jobId: string,
  message: string,
): Promise<void> {
  const { error } = await getClient()
    .from("media_jobs")
    .update({
      status: "failed",
      error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("company_id", companyId);
  if (error) fail("setMediaJobFailed", error);
}

// --- File approval ---

// Marks a team-made file approved (files.meta.approved = true).
export async function setFileApproved(
  companyId: string,
  fileId: string,
): Promise<boolean> {
  const file = await getFile(fileId);
  if (!file || file.company_id !== companyId) return false;
  const meta =
    typeof file.meta === "object" && file.meta !== null
      ? (file.meta as Record<string, unknown>)
      : {};
  const { error } = await getClient()
    .from("files")
    .update({ meta: { ...meta, approved: true } })
    .eq("id", fileId)
    .eq("company_id", companyId);
  if (error) fail("setFileApproved", error);
  return true;
}
