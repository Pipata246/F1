begin;

create table if not exists public.usdt_operations (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null,
  direction text not null check (direction in ('deposit', 'withdrawal')),
  status text not null default 'pending',
  amount_usdt numeric(20, 8) not null default 0,
  ton_rate numeric(20, 8) not null default 0,
  ton_amount numeric(20, 8) not null default 0,
  fee_bps integer not null default 0,
  fee_ton numeric(20, 8) not null default 0,
  net_ton numeric(20, 8) not null default 0,
  wallet_operation_id uuid null references public.wallet_operations(id) on delete set null,
  crypto_invoice_id text null,
  crypto_transfer_id text null,
  crypto_payload text null,
  to_details text null,
  external_tx_hash text null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null
);

create unique index if not exists usdt_operations_crypto_invoice_uidx
  on public.usdt_operations (crypto_invoice_id)
  where crypto_invoice_id is not null;

create unique index if not exists usdt_operations_crypto_payload_uidx
  on public.usdt_operations (crypto_payload)
  where crypto_payload is not null;

create index if not exists usdt_operations_tg_created_idx
  on public.usdt_operations (tg_user_id, created_at desc);

alter table public.usdt_operations enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'usdt_operations'
      and policyname = 'usdt_operations_select_own'
  ) then
    create policy usdt_operations_select_own
      on public.usdt_operations
      for select
      to authenticated
      using (tg_user_id = coalesce(auth.jwt() ->> 'sub', ''));
  end if;
end $$;

commit;
