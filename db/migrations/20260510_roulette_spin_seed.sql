-- Add deterministic spin metadata for roulette.
-- Needed to make UI wheel outcome match server winner exactly.

alter table if exists public.roulette_rounds
  add column if not exists spin_seed bigint null,
  add column if not exists winner_card_index integer null;

create index if not exists idx_roulette_rounds_finished_at
  on public.roulette_rounds (finished_at desc);

