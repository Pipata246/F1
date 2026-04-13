-- TON stakes for PvP matchmaking, secure balance settlement, and wallet history events.

alter table if exists public.pvp_rooms
  add column if not exists stake_options_ton numeric[] default null,
  add column if not exists stake_ton numeric(20,9) default null,
  add column if not exists stake_locked_at timestamptz default null,
  add column if not exists stake_settled_at timestamptz default null;

create table if not exists public.pvp_balance_events (
  id bigserial primary key,
  tg_user_id text not null,
  room_id bigint null,
  game_key text null,
  event_type text not null check (event_type in ('win', 'loss', 'refund')),
  amount numeric(20,9) not null,
  stake_ton numeric(20,9) not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_pvp_balance_events_user_created
  on public.pvp_balance_events (tg_user_id, created_at desc);

create index if not exists idx_pvp_balance_events_room
  on public.pvp_balance_events (room_id);

alter table if exists public.pvp_balance_events enable row level security;

drop policy if exists pvp_balance_events_service_role_only on public.pvp_balance_events;
create policy pvp_balance_events_service_role_only
  on public.pvp_balance_events
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.pvp_join_waiting_with_stake(
  p_room_id bigint,
  p_player2_tg_user_id text,
  p_player2_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_p1_balance numeric(20,9);
  v_p2_balance numeric(20,9);
begin
  if p_stake_ton not in (1, 5, 10, 25, 50, 100) then
    raise exception 'Invalid stake';
  end if;

  select *
    into v_room
  from public.pvp_rooms
  where id = p_room_id
  for update;

  if not found then
    return null;
  end if;
  if v_room.status <> 'waiting' or v_room.player2_tg_user_id is not null then
    return null;
  end if;
  if coalesce(v_room.player1_tg_user_id, '') = coalesce(p_player2_tg_user_id, '') then
    return null;
  end if;
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0 and not (p_stake_ton = any(v_room.stake_options_ton)) then
    raise exception 'No common stake';
  end if;

  select balance
    into v_p1_balance
  from public.users
  where tg_user_id = v_room.player1_tg_user_id
  for update;
  if not found then
    raise exception 'User not found';
  end if;

  select balance
    into v_p2_balance
  from public.users
  where tg_user_id = p_player2_tg_user_id
  for update;
  if not found then
    raise exception 'User not found';
  end if;

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
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_stake numeric(20,9);
  v_winner text;
  v_loser text;
begin
  select *
    into v_room
  from public.pvp_rooms
  where id = p_room_id
  for update;

  if not found then
    return false;
  end if;
  if v_room.stake_settled_at is not null then
    return true;
  end if;

  v_stake := coalesce(v_room.stake_ton, 0);
  if v_stake <= 0 then
    update public.pvp_rooms set stake_settled_at = now(), updated_at = now() where id = p_room_id;
    return true;
  end if;

  if p_winner_tg_user_id is not null
     and p_winner_tg_user_id in (v_room.player1_tg_user_id, v_room.player2_tg_user_id) then
    v_winner := p_winner_tg_user_id;
    v_loser := case when v_winner = v_room.player1_tg_user_id then v_room.player2_tg_user_id else v_room.player1_tg_user_id end;

    update public.users
      set balance = round((coalesce(balance, 0) + v_stake * 2)::numeric, 9),
          updated_at = now()
    where tg_user_id = v_winner;

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values
      (
        v_winner,
        v_room.id,
        v_room.game_key,
        'win',
        v_stake,
        v_stake,
        jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Победа в матче +%s TON', v_stake))
      ),
      (
        v_loser,
        v_room.id,
        v_room.game_key,
        'loss',
        -v_stake,
        v_stake,
        jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Поражение в матче -%s TON', v_stake))
      );
  else
    update public.users
      set balance = round((coalesce(balance, 0) + v_stake)::numeric, 9),
          updated_at = now()
    where tg_user_id in (v_room.player1_tg_user_id, v_room.player2_tg_user_id);

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values
      (
        v_room.player1_tg_user_id,
        v_room.id,
        v_room.game_key,
        'refund',
        v_stake,
        v_stake,
        jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Возврат ставки +%s TON', v_stake))
      ),
      (
        v_room.player2_tg_user_id,
        v_room.id,
        v_room.game_key,
        'refund',
        v_stake,
        v_stake,
        jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Возврат ставки +%s TON', v_stake))
      );
  end if;

  update public.pvp_rooms
    set stake_settled_at = now(),
        updated_at = now()
  where id = p_room_id;

  return true;
end;
$$;
