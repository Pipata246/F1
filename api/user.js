const crypto = require("crypto");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function parseJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function assertSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const payload = parseJwtPayload(SUPABASE_SERVICE_ROLE_KEY);
  const role = payload?.role || "";
  if (role !== "service_role") {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is invalid. Put service_role key (not anon key) in Vercel env."
    );
  }
}

async function sb(path, { method = "GET", body, prefer, onConflict } = {}) {
  assertSupabaseEnv();
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;

  const suffix = onConflict
    ? `${path.includes("?") ? "&" : "?"}on_conflict=${encodeURIComponent(onConflict)}`
    : "";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${suffix}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.message || data?.hint || `Supabase REST error: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function validNickname(value) {
  return /^[A-Za-z0-9_]{3,16}$/.test(value || "");
}

async function authSession(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);

  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,first_name,last_name,username,nickname,referred_by,referral_asked_at,rules_accepted_at,created_at,updated_at&limit=1`
  );

  if (!rows.length) {
    return {
      exists: false,
      user: {
        tg_user_id: tgId,
        first_name: tg.first_name || "",
        last_name: tg.last_name || "",
        username: tg.username || "",
      },
    };
  }
  return { exists: true, user: rows[0] };
}

async function upsertUser(initData, nickname, referredBy, rulesAcceptedAtMs) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);
  const cleanNick = String(nickname || "").trim();
  const cleanRef = String(referredBy || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  if (!validNickname(cleanNick)) throw new Error("Invalid nickname format");

  const existing = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=referred_by,referral_asked_at,rules_accepted_at&limit=1`
  );
  const prevRef = existing[0]?.referred_by || null;
  const prevAskedAt = existing[0]?.referral_asked_at || null;

  const parsedRulesMs = Number(rulesAcceptedAtMs || 0);
  const rulesAcceptedAt = existing[0]?.rules_accepted_at ||
    (parsedRulesMs > 0 ? new Date(parsedRulesMs).toISOString() : null);
  if (!rulesAcceptedAt) throw new Error("Rules must be accepted before registration");

  const payload = {
    tg_user_id: tgId,
    first_name: tg.first_name || "",
    last_name: tg.last_name || "",
    username: tg.username || "",
    nickname: cleanNick,
    referred_by: prevAskedAt ? prevRef : (cleanRef || null),
    referral_asked_at: prevAskedAt || new Date().toISOString(),
    rules_accepted_at: rulesAcceptedAt,
    updated_at: new Date().toISOString(),
  };

  const rows = await sb("users", {
    method: "POST",
    body: payload,
    onConflict: "tg_user_id",
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return rows?.[0] || payload;
}

async function markReferralAsked(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);

  const existing = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,nickname,referred_by,referral_asked_at,rules_accepted_at&limit=1`
  );
  if (!existing.length) throw new Error("User not found");

  const row = existing[0];
  const payload = {
    tg_user_id: tgId,
    first_name: tg.first_name || "",
    last_name: tg.last_name || "",
    username: tg.username || "",
    nickname: row.nickname || null,
    referred_by: row.referred_by || null,
    referral_asked_at: row.referral_asked_at || new Date().toISOString(),
    rules_accepted_at: row.rules_accepted_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const rows = await sb("users", {
    method: "POST",
    body: payload,
    onConflict: "tg_user_id",
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return rows?.[0] || payload;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const action = req.body?.action;
    if (!action) return res.status(400).json({ ok: false, error: "Missing action" });

    if (action === "authSession") {
      const data = await authSession(req.body?.initData || "");
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "upsertUser") {
      const user = await upsertUser(
        req.body?.initData || "",
        req.body?.nickname || "",
        req.body?.referredBy || "",
        req.body?.rulesAcceptedAt || 0
      );
      return res.status(200).json({ ok: true, user });
    }
    if (action === "markReferralAsked") {
      const user = await markReferralAsked(req.body?.initData || "");
      return res.status(200).json({ ok: true, user });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    const msg = e.message || "Internal error";
    const code =
      msg.includes("Invalid Telegram") || msg.includes("Expired Telegram") || msg.includes("No hash") || msg.includes("No Telegram user")
        ? 401
        : msg === "User not found"
          ? 404
          : msg === "Invalid nickname format" || msg.includes("Rules must be accepted")
            ? 400
            : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
};
