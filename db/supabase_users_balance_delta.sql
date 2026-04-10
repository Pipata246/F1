-- =============================================
-- F1 Duel — баланс пользователя (TON, серверный)
-- Выполни в Supabase SQL Editor поверх уже созданной таблицы users.
-- =============================================

alter table public.users
  add column if not exists balance numeric(24, 9) not null default 0;

comment on column public.users.balance is 'Баланс в TON (учёт на сервере), по умолчанию 0';

-- Уже существующие строки получат 0 при add column default.
