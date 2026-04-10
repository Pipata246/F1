const { verifyTelegramInitData } = require("./_lib/telegram");
const { sb } = require("./_lib/supabase-rest");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const initData = req.body?.initData || "";
    const verified = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!verified.ok) {
      return res.status(401).json({ ok: false, error: verified.error });
    }

    const tg = verified.user;
    const tgId = String(tg.id);
    const nowIso = new Date().toISOString();

    const existing = await sb(
      `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=rules_accepted_at&limit=1`
    );

    const rulesAcceptedAt = existing[0]?.rules_accepted_at || nowIso;

    const payload = {
      tg_user_id: tgId,
      first_name: tg.first_name || "",
      last_name: tg.last_name || "",
      username: tg.username || "",
      rules_accepted_at: rulesAcceptedAt,
      updated_at: nowIso,
    };

    const rows = await sb("users", {
      method: "POST",
      body: payload,
      prefer: "resolution=merge-duplicates,return=representation",
    });

    return res.status(200).json({ ok: true, user: rows?.[0] || payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
};
