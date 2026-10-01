-- ============================================================================
-- Shift Handover · EOS Bench Audit — Supabase schema
-- ----------------------------------------------------------------------------
-- Run this once in your Supabase project's SQL Editor (Project -> SQL Editor
-- -> New query -> paste this whole file -> Run). It creates everything the
-- app needs: three tables, a public storage bucket for photos, and row-level
-- security policies that let anyone with the site's link read and write data
-- using the public "anon" key.
--
-- Security note (same trade-off as the Picking & Packing Audits Board):
-- there are no user accounts. Anyone who opens the site's URL can log a
-- handover or bench audit. Editing the checklist topics and clearing all
-- data are gated behind a shared passcode, but that gate lives in the
-- browser page, not the database — it deters casual tampering, it does not
-- enforce it. If that's ever a problem, the fix is to add Supabase Auth and
-- tighten these RLS policies to require a signed-in user; this schema keeps
-- things simple to match how the Picking & Packing board is set up.
-- ============================================================================

-- ---------- handover_entries ----------
-- One row per "Save handover" click for inbound/pick/pack/despatch. Each row
-- is a snapshot of that department's checklist at the moment it was saved;
-- the form clears itself afterwards so the next entry starts fresh. The
-- "pick" department additionally carries an "Overall pick condition" answer.
create table if not exists public.handover_entries (
  id          text primary key,
  date        date not null,
  shift       text not null check (shift in ('AM','PM','NS')),
  area        text not null check (area in ('inbound','pick','pack','despatch')),
  topics      jsonb not null default '[]'::jsonb,   -- [{ label, note }, ...]
  condition   jsonb,                                 -- { answer, note, photos: [{path}] } — pick only
  given_by    text default '',
  received_by text default '',
  created_at  timestamptz not null default now()
);
create index if not exists handover_entries_date_shift_area_idx
  on public.handover_entries (date, shift, area);

-- ---------- bench_audits ----------
-- One row per "Save audit & start new" click on the EOS Bench Audit tab.
create table if not exists public.bench_audits (
  id          text primary key,
  date        date not null,
  shift       text not null check (shift in ('AM','PM','NS')),
  bench       text default '',
  auditor     text default '',
  op_id       text default '',
  answers     jsonb not null default '[]'::jsonb,   -- [{ label, result, note, photos:[{path}] }, ...]
  given_by    text default '',   -- unused — bench audits no longer collect a handover signoff; kept for compatibility
  received_by text default '',   -- unused — see given_by
  created_at  timestamptz not null default now()
);
create index if not exists bench_audits_date_shift_idx
  on public.bench_audits (date, shift);

-- ---------- checklist_topics ----------
-- The editable master checklist per handover department (Edit checklist
-- topics, passcode-gated). One row per area; falls back to the app's
-- built-in defaults until a row exists.
create table if not exists public.checklist_topics (
  area        text primary key check (area in ('inbound','pick','pack','despatch')),
  topics      jsonb not null default '[]'::jsonb,   -- ["question text", ...]
  updated_at  timestamptz not null default now()
);

-- ---------- Row Level Security ----------
alter table public.handover_entries enable row level security;
alter table public.bench_audits     enable row level security;
alter table public.checklist_topics enable row level security;

drop policy if exists "anon full access" on public.handover_entries;
create policy "anon full access" on public.handover_entries
  for all to anon using (true) with check (true);

drop policy if exists "anon full access" on public.bench_audits;
create policy "anon full access" on public.bench_audits
  for all to anon using (true) with check (true);

drop policy if exists "anon full access" on public.checklist_topics;
create policy "anon full access" on public.checklist_topics
  for all to anon using (true) with check (true);

-- ---------- Realtime ----------
-- Lets every open tab see new/edited/cleared entries live, the same way the
-- Picking & Packing board syncs across devices.
alter publication supabase_realtime add table public.handover_entries;
alter publication supabase_realtime add table public.bench_audits;
alter publication supabase_realtime add table public.checklist_topics;

-- ---------- Storage: photo evidence ----------
-- Public bucket so uploaded photos (pick condition, bench cleanliness) can
-- be shown with a plain public URL, same as the Picking & Packing board.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists "public read photos" on storage.objects;
create policy "public read photos" on storage.objects
  for select to anon using (bucket_id = 'photos');

drop policy if exists "anon upload photos" on storage.objects;
create policy "anon upload photos" on storage.objects
  for insert to anon with check (bucket_id = 'photos');

drop policy if exists "anon delete photos" on storage.objects;
create policy "anon delete photos" on storage.objects
  for delete to anon using (bucket_id = 'photos');
