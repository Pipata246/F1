-- =============================================================================
-- F1 Duel — полная схема БД (Supabase / PostgreSQL)
-- =============================================================================
-- Собрано из всех api/*.js и db/migrations/*.sql
-- Таблицы (14): users, wallet_operations, deposit_intents, app_online_presence,
--   pvp_rooms, pvp_balance_events, game_matches, game_player_stats,
--   usdt_operations, referral_ledger,
--   roulette_rounds, roulette_bets, roulette_results, roulette_action_logs
--
-- Запуск на ПУСТОМ проекте: выполнить целиком в SQL Editor.
-- На существующей БД: скрипт идемпотентен (IF NOT EXISTS / OR REPLACE),
--   данные не удаляются. Для чистой переустановки — отдельный бэкап!
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id bigserial not null,
  tg_user_id text not null,
  first_name text not null default '',
  last_name text not null default '',
  username text not null default '',
  balance numeric(20, 9) not null default 0,
  referral_balance numeric(20, 9) not null default 0,
  referral_code text null,
  referred_by text null,
  referral_asked_at timestamptz null,
  referral_welcome_granted_at timestamptz null,
  rules_accepted_at timestamptz null,
  deposit_memo text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_pkey primary key (tg_user_id),
  constraint users_id_key unique (id)
);

create unique index if not exists users_referral_code_uidx
  on public.users (upper(referral_code))
  where referral_code is not null;

create unique index if not exists users_deposit_memo_uidx
  on public.users (deposit_memo)
  where deposit_memo is not null;

create index if not exists users_referred_by_idx
  on public.users (referred_by)
  where referred_by is not null;

-- ---------------------------------------------------------------------------
-- 2. wallet_operations
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_operations (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdrawal')),
  amount numeric(20, 9) not null check (amount > 0),
  status text not null default 'pending'
    check (status in ('pending', 'confirming', 'completed', 'failed')),
  ton_tx_hash text null,
  to_address text null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wallet_operations_ton_tx_hash_uidx
  on public.wallet_operations (ton_tx_hash)
  where ton_tx_hash is not null;

create index if not exists wallet_operations_user_created_idx
  on public.wallet_operations (tg_user_id, created_at desc);

create index if not exists wallet_operations_kind_status_idx
  on public.wallet_operations (kind, status, created_at asc);

-- ---------------------------------------------------------------------------
-- 3. deposit_intents
-- ---------------------------------------------------------------------------
create table if not exists public.deposit_intents (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  declared_amount_ton numeric(20, 9) not null check (declared_amount_ton > 0),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'completed', 'expired')),
  wallet_operation_id uuid null references public.wallet_operations (id) on delete set null,
  ton_tx_hash text null,
  meta jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  submitted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deposit_intents_user_created_idx
  on public.deposit_intents (tg_user_id, created_at desc);

create index if not exists deposit_intents_open_idx
  on public.deposit_intents (tg_user_id, status)
  where wallet_operation_id is null;

-- ---------------------------------------------------------------------------
-- 4. app_online_presence
-- ---------------------------------------------------------------------------
create table if not exists public.app_online_presence (
  tg_user_id text primary key references public.users (tg_user_id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

create index if not exists app_online_presence_last_seen_idx
  on public.app_online_presence (last_seen_at);

-- ---------------------------------------------------------------------------
-- 5. pvp_rooms
-- ---------------------------------------------------------------------------
create table if not exists public.pvp_rooms (
  id bigserial primary key,
  game_key text not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished', 'cancelled')),
  player1_tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  player1_name text not null default '',
  player2_tg_user_id text null references public.users (tg_user_id) on delete set null,
  player2_name text null,
  winner_tg_user_id text null references public.users (tg_user_id) on delete set null,
  stake_options_ton numeric[] null,
  stake_ton numeric(20, 9) null,
  stake_locked_at timestamptz null,
  stake_settled_at timestamptz null,
  state_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pvp_rooms_status_game_idx
  on public.pvp_rooms (game_key, status, created_at asc);

create index if not exists pvp_rooms_player1_idx
  on public.pvp_rooms (player1_tg_user_id, status);

create index if not exists pvp_rooms_player2_idx
  on public.pvp_rooms (player2_tg_user_id, status)
  where player2_tg_user_id is not null;

-- ---------------------------------------------------------------------------
-- 6. pvp_balance_events
-- ---------------------------------------------------------------------------
create table if not exists public.pvp_balance_events (
  id bigserial primary key,
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  room_id bigint null references public.pvp_rooms (id) on delete set null,
  game_key text null,
  event_type text not null check (event_type in ('win', 'loss', 'refund')),
  amount numeric(20, 9) not null,
  stake_ton numeric(20, 9) not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_pvp_balance_events_user_created
  on public.pvp_balance_events (tg_user_id, created_at desc);

create index if not exists idx_pvp_balance_events_room
  on public.pvp_balance_events (room_id);

create index if not exists idx_pvp_balance_events_game_key
  on public.pvp_balance_events (game_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. game_matches
-- ---------------------------------------------------------------------------
create table if not exists public.game_matches (
  id bigserial primary key,
  game_key text not null,
  server_match_id text not null,
  mode text not null default 'pvp',
  player1_tg_user_id text null references public.users (tg_user_id) on delete set null,
  player1_name text not null default 'Player',
  player2_tg_user_id text null references public.users (tg_user_id) on delete set null,
  player2_name text not null default 'Player',
  winner_tg_user_id text null references public.users (tg_user_id) on delete set null,
  score_json jsonb not null default '{}'::jsonb,
  details_json jsonb not null default '{}'::jsonb,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists game_matches_players_finished_idx
  on public.game_matches (player1_tg_user_id, finished_at desc);

create index if not exists game_matches_player2_finished_idx
  on public.game_matches (player2_tg_user_id, finished_at desc);

create index if not exists game_matches_mode_finished_idx
  on public.game_matches (mode, finished_at desc);

create unique index if not exists game_matches_server_match_id_uidx
  on public.game_matches (server_match_id);

-- ---------------------------------------------------------------------------
-- 8. game_player_stats
-- ---------------------------------------------------------------------------
create table if not exists public.game_player_stats (
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  game_key text not null,
  games_played bigint not null default 0,
  wins bigint not null default 0,
  losses bigint not null default 0,
  points_for numeric(20, 9) not null default 0,
  points_against numeric(20, 9) not null default 0,
  last_result text null check (last_result is null or last_result in ('win', 'loss')),
  last_match_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint game_player_stats_pkey primary key (tg_user_id, game_key)
);

-- ---------------------------------------------------------------------------
-- 9. usdt_operations
-- ---------------------------------------------------------------------------
create table if not exists public.usdt_operations (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  direction text not null check (direction in ('deposit', 'withdrawal')),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired')),
  amount_usdt numeric(20, 8) not null default 0,
  ton_rate numeric(20, 8) not null default 0,
  ton_amount numeric(20, 8) not null default 0,
  fee_bps integer not null default 0,
  fee_ton numeric(20, 8) not null default 0,
  net_ton numeric(20, 8) not null default 0,
  wallet_operation_id uuid null references public.wallet_operations (id) on delete set null,
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

-- ---------------------------------------------------------------------------
-- 10. referral_ledger
-- ---------------------------------------------------------------------------
create table if not exists public.referral_ledger (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  event_type text not null
    check (event_type in ('deposit_commission', 'welcome_bonus', 'claim_to_balance')),
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

-- ---------------------------------------------------------------------------
-- 11–13. Roulette
-- ---------------------------------------------------------------------------
create table if not exists public.roulette_rounds (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('waiting', 'active', 'spinning', 'finished')),
  pot_amount numeric(18, 9) not null default 0,
  timer_ends_at timestamptz null,
  winner_user_id text null references public.users (tg_user_id) on delete set null,
  winner_amount numeric(18, 9) null,
  platform_fee_percent numeric(5, 2) not null default 5.00,
  platform_fee_amount numeric(18, 9) null,
  spin_seed bigint null,
  winner_card_index integer null,
  spin_pick double precision null,
  players_count integer not null default 0,
  total_bets_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null
);

create table if not exists public.roulette_bets (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.roulette_rounds (id) on delete cascade,
  user_id text not null references public.users (tg_user_id) on delete cascade,
  bet_amount numeric(18, 9) not null check (bet_amount >= 0.1),
  chance_percent numeric(5, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_user_per_round unique (round_id, user_id)
);

create table if not exists public.roulette_results (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.roulette_rounds (id) on delete cascade,
  winner_user_id text not null references public.users (tg_user_id) on delete cascade,
  winner_amount numeric(18, 9) not null,
  total_pot numeric(18, 9) not null,
  platform_fee numeric(18, 9) not null,
  players_count integer not null,
  winner_chance_percent numeric(5, 2) not null,
  winner_display_name text null,
  winner_bet_amount numeric(18, 9) not null,
  created_at timestamptz not null default now(),
  constraint unique_result_per_round unique (round_id)
);

create index if not exists idx_roulette_rounds_status on public.roulette_rounds (status);
create index if not exists idx_roulette_rounds_created on public.roulette_rounds (created_at desc);
create index if not exists idx_roulette_rounds_finished_at on public.roulette_rounds (finished_at desc);
create index if not exists idx_roulette_rounds_winner on public.roulette_rounds (winner_user_id)
  where winner_user_id is not null;

create index if not exists idx_roulette_bets_round on public.roulette_bets (round_id);
create index if not exists idx_roulette_bets_user on public.roulette_bets (user_id);
create index if not exists idx_roulette_bets_created on public.roulette_bets (created_at desc);

create index if not exists idx_roulette_results_winner on public.roulette_results (winner_user_id);
create index if not exists idx_roulette_results_created on public.roulette_results (created_at desc);
create index if not exists idx_roulette_results_round on public.roulette_results (round_id);

-- ---------------------------------------------------------------------------
-- 14. roulette_action_logs
-- ---------------------------------------------------------------------------
create table if not exists public.roulette_action_logs (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null references public.users (tg_user_id) on delete cascade,
  action text not null check (action in ('joinRound', 'raiseBet', 'spinRoulette')),
  request_id text null,
  status text not null default 'success'
    check (status in ('processing', 'success', 'rejected', 'error')),
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

-- ---------------------------------------------------------------------------
-- Дозаполнение колонок (если таблицы уже были созданы частичными миграциями)
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists id bigserial;
alter table public.users add column if not exists referral_balance numeric(20, 9) not null default 0;
alter table public.users add column if not exists referral_welcome_granted_at timestamptz null;
alter table public.users add column if not exists deposit_memo text null;

alter table public.pvp_rooms add column if not exists stake_options_ton numeric[] null;
alter table public.pvp_rooms add column if not exists stake_ton numeric(20, 9) null;
alter table public.pvp_rooms add column if not exists stake_locked_at timestamptz null;
alter table public.pvp_rooms add column if not exists stake_settled_at timestamptz null;

alter table public.roulette_rounds add column if not exists spin_seed bigint null;
alter table public.roulette_rounds add column if not exists winner_card_index integer null;
alter table public.roulette_rounds add column if not exists spin_pick double precision null;

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
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

drop trigger if exists trg_wallet_operations_updated_at on public.wallet_operations;
create trigger trg_wallet_operations_updated_at
  before update on public.wallet_operations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_deposit_intents_updated_at on public.deposit_intents;
create trigger trg_deposit_intents_updated_at
  before update on public.deposit_intents
  for each row execute function public.set_updated_at();

drop trigger if exists trg_pvp_rooms_updated_at on public.pvp_rooms;
create trigger trg_pvp_rooms_updated_at
  before update on public.pvp_rooms
  for each row execute function public.set_updated_at();

drop trigger if exists trg_usdt_operations_updated_at on public.usdt_operations;
create trigger trg_usdt_operations_updated_at
  before update on public.usdt_operations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_roulette_action_logs_updated_at on public.roulette_action_logs;
create trigger trg_roulette_action_logs_updated_at
  before update on public.roulette_action_logs
  for each row execute function public.set_updated_at();

-- Roulette bet timestamp
create or replace function public.update_roulette_bet_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trigger_update_roulette_bet_timestamp on public.roulette_bets;
create trigger trigger_update_roulette_bet_timestamp
  before update on public.roulette_bets
  for each row execute function public.update_roulette_bet_timestamp();

-- ---------------------------------------------------------------------------
-- Wallet RPC (api/user.js, wallet-cron.js, wallet-deposit-verify.js)
-- ---------------------------------------------------------------------------
create or replace function public.wallet_credit_deposit(
  p_tg_user_id text,
  p_amount numeric,
  p_tx_hash text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_existing uuid;
  v_op_id uuid;
  v_amt numeric(20, 9);
begin
  v_uid := trim(coalesce(p_tg_user_id, ''));
  if length(v_uid) < 1 then
    raise exception 'Missing tg user id';
  end if;
  v_amt := round(coalesce(p_amount, 0)::numeric, 9);
  if v_amt <= 0 then
    raise exception 'Invalid amount';
  end if;

  if p_tx_hash is not null and length(trim(p_tx_hash)) >= 8 then
    select id into v_existing
    from public.wallet_operations
    where ton_tx_hash = trim(p_tx_hash)
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  perform 1 from public.users where tg_user_id = v_uid for update;
  if not found then
    raise exception 'User not found';
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) + v_amt)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_uid;

  insert into public.wallet_operations (
    tg_user_id, kind, amount, status, ton_tx_hash, meta
  ) values (
    v_uid, 'deposit', v_amt, 'completed',
    nullif(trim(coalesce(p_tx_hash, '')), ''),
    '{}'::jsonb
  )
  returning id into v_op_id;

  return v_op_id;
end;
$$;

create or replace function public.wallet_request_withdrawal(
  p_tg_user_id text,
  p_amount numeric,
  p_to_address text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_amt numeric(20, 9);
  v_bal numeric(20, 9);
  v_op_id uuid;
begin
  v_uid := trim(coalesce(p_tg_user_id, ''));
  if length(v_uid) < 1 then
    raise exception 'Missing tg user id';
  end if;
  v_amt := round(coalesce(p_amount, 0)::numeric, 9);
  if v_amt <= 0 then
    raise exception 'Invalid amount';
  end if;
  if coalesce(length(trim(p_to_address)), 0) < 8 then
    raise exception 'Invalid address';
  end if;

  select balance into v_bal
  from public.users
  where tg_user_id = v_uid
  for update;

  if not found then
    raise exception 'User not found';
  end if;
  if coalesce(v_bal, 0) + 1e-12 < v_amt then
    raise exception 'Insufficient balance';
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) - v_amt)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_uid;

  insert into public.wallet_operations (
    tg_user_id, kind, amount, status, to_address, meta
  ) values (
    v_uid, 'withdrawal', v_amt, 'pending',
    left(trim(p_to_address), 256),
    '{}'::jsonb
  )
  returning id into v_op_id;

  return v_op_id;
end;
$$;

create or replace function public.wallet_complete_withdrawal(
  p_op_id uuid,
  p_tx_hash text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.wallet_operations%rowtype;
begin
  select * into v_row
  from public.wallet_operations
  where id = p_op_id
  for update;

  if not found then
    return false;
  end if;
  if v_row.kind <> 'withdrawal' then
    return false;
  end if;
  if v_row.status = 'completed' then
    return true;
  end if;

  update public.wallet_operations
    set status = 'completed',
        ton_tx_hash = nullif(trim(coalesce(p_tx_hash, '')), ''),
        updated_at = now()
  where id = p_op_id;

  return true;
end;
$$;

create or replace function public.wallet_fail_withdrawal(
  p_op_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.wallet_operations%rowtype;
begin
  select * into v_row
  from public.wallet_operations
  where id = p_op_id
  for update;

  if not found then
    return false;
  end if;
  if v_row.kind <> 'withdrawal' then
    return false;
  end if;
  if v_row.status in ('completed', 'failed') then
    return v_row.status = 'failed';
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) + v_row.amount)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_row.tg_user_id;

  update public.wallet_operations
    set status = 'failed',
        updated_at = now()
  where id = p_op_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- PvP stakes (stakes: 0.1, 0.5, 1, 5, 10, 25 TON — api/user.js)
-- ---------------------------------------------------------------------------
create or replace function public.pvp_join_waiting_with_stake(
  p_room_id bigint,
  p_player2_tg_user_id text,
  p_player2_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_p1_balance numeric(20, 9);
  v_p2_balance numeric(20, 9);
begin
  if p_stake_ton not in (0.1, 0.5, 1, 5, 10, 25) then
    raise exception 'Invalid stake';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return null; end if;
  if v_room.status <> 'waiting' or v_room.player2_tg_user_id is not null then return null; end if;
  if coalesce(v_room.player1_tg_user_id, '') = coalesce(p_player2_tg_user_id, '') then return null; end if;
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0
     and not (p_stake_ton = any (v_room.stake_options_ton)) then
    raise exception 'No common stake';
  end if;

  select balance into v_p1_balance from public.users where tg_user_id = v_room.player1_tg_user_id for update;
  if not found then raise exception 'User not found'; end if;

  select balance into v_p2_balance from public.users where tg_user_id = p_player2_tg_user_id for update;
  if not found then raise exception 'User not found'; end if;

  if coalesce(v_p1_balance, 0) < p_stake_ton or coalesce(v_p2_balance, 0) < p_stake_ton then
    raise exception 'Insufficient balance for selected stakes';
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) - p_stake_ton)::numeric, 9),
        updated_at = now()
  where tg_user_id in (v_room.player1_tg_user_id, p_player2_tg_user_id);

  update public.pvp_rooms
    set player2_tg_user_id = p_player2_tg_user_id,
        player2_name = left(coalesce(p_player2_name, ''), 64),
        status = 'active',
        stake_ton = p_stake_ton,
        stake_locked_at = now(),
        state_json = coalesce(p_state_json, '{}'::jsonb),
        updated_at = now()
  where id = p_room_id;

  return p_room_id;
end;
$$;

create or replace function public.pvp_finalize_stake(
  p_room_id bigint,
  p_winner_tg_user_id text default null,
  p_reason text default 'match_finished'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_stake numeric(20, 9);
  v_winner text;
  v_loser text;
begin
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return false; end if;
  if v_room.stake_settled_at is not null then return true; end if;

  v_stake := coalesce(v_room.stake_ton, 0);
  if v_stake <= 0 then
    update public.pvp_rooms set stake_settled_at = now(), updated_at = now() where id = p_room_id;
    return true;
  end if;

  if p_winner_tg_user_id is not null
     and p_winner_tg_user_id in (v_room.player1_tg_user_id, v_room.player2_tg_user_id) then
    v_winner := p_winner_tg_user_id;
    v_loser := case
      when v_winner = v_room.player1_tg_user_id then v_room.player2_tg_user_id
      else v_room.player1_tg_user_id
    end;

    update public.users
      set balance = round((coalesce(balance, 0) + v_stake * 2)::numeric, 9),
          updated_at = now()
    where tg_user_id = v_winner;

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values
      (v_winner, v_room.id, v_room.game_key, 'win', v_stake, v_stake,
       jsonb_build_object('reason', coalesce(p_reason, 'match_finished'),
         'text', format('Победа в матче +%s TON', v_stake))),
      (v_loser, v_room.id, v_room.game_key, 'loss', -v_stake, v_stake,
       jsonb_build_object('reason', coalesce(p_reason, 'match_finished'),
         'text', format('Поражение в матче -%s TON', v_stake)));
  else
    update public.users
      set balance = round((coalesce(balance, 0) + v_stake)::numeric, 9),
          updated_at = now()
    where tg_user_id in (v_room.player1_tg_user_id, v_room.player2_tg_user_id);

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values
      (v_room.player1_tg_user_id, v_room.id, v_room.game_key, 'refund', v_stake, v_stake,
       jsonb_build_object('reason', coalesce(p_reason, 'match_finished'),
         'text', format('Возврат ставки +%s TON', v_stake))),
      (v_room.player2_tg_user_id, v_room.id, v_room.game_key, 'refund', v_stake, v_stake,
       jsonb_build_object('reason', coalesce(p_reason, 'match_finished'),
         'text', format('Возврат ставки +%s TON', v_stake)));
  end if;

  update public.pvp_rooms
    set stake_settled_at = now(), updated_at = now()
  where id = p_room_id;

  return true;
end;
$$;

create or replace function public.pvp_start_bot_match_with_stake(
  p_room_id bigint,
  p_bot_tg_user_id text,
  p_bot_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_balance numeric(20, 9);
begin
  if p_stake_ton not in (0.1, 0.5, 1, 5, 10, 25) then
    raise exception 'Invalid stake';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return null; end if;
  if v_room.status <> 'waiting' or v_room.player2_tg_user_id is not null then return null; end if;
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0
     and not (p_stake_ton = any (v_room.stake_options_ton)) then
    raise exception 'No common stake';
  end if;

  select balance into v_balance
  from public.users
  where tg_user_id = v_room.player1_tg_user_id
  for update;

  if not found then raise exception 'User not found'; end if;
  if coalesce(v_balance, 0) < p_stake_ton then
    raise exception 'Insufficient balance for selected stakes';
  end if;

  update public.users
    set balance = round((coalesce(balance, 0) - p_stake_ton)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_room.player1_tg_user_id;

  update public.pvp_rooms
    set player2_tg_user_id = left(coalesce(p_bot_tg_user_id, ''), 64),
        player2_name = left(coalesce(p_bot_name, ''), 64),
        status = 'active',
        stake_ton = p_stake_ton,
        stake_locked_at = now(),
        state_json = coalesce(p_state_json, '{}'::jsonb),
        updated_at = now()
  where id = p_room_id;

  return p_room_id;
end;
$$;

create or replace function public.pvp_finalize_bot_stake(
  p_room_id bigint,
  p_user_tg_user_id text,
  p_user_won boolean default false,
  p_reason text default 'match_finished'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_stake numeric(20, 9);
begin
  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return false; end if;
  if v_room.stake_settled_at is not null then return true; end if;

  v_stake := coalesce(v_room.stake_ton, 0);
  if v_stake <= 0 then
    update public.pvp_rooms set stake_settled_at = now(), updated_at = now() where id = p_room_id;
    return true;
  end if;

  if p_user_won then
    update public.users
      set balance = round((coalesce(balance, 0) + v_stake * 2)::numeric, 9),
          updated_at = now()
    where tg_user_id = p_user_tg_user_id;

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values (
      p_user_tg_user_id, v_room.id, v_room.game_key, 'win', v_stake, v_stake,
      jsonb_build_object(
        'reason', coalesce(p_reason, 'match_finished'),
        'text', format('Победа в матче +%s TON', v_stake),
        'botFallback', true
      )
    );
  else
    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values (
      p_user_tg_user_id, v_room.id, v_room.game_key, 'loss', -v_stake, v_stake,
      jsonb_build_object(
        'reason', coalesce(p_reason, 'match_finished'),
        'text', format('Поражение в матче -%s TON', v_stake),
        'botFallback', true
      )
    );
  end if;

  update public.pvp_rooms
    set stake_settled_at = now(), updated_at = now()
  where id = p_room_id;

  return true;
end;
$$;

-- PvP anti-cheat state filter (frog_hunt, super_penalty, obstacle_race, basketball)
create or replace function public.pvp_get_filtered_room_state(
  p_room_id bigint,
  p_tg_user_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_state jsonb;
  v_side text;
  v_game_key text;
  v_opponent_side text;
  v_phase text;
  v_pending jsonb;
  v_my_role text;
  v_choices jsonb;
  v_traps jsonb;
  v_overtime_traps jsonb;
  v_pending_moves jsonb;
begin
  select * into v_room from public.pvp_rooms where id = p_room_id;
  if not found then
    raise exception 'Room not found';
  end if;

  if v_room.player1_tg_user_id <> p_tg_user_id
     and v_room.player2_tg_user_id <> p_tg_user_id then
    raise exception 'Access denied';
  end if;

  v_state := coalesce(v_room.state_json, '{}'::jsonb);
  v_game_key := coalesce(v_room.game_key, '');

  if v_room.player1_tg_user_id = p_tg_user_id then
    v_side := 'p1';
  else
    v_side := 'p2';
  end if;

  v_opponent_side := case when v_side = 'p1' then 'p2' else 'p1' end;

  if v_game_key = 'frog_hunt' then
    v_my_role := v_state -> 'roles' ->> v_side;
    if (v_state ->> 'phase') = 'turn_input' then
      v_pending := coalesce(v_state -> 'pending', '{}'::jsonb);
      if v_my_role = 'hunter' then
        v_pending := jsonb_build_object(
          'frogCell', null,
          'hunterCells', coalesce(v_pending -> 'hunterCells', '[]'::jsonb)
        );
      elsif v_my_role = 'frog' then
        v_pending := jsonb_build_object(
          'frogCell', v_pending -> 'frogCell',
          'hunterCells', '[]'::jsonb
        );
      end if;
      v_state := jsonb_set(v_state, '{pending}', v_pending);
    end if;

  elsif v_game_key = 'super_penalty' then
    v_phase := coalesce(v_state ->> 'phase', '');
    if v_phase = 'turn_input' then
      v_choices := coalesce(v_state -> 'choices', '{}'::jsonb);
      v_choices := jsonb_build_object(
        v_side, coalesce(v_choices -> v_side, 'null'::jsonb),
        v_opponent_side, 'null'::jsonb
      );
      v_state := jsonb_set(v_state, '{choices}', v_choices);
    end if;

  elsif v_game_key = 'obstacle_race' then
    v_phase := coalesce(v_state ->> 'phase', '');
    if v_phase = 'placing_traps' then
      v_traps := coalesce(v_state -> 'traps', '{}'::jsonb);
      v_traps := jsonb_build_object(
        v_side, coalesce(v_traps -> v_side, 'null'::jsonb),
        v_opponent_side, 'null'::jsonb
      );
      v_state := jsonb_set(v_state, '{traps}', v_traps);
    end if;
    if v_phase = 'overtime_placing' then
      v_overtime_traps := coalesce(v_state -> 'overtimeTraps', '{}'::jsonb);
      v_overtime_traps := jsonb_build_object(
        v_side, coalesce(v_overtime_traps -> v_side, 'null'::jsonb),
        v_opponent_side, 'null'::jsonb
      );
      v_state := jsonb_set(v_state, '{overtimeTraps}', v_overtime_traps);
    end if;
    if v_phase = 'running' then
      v_pending_moves := coalesce(v_state -> 'pendingMoves', '{}'::jsonb);
      v_pending_moves := jsonb_build_object(
        v_side, coalesce(v_pending_moves -> v_side, 'null'::jsonb),
        v_opponent_side, 'null'::jsonb
      );
      v_state := jsonb_set(v_state, '{pendingMoves}', v_pending_moves);
    end if;

  elsif v_game_key = 'basketball' then
    v_phase := coalesce(v_state ->> 'phase', '');
    if v_phase = 'turn_input' then
      v_choices := coalesce(v_state -> 'choices', '{}'::jsonb);
      v_choices := jsonb_build_object(
        v_side, coalesce(v_choices -> v_side, 'null'::jsonb),
        v_opponent_side, 'null'::jsonb
      );
      v_state := jsonb_set(v_state, '{choices}', v_choices);
    end if;
  end if;

  return v_state;
end;
$$;

-- ---------------------------------------------------------------------------
-- Referral RPC (api/referral.js)
-- ---------------------------------------------------------------------------
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
  if p_deposit_amount is null or p_deposit_amount <= 0 then return 0; end if;
  if p_source_key is null or length(trim(p_source_key)) < 4 then
    raise exception 'Invalid referral source key';
  end if;
  if exists (select 1 from public.referral_ledger where source_key = p_source_key) then
    return 0;
  end if;

  select referred_by into v_ref_code from public.users where tg_user_id = p_depositor_tg_id;
  if v_ref_code is null or length(trim(v_ref_code)) < 2 then return 0; end if;

  select tg_user_id into v_referrer_tg
  from public.users
  where referral_code = upper(trim(v_ref_code))
  limit 1;

  if v_referrer_tg is null or v_referrer_tg = p_depositor_tg_id then return 0; end if;

  v_commission := round((p_deposit_amount * 0.05)::numeric, 9);
  if v_commission <= 0 then return 0; end if;

  update public.users
    set referral_balance = round((coalesce(referral_balance, 0) + v_commission)::numeric, 9),
        updated_at = now()
  where tg_user_id = v_referrer_tg;

  insert into public.referral_ledger (
    tg_user_id, event_type, amount, counterparty_tg_user_id, source_key, meta
  ) values (
    v_referrer_tg, 'deposit_commission', v_commission, p_depositor_tg_id, p_source_key,
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

  if v_welcome_at is not null then return false; end if;
  if v_ref_code is null or length(trim(v_ref_code)) < 2 then return false; end if;

  select tg_user_id into v_referrer_tg
  from public.users
  where referral_code = upper(trim(v_ref_code))
  limit 1;

  if v_referrer_tg is null or v_referrer_tg = p_referred_tg_id then return false; end if;

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

  insert into public.referral_ledger (
    tg_user_id, event_type, amount, counterparty_tg_user_id, source_key, meta
  ) values (
    p_referred_tg_id, 'welcome_bonus', v_bonus, v_referrer_tg, v_source_key, '{}'::jsonb
  );

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

  v_source_key := 'claim:' || p_tg_user_id || ':' ||
    to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSUS');

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

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.wallet_operations enable row level security;
alter table public.deposit_intents enable row level security;
alter table public.app_online_presence enable row level security;
alter table public.pvp_rooms enable row level security;
alter table public.pvp_balance_events enable row level security;
alter table public.game_matches enable row level security;
alter table public.game_player_stats enable row level security;
alter table public.usdt_operations enable row level security;
alter table public.referral_ledger enable row level security;
alter table public.roulette_rounds enable row level security;
alter table public.roulette_bets enable row level security;
alter table public.roulette_results enable row level security;
alter table public.roulette_action_logs enable row level security;

-- users: service role full access
drop policy if exists users_service_role_all on public.users;
create policy users_service_role_all on public.users
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- wallet / deposits: service role only (API uses service_role key)
drop policy if exists wallet_operations_service_role_only on public.wallet_operations;
create policy wallet_operations_service_role_only on public.wallet_operations
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists deposit_intents_service_role_only on public.deposit_intents;
create policy deposit_intents_service_role_only on public.deposit_intents
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists app_online_presence_service_role_only on public.app_online_presence;
create policy app_online_presence_service_role_only on public.app_online_presence
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- pvp_rooms
drop policy if exists pvp_rooms_players_read on public.pvp_rooms;
create policy pvp_rooms_players_read on public.pvp_rooms
  for select using (
    auth.role() = 'service_role'
    or player1_tg_user_id = coalesce(auth.jwt() ->> 'sub', '')
    or player2_tg_user_id = coalesce(auth.jwt() ->> 'sub', '')
  );

drop policy if exists pvp_rooms_service_only on public.pvp_rooms;
create policy pvp_rooms_service_only on public.pvp_rooms
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists pvp_balance_events_service_role_only on public.pvp_balance_events;
create policy pvp_balance_events_service_role_only on public.pvp_balance_events
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- game tables: service role writes
drop policy if exists game_matches_service_role_only on public.game_matches;
create policy game_matches_service_role_only on public.game_matches
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists game_player_stats_service_role_only on public.game_player_stats;
create policy game_player_stats_service_role_only on public.game_player_stats
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- usdt
drop policy if exists usdt_operations_select_own on public.usdt_operations;
create policy usdt_operations_select_own on public.usdt_operations
  for select to authenticated
  using (tg_user_id = coalesce(auth.jwt() ->> 'sub', ''));

drop policy if exists usdt_operations_service_role_only on public.usdt_operations;
create policy usdt_operations_service_role_only on public.usdt_operations
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- referral
drop policy if exists referral_ledger_service_role_only on public.referral_ledger;
create policy referral_ledger_service_role_only on public.referral_ledger
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- roulette: public read, service write
drop policy if exists "Anyone can view rounds" on public.roulette_rounds;
create policy "Anyone can view rounds" on public.roulette_rounds for select using (true);

drop policy if exists "Anyone can view bets" on public.roulette_bets;
create policy "Anyone can view bets" on public.roulette_bets for select using (true);

drop policy if exists "Anyone can view results" on public.roulette_results;
create policy "Anyone can view results" on public.roulette_results for select using (true);

drop policy if exists "Service role can manage rounds" on public.roulette_rounds;
create policy "Service role can manage rounds" on public.roulette_rounds
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "Service role can manage bets" on public.roulette_bets;
create policy "Service role can manage bets" on public.roulette_bets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "Service role can manage results" on public.roulette_results;
create policy "Service role can manage results" on public.roulette_results
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists roulette_action_logs_service_role_only on public.roulette_action_logs;
create policy roulette_action_logs_service_role_only on public.roulette_action_logs
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Grants (Supabase)
-- ---------------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;

grant all on all tables in schema public to postgres, service_role;
grant select on all tables in schema public to anon, authenticated;

grant usage, select on all sequences in schema public to postgres, service_role;

grant execute on all functions in schema public to postgres, service_role;

comment on column public.roulette_rounds.spin_pick is
  'Uniform draw in [0,1) on cumulative chance ring; winner + UI pointer must use this value only.';

commit;

-- =============================================================================
-- Готово. Проверка:
--   select tablename from pg_tables where schemaname = 'public' order by 1;
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and proname like any (array[
--       'wallet_%','pvp_%','referral_%','set_updated_at','update_roulette_bet_timestamp'
--     ]) order by 1;
-- =============================================================================
