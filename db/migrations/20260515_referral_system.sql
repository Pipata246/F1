-- Referral earnings (internal balance) + welcome bonus + commission on deposits.

begin;

alter table public.users
  add column if not exists referral_balance numeric(20, 9) not null default 0,
  add column if not exists referral_welcome_granted_at timestamptz null;

create table if not exists public.referral_ledger (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users(tg_user_id) on delete cascade,
  event_type text not null check (event_type in ('deposit_commission', 'welcome_bonus', 'claim_to_balance')),
  amount numeric(20, 9) not null,
  counterparty_tg_user_id text null,
  source_key text null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists referral_ledger_source_key_uidx
  on public.referral_ledger (source_key)
  where source_key is not null;

create index if not exists referral_ledger_user_created_idx
  on public.referral_ledger (tg_user_id, created_at desc);

alter table public.referral_ledger enable row level security;

create or replace function public.referral_credit_commission(
  p_depositor_tg_id text,
  p_deposit_amount numeric,
  p_source_key text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref_code text;
  v_referrer_tg text;
  v_commission numeric(20, 9);
begin
  if p_deposit_amount is null or p_deposit_amount <= 0 then
    return 0;
  end if;
  if p_source_key is null or length(trim(p_source_key)) < 4 then
    raise exception 'Invalid referral source key';
  end if;

  if exists (select 1 from public.referral_ledger where source_key = p_source_key) then
    return 0;
  end if;

  select referred_by into v_ref_code
  from public.users
  where tg_user_id = p_depositor_tg_id;

  if v_ref_code is null or length(trim(v_ref_code)) < 2 then
    return 0;
  end if;

  select tg_user_id into v_referrer_tg
  from public.users
  where referral_code = upper(trim(v_ref_code))
  limit 1;

  if v_referrer_tg is null or v_referrer_tg = p_depositor_tg_id then
    return 0;
  end if;

  v_commission := round((p_deposit_amount * 0.05)::numeric, 9);
  if v_commission <= 0 then
    return 0;
  end if;

  update public.users
    set referral_balance = round((coalesce(referral_balance, 0) + v_commission)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_referrer_tg;

  insert into public.referral_ledger (tg_user_id, event_type, amount, counterparty_tg_user_id, source_key, meta)
  values (
    v_referrer_tg,
    'deposit_commission',
    v_commission,
    p_depositor_tg_id,
    p_source_key,
    jsonb_build_object('deposit_amount', p_deposit_amount)
  );

  return v_commission;
end;
$$;

create or replace function public.referral_grant_welcome(
  p_referred_tg_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref_code text;
  v_referrer_tg text;
  v_welcome_at timestamptz;
  v_bonus numeric(20, 9) := 0.5;
  v_source_key text;
begin
  select referred_by, referral_welcome_granted_at
    into v_ref_code, v_welcome_at
  from public.users
  where tg_user_id = p_referred_tg_id
  for update;

  if v_welcome_at is not null then
    return false;
  end if;

  if v_ref_code is null or length(trim(v_ref_code)) < 2 then
    return false;
  end if;

  select tg_user_id into v_referrer_tg
  from public.users
  where referral_code = upper(trim(v_ref_code))
  limit 1;

  if v_referrer_tg is null or v_referrer_tg = p_referred_tg_id then
    return false;
  end if;

  v_source_key := 'welcome:' || p_referred_tg_id;
  if exists (select 1 from public.referral_ledger where source_key = v_source_key) then
    update public.users
      set referral_welcome_granted_at = coalesce(referral_welcome_granted_at, now()),
          updated_at = now()
    where tg_user_id = p_referred_tg_id;
    return false;
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) + v_bonus)::numeric, 9),
        referral_welcome_granted_at = now(),
        updated_at = now()
  where tg_user_id = p_referred_tg_id;

  insert into public.referral_ledger (tg_user_id, event_type, amount, counterparty_tg_user_id, source_key, meta)
  values (p_referred_tg_id, 'welcome_bonus', v_bonus, v_referrer_tg, v_source_key, '{}'::jsonb);

  return true;
end;
$$;

create or replace function public.referral_claim_earnings(
  p_tg_user_id text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(20, 9);
  v_min numeric(20, 9) := 50;
  v_source_key text;
begin
  select referral_balance into v_balance
  from public.users
  where tg_user_id = p_tg_user_id
  for update;

  if coalesce(v_balance, 0) + 1e-12 < v_min then
    raise exception 'Minimum referral claim is 50 TON';
  end if;

  v_source_key := 'claim:' || p_tg_user_id || ':' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSUS');

  update public.users
    set balance = round((coalesce(balance, 0) + v_balance)::numeric, 9),
        referral_balance = 0,
        updated_at = now()
  where tg_user_id = p_tg_user_id;

  insert into public.referral_ledger (tg_user_id, event_type, amount, source_key, meta)
  values (p_tg_user_id, 'claim_to_balance', v_balance, v_source_key, '{}'::jsonb);

  return v_balance;
end;
$$;

commit;
