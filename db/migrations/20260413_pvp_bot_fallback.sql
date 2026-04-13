-- Hidden bot fallback for long matchmaking queues (TON-safe settlement).

create or replace function public.pvp_start_bot_match_with_stake(
  p_room_id bigint,
  p_bot_tg_user_id text,
  p_bot_name text,
  p_state_json jsonb,
  p_stake_ton numeric
) returns bigint
language plpgsql
security definer
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_balance numeric(20,9);
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
  if coalesce(array_length(v_room.stake_options_ton, 1), 0) > 0 and not (p_stake_ton = any(v_room.stake_options_ton)) then
    raise exception 'No common stake';
  end if;

  select balance
    into v_balance
  from public.users
  where tg_user_id = v_room.player1_tg_user_id
  for update;

  if not found then
    raise exception 'User not found';
  end if;
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
as $$
declare
  v_room public.pvp_rooms%rowtype;
  v_stake numeric(20,9);
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

  if p_user_won then
    update public.users
      set balance = round((coalesce(balance, 0) + v_stake * 2)::numeric, 9),
          updated_at = now()
    where tg_user_id = p_user_tg_user_id;

    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values (
      p_user_tg_user_id,
      v_room.id,
      v_room.game_key,
      'win',
      v_stake,
      v_stake,
      jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Победа в матче +%s TON', v_stake), 'botFallback', true)
    );
  else
    insert into public.pvp_balance_events (tg_user_id, room_id, game_key, event_type, amount, stake_ton, meta)
    values (
      p_user_tg_user_id,
      v_room.id,
      v_room.game_key,
      'loss',
      -v_stake,
      v_stake,
      jsonb_build_object('reason', coalesce(p_reason, 'match_finished'), 'text', format('Поражение в матче -%s TON', v_stake), 'botFallback', true)
    );
  end if;

  update public.pvp_rooms
    set stake_settled_at = now(),
        updated_at = now()
  where id = p_room_id;

  return true;
end;
$$;
