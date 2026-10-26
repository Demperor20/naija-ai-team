-- Naija AI Team — database (built during the hackathon, Oct 26, 2026).
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Only the server touches these tables, using the service-role key.
-- Row-level security is ON with no policies, so the public anon key can read nothing.

create extension if not exists pgcrypto;

-- 1. Companies: one per business owner (from WhatsApp or the Try-it page) ----
create table if not exists public.companies (
  id               uuid primary key default gen_random_uuid(),
  access_token     uuid not null unique default gen_random_uuid(), -- secret for the owner's dashboard link
  owner_name       text not null,
  name             text not null,
  one_liner        text not null default '',
  description      text not null default '',
  target_customer  text,
  goals            text not null default '',
  stage            text not null default 'Idea',
  source           text not null default 'tryit',     -- tryit | whatsapp
  whatsapp_phone   text unique,                       -- e.g. 2348031234567
  profile          jsonb,                             -- CEO's summary after kickoff
  created_at       timestamptz not null default now()
);

-- 2. Messages (one row per owner message + team reply) ------------------------
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  channel_id       text not null,
  agent_key        text not null,
  agent_name       text not null,
  owner_message    text not null default '',
  reply            text not null default '',
  source           text not null default 'tryit',      -- tryit | whatsapp
  attachments      jsonb not null default '[]'::jsonb,  -- [{kind, url, mime}]
  created_at       timestamptz not null default now()
);
create index if not exists messages_company_channel_idx
  on public.messages (company_id, channel_id, created_at desc);

-- 3. Decisions (proposals and their status) -----------------------------------
create table if not exists public.decisions (
  decision_id   uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  message_id    uuid references public.messages (id) on delete set null,
  channel_id    text not null,
  title         text not null,
  description   text not null default '',
  category      text,
  owner         text,                 -- agent key that would do the work
  priority      text,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'changes_requested')),
  owner_note    text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists decisions_company_status_idx
  on public.decisions (company_id, status, created_at desc);

-- 4. Agent runs (the trace shown on the dashboard) ----------------------------
create table if not exists public.agent_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  message_id  uuid references public.messages (id) on delete cascade,
  agent_key   text not null,
  model       text not null,
  step        text not null,           -- think | delegate | web_search | final | error
  detail      text,                    -- short summary, never secrets
  ms          integer,
  created_at  timestamptz not null default now()
);
create index if not exists agent_runs_message_idx on public.agent_runs (message_id, created_at);

-- 5. WhatsApp users (phone → company, onboarding state) -----------------------
create table if not exists public.whatsapp_users (
  phone              text primary key,
  company_id         uuid references public.companies (id) on delete set null,
  onboarding_step    text not null default 'start',
  onboarding_data    jsonb not null default '{}'::jsonb,
  awaiting_note_for  uuid,             -- decision_id waiting for a "Change" note
  last_seen_at       timestamptz not null default now()
);

-- 6. Processed WhatsApp message ids (ignore duplicate deliveries) -------------
create table if not exists public.whatsapp_seen (
  wa_message_id  text primary key,
  created_at     timestamptz not null default now()
);

-- 7. Files the team made (flyers, catalogues, cutouts) or the owner uploaded --
create table if not exists public.files (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  decision_id  uuid references public.decisions (decision_id) on delete set null,
  kind         text not null,          -- flyer | catalogue | cutout | upload
  url          text not null,
  created_at   timestamptz not null default now()
);

-- 8. Storage bucket for files (public read, so WhatsApp can fetch images) -----
insert into storage.buckets (id, name, public)
values ('files', 'files', true)
on conflict (id) do nothing;

-- 9. Lock every table to the server only --------------------------------------
alter table public.companies      enable row level security;
alter table public.messages       enable row level security;
alter table public.decisions      enable row level security;
alter table public.agent_runs     enable row level security;
alter table public.whatsapp_users enable row level security;
alter table public.whatsapp_seen  enable row level security;
alter table public.files          enable row level security;
