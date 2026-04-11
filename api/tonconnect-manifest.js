/**
 * TonConnect manifest. Поле url должно совпадать с origin приложения (кошелёк проверяет).
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
  if (!proto) proto = fromEnv.startsWith("http://") ? "http" : "https";
  return `${proto}://${xfHost}`.replace(/\/$/, "");
}

module.exports = (req, res) => {
  const base = requestBaseUrl(req);
  if (!base) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ error: "Cannot resolve app URL (set WEBAPP_URL)" });
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    url: base,
    name: "F1 Duel",
    iconUrl: `${base}/tonconnect-icon.svg`,
  });
};
