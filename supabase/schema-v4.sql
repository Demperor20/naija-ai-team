-- Naija AI Team — token logging for the cost report (Oct 28, 2026).
-- Run AFTER supabase/schema-v3.sql. Run once in Supabase → SQL Editor →
-- New query → Run. Safe to run again.
-- Until this runs, the app keeps working: token columns are simply left empty.

alter table public.agent_runs
  add column if not exists input_tokens integer;
alter table public.agent_runs
  add column if not exists output_tokens integer;
