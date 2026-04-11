-- =============================================================================
-- F1 Duel — установка кошелька TON (Supabase)
-- =============================================================================
--
-- Когда выполнять: один раз, когда таблица public.users УЖЕ существует
-- и колонка users.balance УЖЕ есть (как у вас).
--
-- Этот файл НЕ добавляет колонку balance — только deposit_memo, wallet_operations
-- и функции RPC для сервера (service_role).
--
-- Порядок: SQL Editor → вставить весь файл → Run.
-- Если ошибка про set_updated_at — блок ниже создаст функцию.
--
-- =============================================================================

create extension if not exists pgcrypto;

-- Триггер wallet_operations ссылается на эту функцию (часто уже есть от users).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Пользователь: уникальный memo для входящих переводов (комментарий в TON)
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists deposit_memo text;

create unique index if not exists idx_users_deposit_memo_unique
  on public.users(deposit_memo)
  where deposit_memo is not null;

comment on column public.users.deposit_memo is
  'Уникальный тег для входящих TON (комментарий к переводу в кошельке)';

-- ---------------------------------------------------------------------------
-- История операций (читает/пишет только бэкенд через service_role; RLS закрыт)
-- ---------------------------------------------------------------------------

create table if not exists public.wallet_operations (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null,
  kind text not null check (kind in ('deposit', 'withdrawal')),
  amount numeric(24, 9) not null check (amount > 0),
  status text not null default 'pending'
    check (status in ('pending', 'confirming', 'completed', 'failed', 'cancelled')),
  asset text not null default 'TON',
  ton_tx_hash text,
  to_address text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wallet_ops_tg_created
  on public.wallet_operations(tg_user_id, created_at desc);

create unique index if not exists idx_wallet_ops_tx_hash_unique
  on public.wallet_operations(ton_tx_hash)
  where ton_tx_hash is not null and ton_tx_hash <> '';

drop trigger if exists trg_wallet_operations_updated_at on public.wallet_operations;
create trigger trg_wallet_operations_updated_at
before update on public.wallet_operations
for each row execute function public.set_updated_at();

alter table public.wallet_operations enable row level security;

drop policy if exists "deny_all_wallet_operations" on public.wallet_operations;
create policy "deny_all_wallet_operations"
on public.wallet_operations for all
to public
using (false)
with check (false);

-- ---------------------------------------------------------------------------
-- RPC: заявка на вывод (атомарно balance -= amount + строка withdrawal pending)
-- ---------------------------------------------------------------------------

create or replace function public.wallet_request_withdrawal(
  p_tg_user_id text,
  p_amount numeric,
  p_to_address text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_bal numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Invalid amount';
  end if;
  if p_to_address is null or length(trim(p_to_address)) < 10 then
    raise exception 'Invalid address';
  end if;

  select balance into v_bal
  from public.users
  where tg_user_id = p_tg_user_id
  for update;

  if not found then
    raise exception 'User not found';
  end if;

  if v_bal < p_amount then
    raise exception 'Insufficient balance';
  end if;

  update public.users
  set balance = balance - p_amount,
      updated_at = now()
  where tg_user_id = p_tg_user_id;

  insert into public.wallet_operations (
    tg_user_id, kind, amount, status, to_address
  ) values (
    p_tg_user_id, 'withdrawal', p_amount, 'pending', trim(p_to_address)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: зачисление депозита (только бэкенд/cron после подтверждения tx в сети)
-- ---------------------------------------------------------------------------

create or replace function public.wallet_credit_deposit(
  p_tg_user_id text,
  p_amount numeric,
  p_tx_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Invalid amount';
  end if;
  if p_tx_hash is null or length(trim(p_tx_hash)) < 8 then
    raise exception 'Invalid tx hash';
  end if;

  select id into v_existing
  from public.wallet_operations
  where ton_tx_hash = trim(p_tx_hash)
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  update public.users
  set balance = balance + p_amount,
      updated_at = now()
  where tg_user_id = p_tg_user_id;

  if not found then
    raise exception 'User not found';
  end if;

  insert into public.wallet_operations (
    tg_user_id, kind, amount, status, ton_tx_hash
  ) values (
    p_tg_user_id, 'deposit', p_amount, 'completed', trim(p_tx_hash)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: вывод отправлен в сеть
-- ---------------------------------------------------------------------------

create or replace function public.wallet_complete_withdrawal(
  p_op_id uuid,
  p_tx_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_tx_hash is null or length(trim(p_tx_hash)) < 8 then
    raise exception 'Invalid tx hash';
  end if;

  update public.wallet_operations
  set status = 'completed',
      ton_tx_hash = trim(p_tx_hash),
      updated_at = now()
  where id = p_op_id
    and kind = 'withdrawal'
    and status = 'pending';

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: отмена вывода — вернуть сумму на balance
-- ---------------------------------------------------------------------------

create or replace function public.wallet_fail_withdrawal(p_op_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select id, tg_user_id, amount, status into r
  from public.wallet_operations
  where id = p_op_id and kind = 'withdrawal'
  for update;

  if not found then
    return false;
  end if;
  if r.status <> 'pending' then
    return false;
  end if;

  update public.users
  set balance = balance + r.amount,
      updated_at = now()
  where tg_user_id = r.tg_user_id;

  update public.wallet_operations
  set status = 'failed',
      updated_at = now()
  where id = p_op_id;

  return true;
end;
$$;

-- Только service_role (ключ с бэкенда Vercel), не anon.
grant execute on function public.wallet_request_withdrawal(text, numeric, text) to service_role;
grant execute on function public.wallet_credit_deposit(text, numeric, text) to service_role;
grant execute on function public.wallet_complete_withdrawal(uuid, text) to service_role;
grant execute on function public.wallet_fail_withdrawal(uuid) to service_role;

-- =============================================================================
-- Готово. Дальше: переменные окружения на Vercel + см. docs/WALLET_AND_TESTING.md
-- =============================================================================
