-- =============================================================================
-- Намерения пополнения (до факта зачисления в сети)
-- Выполни в Supabase SQL Editor после wallet_operations.
-- =============================================================================

create table if not exists public.deposit_intents (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null,
  declared_amount_ton numeric(24, 9) not null check (declared_amount_ton > 0),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'completed', 'expired', 'cancelled')),
  wallet_operation_id uuid references public.wallet_operations(id) on delete set null,
  ton_tx_hash text,
  submitted_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_deposit_intents_tg_status
  on public.deposit_intents(tg_user_id, status, created_at desc);

create index if not exists idx_deposit_intents_expires
  on public.deposit_intents(expires_at)
  where status = 'pending';

drop trigger if exists trg_deposit_intents_updated_at on public.deposit_intents;
create trigger trg_deposit_intents_updated_at
before update on public.deposit_intents
for each row execute function public.set_updated_at();

alter table public.deposit_intents enable row level security;

drop policy if exists "deny_all_deposit_intents" on public.deposit_intents;
create policy "deny_all_deposit_intents"
on public.deposit_intents for all
to public
using (false)
with check (false);

comment on table public.deposit_intents is
  'Сервер создаёт запись при старте пополнения; completed после wallet_credit_deposit; expired если не оплатил в срок';
