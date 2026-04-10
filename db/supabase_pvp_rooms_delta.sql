create table if not exists public.pvp_rooms (
  id bigserial primary key,
  game_key text not null,
  status text not null default 'waiting',
  player1_tg_user_id text not null,
  player1_name text not null default 'Игрок 1',
  player2_tg_user_id text null,
  player2_name text null,
  winner_tg_user_id text null,
  current_actor_tg_user_id text null,
  state_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pvp_rooms_game_status_created
  on public.pvp_rooms(game_key, status, created_at);

create index if not exists idx_pvp_rooms_p1 on public.pvp_rooms(player1_tg_user_id);
create index if not exists idx_pvp_rooms_p2 on public.pvp_rooms(player2_tg_user_id);

drop trigger if exists trg_pvp_rooms_updated_at on public.pvp_rooms;
create trigger trg_pvp_rooms_updated_at
before update on public.pvp_rooms
for each row execute function public.set_updated_at();

alter table public.pvp_rooms enable row level security;

drop policy if exists "deny_all_select_pvp_rooms" on public.pvp_rooms;
create policy "deny_all_select_pvp_rooms" on public.pvp_rooms
for select using (false);

drop policy if exists "deny_all_insert_pvp_rooms" on public.pvp_rooms;
create policy "deny_all_insert_pvp_rooms" on public.pvp_rooms
for insert with check (false);

drop policy if exists "deny_all_update_pvp_rooms" on public.pvp_rooms;
create policy "deny_all_update_pvp_rooms" on public.pvp_rooms
for update using (false);

drop policy if exists "deny_all_delete_pvp_rooms" on public.pvp_rooms;
create policy "deny_all_delete_pvp_rooms" on public.pvp_rooms
for delete using (false);
