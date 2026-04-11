/**
 * TonConnect manifest (JSON). Поле `url` должно совпадать с реальным origin мини-приложения,
 * иначе кошелёк отклонит сессию (мелькнёт и закроется). На Vercel берём Host из запроса.
 */
function requestBaseUrl(req) {
  const fromEnv = String(process.env.WEBAPP_URL || "")
    .trim()
    .replace(/\/$/, "");
  const xfHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!xfHost) return fromEnv;
  let proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  if (!proto) {
    proto = fromEnv.startsWith("http://") ? "http" : "https";
  }
  return `${proto}://${xfHost}`.replace(/\/$/, "");
}

module.exports = (req, res) => {
  const base = requestBaseUrl(req);
  if (!base) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({
      error: "Cannot resolve app URL (set WEBAPP_URL or open this URL on your deployed host)",
    });
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    url: base,
    name: "F1 Duel",
    iconUrl: `${base}/tonconnect-icon.svg`,
  });
};
