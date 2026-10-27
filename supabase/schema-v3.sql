-- Naija AI Team — database additions for media, books, catalogue and videos (Oct 27, 2026).
-- Run AFTER supabase/schema.sql. Run once in Supabase → SQL Editor → New query → Run. Safe to run again.

-- 1. Proposals carry a type and the exact data to apply when approved ---------
alter table public.decisions add column if not exists kind text not null default 'general';
  -- general | ledger | product | flyer | video | catalogue | statement
alter table public.decisions add column if not exists payload jsonb not null default '{}'::jsonb;
  -- e.g. {"entries":[...]} for ledger, {"product_ids":[...]} for product, {"file_id":"..."} for flyer/video
alter table public.decisions add column if not exists applied_at timestamptz;

-- 2. Files: what kind, who made it, which message it came from ----------------
alter table public.files add column if not exists mime text;
alter table public.files add column if not exists made_by text not null default 'owner';  -- owner | team
alter table public.files add column if not exists message_id uuid references public.messages (id) on delete set null;
alter table public.files add column if not exists meta jsonb not null default '{}'::jsonb; -- size, duration, width, height
  -- files.kind values now: upload | audio | photo | video | cutout | flyer | catalogue | marketing_video | statement

-- 3. Books: every sale, cost and debt, each linked to the photo or voice note it came from
create table if not exists public.ledger_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  decision_id      uuid references public.decisions (decision_id) on delete set null,
  source_file_id   uuid references public.files (id) on delete set null,
  source_message_id uuid references public.messages (id) on delete set null,
  entry_date       date not null default current_date,
  kind             text not null check (kind in ('sale', 'expense', 'debt_given', 'debt_paid', 'stock_in')),
  item             text,
  quantity         numeric,
  unit_price       numeric,
  amount           numeric not null check (amount >= 0),   -- naira
  counterparty     text,                                    -- customer or supplier name
  payment_method   text,                                    -- cash | transfer | pos | credit
  confidence       numeric check (confidence between 0 and 1), -- how sure the model was when reading it
  status           text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  created_at       timestamptz not null default now()
);
create index if not exists ledger_company_date_idx
  on public.ledger_entries (company_id, status, entry_date desc);

-- 4. Products: the catalogue ---------------------------------------------------
create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  name            text not null,
  description     text,
  price           numeric check (price >= 0),          -- naira; null until the owner gives it
  photo_file_id   uuid references public.files (id) on delete set null,
  cutout_file_id  uuid references public.files (id) on delete set null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at      timestamptz not null default now()
);
create index if not exists products_company_idx on public.products (company_id, status, created_at desc);

-- 5. Media jobs: long tasks (video, catalogue) run step by step --------------
create table if not exists public.media_jobs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  kind        text not null,      -- transcribe | cutout | catalogue | flyer | marketing_video | statement
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  input       jsonb not null default '{}'::jsonb,
  output      jsonb not null default '{}'::jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists media_jobs_company_idx on public.media_jobs (company_id, status, created_at desc);

-- 6. Simple views for the dashboard and the statement -------------------------
create or replace view public.ledger_daily as
  select company_id,
         entry_date,
         coalesce(sum(amount) filter (where kind = 'sale'), 0)    as sales,
         coalesce(sum(amount) filter (where kind = 'expense'), 0) as expenses,
         coalesce(sum(amount) filter (where kind = 'sale'), 0)
           - coalesce(sum(amount) filter (where kind = 'expense'), 0) as profit
  from public.ledger_entries
  where status = 'confirmed'
  group by company_id, entry_date;

create or replace view public.who_owes_me as
  select company_id,
         counterparty,
         coalesce(sum(amount) filter (where kind = 'debt_given'), 0)
           - coalesce(sum(amount) filter (where kind = 'debt_paid'), 0) as balance
  from public.ledger_entries
  where status = 'confirmed' and counterparty is not null
  group by company_id, counterparty;

-- 7. Lock the new tables to the server only ------------------------------------
alter table public.ledger_entries enable row level security;
alter table public.products       enable row level security;
alter table public.media_jobs     enable row level security;
-- Views run with their owner's rights; never expose them through the public API.
revoke all on public.ledger_daily from anon, authenticated;
revoke all on public.who_owes_me  from anon, authenticated;
