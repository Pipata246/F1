/**
 * TonConnect manifest (JSON). Кошельки запрашивают по URL — подставляем WEBAPP_URL из env.
 */
module.exports = (req, res) => {
  const base = String(process.env.WEBAPP_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ error: "WEBAPP_URL is not set" });
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    url: base,
    name: "F1 Duel",
    iconUrl: `${base}/tonconnect-icon.svg`,
  });
};
