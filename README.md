# f1-duel

## Telegram Bot (Vercel Webhook)

In this project, the Telegram bot is handled by Vercel serverless functions:

- `api/bot.js` - single endpoint for bot:
  - `POST /api/bot` - Telegram webhook updates
  - `GET /api/bot?action=setWebhook` - helper to register webhook

### 1) Set environment variables in Vercel

Add these variables in your Vercel project settings:

- `TELEGRAM_BOT_TOKEN` - your bot token from BotFather
- `WEBAPP_URL` - your deployed app URL (for example: `https://f1-three-iota.vercel.app`)
- `TELEGRAM_WEBHOOK_SECRET` - optional secret for webhook verification

### 2) Deploy

After pushing changes, redeploy your Vercel project.

### 3) Register webhook

Open this URL in browser:

`https://f1-three-iota.vercel.app/api/bot?action=setWebhook`

If everything is correct, response includes `telegram.ok: true`.

### 4) Test

In Telegram, send `/start` to the bot.
The bot replies with a welcome message and short game description.

## Supabase User Storage

This project now stores first-login user data in Supabase with server-side validation.

### Security model

- Telegram `initData` is verified on the server (`api/user.js`)
- Supabase write/read is done only from serverless API with `SUPABASE_SERVICE_ROLE_KEY`
- Direct anon access to `users` table is blocked by RLS policies
- Rules acceptance and user profile actions are served by one endpoint: `api/user.js`

### SQL migration (full portable schema)

Run:

- `db/supabase_full_schema.sql`

This file contains full SQL for table, indexes, trigger, and RLS policies so you can move DB to another Supabase account.

### Required environment variables

See `.env.example`.

At minimum:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `WEBAPP_URL`

## Автопополнение и автовывод TON (Cron)

В проекте есть `api/wallet-cron.js` и `vercel.json` с расписанием **раз в минуту**.

1. Установи зависимости: в корне репозитория есть `package.json` (`@ton/ton`, `@ton/crypto`) — Vercel выполнит `npm install` при деплое.
2. В Vercel → Settings → Environment variables задай как минимум:
   - `CRON_SECRET` — длинная случайная строка (Vercel для Cron передаёт `Authorization: Bearer <CRON_SECRET>`).
   - `TON_DEPOSIT_ADDRESS` — тот же адрес, что показывается пользователям.
   - `TON_HOT_WALLET_MNEMONIC` — мнемоника **этого же** кошелька (для исходящих переводов по заявкам).
   - При несовпадении адреса с мнемоникой проверь `TON_WALLET_VERSION` (`v4` или `v5`).
3. Рекомендуется `TONCENTER_API_KEY` (см. [toncenter.com](https://toncenter.com)) — иначе возможны лимиты RPC.
4. Опционально `TONAPI_KEY` для TonAPI при большом трафике чтения.
5. На **Hobby** Vercel Cron может быть недоступен — нужен план с Cron; иначе вызывай `GET https://<твой-домен>/api/wallet-cron` вручную с заголовком `Authorization: Bearer <CRON_SECRET>` (или `x-wallet-cron-secret`).

Подробные переменные — в `.env.example`.