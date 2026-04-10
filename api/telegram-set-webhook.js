const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.WEBAPP_URL || "https://f1-three-iota.vercel.app";
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";

module.exports = async (req, res) => {
  if (!BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const webhookUrl = `${APP_URL.replace(/\/+$/, "")}/api/telegram-webhook`;
  const payload = {
    url: webhookUrl,
    allowed_updates: ["message"],
  };

  if (SECRET_TOKEN) payload.secret_token = SECRET_TOKEN;

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const tgJson = await tgRes.json();

  return res.status(200).json({
    ok: true,
    webhookUrl,
    telegram: tgJson,
  });
};
