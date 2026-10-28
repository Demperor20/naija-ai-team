-- Naija AI Team — serving provider per agent call (Oct 28, 2026).
-- Run AFTER supabase/schema-v4.sql. Run once in Supabase → SQL Editor →
-- New query → Run. Safe to run again. Values: 'meta' (Meta Model API) or
-- 'baseten' (Muse Spark Open served by Baseten).
-- Until this runs, the app keeps working: the provider is simply not stored.

alter table public.agent_runs
  add column if not exists provider text;
