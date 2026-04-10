# f1-duel

## Telegram Bot (Vercel Webhook)

In this project, the Telegram bot is handled by Vercel serverless functions:

- `api/telegram-webhook.js` - receives Telegram updates via webhook and handles `/start`
- `api/telegram-set-webhook.js` - helper endpoint to register webhook in Telegram API

### 1) Set environment variables in Vercel

Add these variables in your Vercel project settings:

- `TELEGRAM_BOT_TOKEN` - your bot token from BotFather
- `WEBAPP_URL` - your deployed app URL (for example: `https://f1-three-iota.vercel.app`)
- `TELEGRAM_WEBHOOK_SECRET` - optional secret for webhook verification

### 2) Deploy

After pushing changes, redeploy your Vercel project.

### 3) Register webhook

Open this URL in browser:

`https://f1-three-iota.vercel.app/api/telegram-set-webhook`

If everything is correct, response includes `telegram.ok: true`.

### 4) Test

In Telegram, send `/start` to the bot.
The bot replies with a welcome message and short game description.

## Supabase User Storage

This project now stores first-login user data in Supabase with server-side validation.

### Security model

- Telegram `initData` is verified on the server (`api/_lib/telegram.js`)
- Supabase write/read is done only from serverless API with `SUPABASE_SERVICE_ROLE_KEY`
- Direct anon access to `users` table is blocked by RLS policies
- Rules acceptance is stored in DB with timestamp before nickname step (`api/users-accept-rules.js`)

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