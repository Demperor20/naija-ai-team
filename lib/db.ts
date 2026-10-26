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

export interface FileRow {
  id: string;
  company_id: string;
  decision_id: string | null;
  kind: string;
  url: string;
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
}): Promise<FileRow> {
  const { data, error } = await getClient()
    .from("files")
    .insert({
      company_id: input.companyId,
      decision_id: input.decisionId ?? null,
      kind: input.kind,
      url: input.url,
    })
    .select()
    .single();
  if (error) fail("saveFile", error);
  return data as FileRow;
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
