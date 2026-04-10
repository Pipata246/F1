const crypto = require("crypto");

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [key, value] of params.entries()) data[key] = value;
  return data;
}

function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return { ok: false, error: "Missing initData or bot token" };

  const parsed = parseInitData(initData);
  const hash = parsed.hash;
  if (!hash) return { ok: false, error: "No hash in initData" };

  const entries = Object.entries(parsed)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);

  const dataCheckString = entries.join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return { ok: false, error: "Invalid Telegram initData hash" };

  const authDate = Number(parsed.auth_date || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > maxAgeSeconds) {
    return { ok: false, error: "Expired Telegram initData" };
  }

  let user = null;
  try {
    user = JSON.parse(parsed.user || "{}");
  } catch {
    return { ok: false, error: "Invalid user payload in initData" };
  }

  if (!user || !user.id) return { ok: false, error: "No Telegram user in initData" };

  return { ok: true, user };
}

module.exports = { verifyTelegramInitData };
