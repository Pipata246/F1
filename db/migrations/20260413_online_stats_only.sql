-- Rebuild player stats using ONLINE matches only (exclude bot/demo games).
-- Safe to run multiple times.

begin;

truncate table public.game_player_stats;

with match_players as (
  select
    gm.id,
    gm.game_key,
    gm.finished_at,
    gm.player1_tg_user_id as tg_user_id,
    coalesce((gm.score_json ->> 'left')::numeric, 0) as points_for,
    coalesce((gm.score_json ->> 'right')::numeric, 0) as points_against,
    case when gm.winner_tg_user_id is not null and gm.winner_tg_user_id = gm.player1_tg_user_id then 1 else 0 end as is_win
  from public.game_matches gm
  where gm.player1_tg_user_id is not null
    and coalesce(gm.mode, 'pvp') <> 'bot'

  union all

  select
    gm.id,
    gm.game_key,
    gm.finished_at,
    gm.player2_tg_user_id as tg_user_id,
    coalesce((gm.score_json ->> 'right')::numeric, 0) as points_for,
    coalesce((gm.score_json ->> 'left')::numeric, 0) as points_against,
    case when gm.winner_tg_user_id is not null and gm.winner_tg_user_id = gm.player2_tg_user_id then 1 else 0 end as is_win
  from public.game_matches gm
  where gm.player2_tg_user_id is not null
    and coalesce(gm.mode, 'pvp') <> 'bot'
),
agg as (
  select
    tg_user_id,
    game_key,
    count(*)::bigint as games_played,
    sum(is_win)::bigint as wins,
    (count(*) - sum(is_win))::bigint as losses,
    coalesce(sum(points_for), 0) as points_for,
    coalesce(sum(points_against), 0) as points_against,
    max(finished_at) as last_match_at
  from match_players
  group by tg_user_id, game_key
),
latest as (
  select distinct on (tg_user_id, game_key)
    tg_user_id,
    game_key,
    case when is_win = 1 then 'win' else 'loss' end as last_result
  from match_players
  order by tg_user_id, game_key, finished_at desc, id desc
)
insert into public.game_player_stats (
  tg_user_id,
  game_key,
  games_played,
  wins,
  losses,
  points_for,
  points_against,
  last_result,
  last_match_at,
  updated_at
)
select
  a.tg_user_id,
  a.game_key,
  a.games_played,
  a.wins,
  a.losses,
  a.points_for,
  a.points_against,
  l.last_result,
  a.last_match_at,
  now()
from agg a
left join latest l
  on l.tg_user_id = a.tg_user_id
 and l.game_key = a.game_key;

commit;
