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

    const rows = await sb(
      `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,first_name,last_name,username,nickname,referred_by,rules_accepted_at,created_at,updated_at&limit=1`
    );

    if (!rows.length) {
      return res.status(200).json({
        ok: true,
        exists: false,
        user: {
          tg_user_id: tgId,
          first_name: tg.first_name || "",
          last_name: tg.last_name || "",
          username: tg.username || "",
        },
      });
    }

    return res.status(200).json({ ok: true, exists: true, user: rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
};
