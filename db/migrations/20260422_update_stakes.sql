-- Update allowed stakes: 0.1, 0.5, 1, 5, 10, 25
-- Run this in Supabase SQL Editor

create or replace function public.pvp_join_waiting_with_stake(
  p_room_id bigint,
  p_player2_tg_user_id text,
  p_player2_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
as $func$
declare
  v_room public.pvp_rooms%rowtype;
  v_p1_balance numeric(20,9);
  v_p2_balance numeric(20,9);
begin
  if p_stake_ton not in (0.1, 0.5, 1, 5, 10, 25) then
    raise exception 'Invalid stake';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return null; end if;
  if v_room.status <> 'waiting' or v_room.player2_tg_user_id is not null then return null; end if;
  if coalesce(v_room.player1_tg_user_id, '') = coalesce(p_player2_tg_user_id, '') then return null; end if;
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0 and not (p_stake_ton = any(v_room.stake_options_ton)) then
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
    set balance = round((coalesce(balance, 0) - p_stake_ton)::numeric, 9), updated_at = now()
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
$func$;

create or replace function public.pvp_start_bot_match_with_stake(
  p_room_id bigint,
  p_bot_tg_user_id text,
  p_bot_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
as $func$
declare
  v_room public.pvp_rooms%rowtype;
  v_balance numeric(20,9);
begin
  if p_stake_ton not in (0.1, 0.5, 1, 5, 10, 25) then
    raise exception 'Invalid stake';
  end if;

  select * into v_room from public.pvp_rooms where id = p_room_id for update;
  if not found then return null; end if;
  if v_room.status <> 'waiting' or v_room.player2_tg_user_id is not null then return null; end if;
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0 and not (p_stake_ton = any(v_room.stake_options_ton)) then
    raise exception 'No common stake';
  end if;

  select balance into v_balance from public.users where tg_user_id = v_room.player1_tg_user_id for update;
  if not found then raise exception 'User not found'; end if;
  if coalesce(v_balance, 0) < p_stake_ton then raise exception 'Insufficient balance for selected stakes'; end if;

  update public.users
    set balance = round((coalesce(balance, 0) - p_stake_ton)::numeric, 9), updated_at = now()
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
$func$;
