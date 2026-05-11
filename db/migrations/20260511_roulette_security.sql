-- Roulette security hardening:
-- - audit log of mutating actions
-- - idempotency key storage
-- - suspicious activity marker

create table if not exists public.roulette_action_logs (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users(tg_user_id) on delete cascade,
  action text not null check (action in ('joinRound', 'raiseBet', 'spinRoulette')),
  request_id text null,
  status text not null default 'success' check (status in ('processing', 'success', 'rejected', 'error')),
  reason text null,
  suspicious boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  result_json jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_roulette_action_logs_user_created
  on public.roulette_action_logs (tg_user_id, created_at desc);

create index if not exists idx_roulette_action_logs_action_created
  on public.roulette_action_logs (action, created_at desc);

create unique index if not exists uidx_roulette_action_logs_idempotency
  on public.roulette_action_logs (tg_user_id, action, request_id)
  where request_id is not null;

alter table public.roulette_action_logs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'roulette_action_logs'
      and policyname = 'roulette_action_logs_service_role_only'
  ) then
    create policy roulette_action_logs_service_role_only
      on public.roulette_action_logs
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;

