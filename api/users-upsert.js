const { verifyTelegramInitData } = require("./_lib/telegram");
const { sb } = require("./_lib/supabase-rest");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function validNickname(value) {
  return /^[A-Za-z0-9_]{3,16}$/.test(value || "");
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { initData, nickname, referredBy } = req.body || {};
    const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
    if (!verified.ok) {
      return res.status(401).json({ ok: false, error: verified.error });
    }

    const tg = verified.user;
    const tgId = String(tg.id);
    const cleanNick = String(nickname || "").trim();
    const cleanRef = String(referredBy || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

    if (!validNickname(cleanNick)) {
      return res.status(400).json({ ok: false, error: "Invalid nickname format" });
    }

    const existing = await sb(
      `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=referred_by,rules_accepted_at&limit=1`
    );
    const prevRef = existing[0]?.referred_by || null;

    const payload = {
      tg_user_id: tgId,
      first_name: tg.first_name || "",
      last_name: tg.last_name || "",
      username: tg.username || "",
      nickname: cleanNick,
      referred_by: cleanRef || prevRef,
      referral_asked_at: new Date().toISOString(),
      rules_accepted_at: existing[0]?.rules_accepted_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
