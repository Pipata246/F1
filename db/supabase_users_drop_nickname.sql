-- Удаление кастомного nickname: имя берётся из Telegram (first_name / last_name / username).
-- Выполните в Supabase → SQL Editor на текущей базе.

alter table public.users drop constraint if exists users_nickname_format;

alter table public.users drop column if exists nickname;
