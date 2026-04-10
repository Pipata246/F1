const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.WEBAPP_URL || "https://f1-three-iota.vercel.app";
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const GAMES = [
  "⚡ Реакция",
  "🏓 Пинг-понг",
  "🐸 Frog Hunt (PvP)",
  "🏁 Obstacle Race (PvP)",
  "⚽ Super Penalty (PvP)",
  "🏀 Basketball (PvP)",
];

function buildWelcomeText(firstName) {
  const safeName = firstName ? `${firstName}, ` : "";
  return (
    `Привет, ${safeName}добро пожаловать в F1 Duel!\n\n` +
    "Это мульти-игровой Telegram WebApp с PvP и мини-играми.\n\n" +
    "Доступные режимы:\n" +
    `${GAMES.map((g) => `• ${g}`).join("\n")}`
  );
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

module.exports = async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set" });
    }

    // GET /api/bot?action=setWebhook
    if (req.method === "GET") {
      const action = req.query?.action;
      if (action !== "setWebhook") {
        return res.status(200).json({ ok: true, hint: "Use ?action=setWebhook to register webhook" });
      }
      const webhookUrl = `${APP_URL.replace(/\/+$/, "")}/api/bot`;
      const payload = {
        url: webhookUrl,
        allowed_updates: ["message"],
      };
      if (SECRET_TOKEN) payload.secret_token = SECRET_TOKEN;

      const telegram = await tg("setWebhook", payload);
      return res.status(200).json({ ok: true, webhookUrl, telegram });
    }

    // POST /api/bot - Telegram webhook
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    if (SECRET_TOKEN) {
      const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (incomingSecret !== SECRET_TOKEN) {
        return res.status(401).json({ ok: false, error: "Invalid secret token" });
      }
    }

    const update = req.body || {};
    const message = update.message;
    if (!message || !message.chat || typeof message.text !== "string") {
      return res.status(200).json({ ok: true });
    }

    const text = message.text.trim();
    if (!text.startsWith("/start")) {
      return res.status(200).json({ ok: true });
    }

    const firstName = message.from?.first_name || "";
    await tg("sendMessage", {
      chat_id: message.chat.id,
      text: buildWelcomeText(firstName),
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
};
