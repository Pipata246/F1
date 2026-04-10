-- Delta migration: persistent match history + per-game aggregates

create table if not exists public.game_matches (
  id uuid primary key default gen_random_uuid(),
  game_key text not null check (game_key in ('frog_hunt', 'obstacle_race', 'super_penalty', 'basketball')),
  server_match_id text not null,
  mode text not null default 'pvp',
  player1_tg_user_id text,
  player1_name text not null default '',
  player2_tg_user_id text,
  player2_name text not null default '',
  winner_tg_user_id text,
  score_json jsonb not null default '{}'::jsonb,
  details_json jsonb not null default '{}'::jsonb,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists idx_game_matches_unique_source
  on public.game_matches(game_key, server_match_id);
create index if not exists idx_game_matches_player1 on public.game_matches(player1_tg_user_id);
create index if not exists idx_game_matches_player2 on public.game_matches(player2_tg_user_id);
create index if not exists idx_game_matches_finished_at on public.game_matches(finished_at desc);

create table if not exists public.game_player_stats (
  id uuid primary key default gen_random_uuid(),
  tg_user_id text not null,
  game_key text not null check (game_key in ('frog_hunt', 'obstacle_race', 'super_penalty', 'basketball')),
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  points_for int not null default 0,
  points_against int not null default 0,
  last_result text check (last_result in ('win', 'loss')),
  last_match_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tg_user_id, game_key)
);

create index if not exists idx_game_player_stats_user on public.game_player_stats(tg_user_id);
create index if not exists idx_game_player_stats_game on public.game_player_stats(game_key);

drop trigger if exists trg_game_player_stats_updated_at on public.game_player_stats;
create trigger trg_game_player_stats_updated_at
before update on public.game_player_stats
for each row execute function public.set_updated_at();

alter table public.game_matches enable row level security;
alter table public.game_player_stats enable row level security;

drop policy if exists "deny_all_select_game_matches" on public.game_matches;
create policy "deny_all_select_game_matches"
on public.game_matches for select to public
using (false);

drop policy if exists "deny_all_insert_game_matches" on public.game_matches;
create policy "deny_all_insert_game_matches"
on public.game_matches for insert to public
with check (false);

drop policy if exists "deny_all_update_game_matches" on public.game_matches;
create policy "deny_all_update_game_matches"
on public.game_matches for update to public
using (false)
with check (false);

drop policy if exists "deny_all_delete_game_matches" on public.game_matches;
create policy "deny_all_delete_game_matches"
on public.game_matches for delete to public
using (false);

drop policy if exists "deny_all_select_game_player_stats" on public.game_player_stats;
create policy "deny_all_select_game_player_stats"
on public.game_player_stats for select to public
using (false);

drop policy if exists "deny_all_insert_game_player_stats" on public.game_player_stats;
create policy "deny_all_insert_game_player_stats"
on public.game_player_stats for insert to public
with check (false);

drop policy if exists "deny_all_update_game_player_stats" on public.game_player_stats;
create policy "deny_all_update_game_player_stats"
on public.game_player_stats for update to public
using (false)
with check (false);

drop policy if exists "deny_all_delete_game_player_stats" on public.game_player_stats;
create policy "deny_all_delete_game_player_stats"
on public.game_player_stats for delete to public
using (false);
