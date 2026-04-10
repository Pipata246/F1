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
The bot replies with a welcome message and an inline button that opens the WebApp.