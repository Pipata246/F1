-- =============================================
-- F1 Duel - Full Supabase SQL (portable)
-- =============================================
-- Run this script in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null unique,
  first_name text not null default '',
  last_name text not null default '',
  username text not null default '',
  nickname text,
  referred_by text,
  referral_asked_at timestamptz,
  referral_code text unique not null,
  rules_accepted_at timestamptz not null,
  balance numeric(24, 9) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_nickname_format check (nickname is null or nickname ~ '^[A-Za-z0-9_]{3,16}$')
);

create index if not exists idx_users_tg_user_id on public.users(tg_user_id);
create index if not exists idx_users_username on public.users(username);
create unique index if not exists idx_users_referral_code_unique on public.users(referral_code);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
before update on public.users
for each row execute function public.set_updated_at();

-- Security: block direct client access by default.
alter table public.users enable row level security;

drop policy if exists "deny_all_select_users" on public.users;
create policy "deny_all_select_users"
on public.users for select
to public
using (false);

drop policy if exists "deny_all_insert_users" on public.users;
create policy "deny_all_insert_users"
on public.users for insert
to public
with check (false);

drop policy if exists "deny_all_update_users" on public.users;
create policy "deny_all_update_users"
on public.users for update
to public
using (false)
with check (false);

drop policy if exists "deny_all_delete_users" on public.users;
create policy "deny_all_delete_users"
on public.users for delete
to public
using (false);

-- Note:
-- Your serverless API uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Client-side anon key cannot read/write users table directly.

-- ---------------------------------------------
-- Migration notes for already-created table:
-- ---------------------------------------------
-- alter table public.users alter column nickname drop not null;
-- alter table public.users drop constraint if exists users_nickname_format;
-- alter table public.users
--   add constraint users_nickname_format
--   check (nickname is null or nickname ~ '^[A-Za-z0-9_]{3,16}$');
-- alter table public.users add column if not exists referral_asked_at timestamptz;
-- alter table public.users add column if not exists referral_code text;
-- create unique index if not exists idx_users_referral_code_unique on public.users(referral_code);
-- update public.users set referral_code = upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))
-- where referral_code is null;
-- alter table public.users alter column referral_code set not null;
-- Баланс: см. db/supabase_users_balance_delta.sql (колонка balance).
