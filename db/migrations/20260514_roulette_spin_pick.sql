-- Один выпавший угол [0,1) на круге рулетки: по нему и победитель, и остановка колеса на клиенте.
alter table if exists public.roulette_rounds
  add column if not exists spin_pick double precision null;

comment on column public.roulette_rounds.spin_pick is
  'Uniform draw in [0,1) on cumulative chance ring; winner + UI pointer must use this value only.';
