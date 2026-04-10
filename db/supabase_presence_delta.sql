-- Online presence for TMA hub counter (run in Supabase SQL Editor if not applied yet).
-- Semantics: a row means the user is considered online; API deletes the row on presenceLeave and on stale prune.

create table if not exists public.app_online_presence (
  tg_user_id text primary key,
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_app_online_presence_last_seen
  on public.app_online_presence (last_seen_at desc);

alter table public.app_online_presence enable row level security;

drop policy if exists "deny_all_select_app_online_presence" on public.app_online_presence;
create policy "deny_all_select_app_online_presence"
on public.app_online_presence for select
to public
using (false);

drop policy if exists "deny_all_insert_app_online_presence" on public.app_online_presence;
create policy "deny_all_insert_app_online_presence"
on public.app_online_presence for insert
to public
with check (false);

drop policy if exists "deny_all_update_app_online_presence" on public.app_online_presence;
create policy "deny_all_update_app_online_presence"
on public.app_online_presence for update
to public
using (false)
with check (false);

drop policy if exists "deny_all_delete_app_online_presence" on public.app_online_presence;
create policy "deny_all_delete_app_online_presence"
on public.app_online_presence for delete
to public
using (false);
