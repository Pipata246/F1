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

function generateReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function getUniqueReferralCode() {
  for (let i = 0; i < 20; i++) {
    const code = generateReferralCode();
    const found = await sb(
      `users?referral_code=eq.${encodeURIComponent(code)}&select=id&limit=1`
    );
    if (!found.length) return code;
  }
  throw new Error("Failed to generate unique referral code");
}

async function ensureReferralCode(tg, row) {
  if (row?.referral_code) return row.referral_code;
  const referralCode = await getUniqueReferralCode();
  const payload = {
    tg_user_id: String(tg.id),
    first_name: tg.first_name || "",
    last_name: tg.last_name || "",
    username: tg.username || "",
    nickname: row?.nickname || null,
    referred_by: row?.referred_by || null,
    referral_asked_at: row?.referral_asked_at || null,
    referral_code: referralCode,
    rules_accepted_at: row?.rules_accepted_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await sb("users", {
    method: "POST",
    body: payload,
    onConflict: "tg_user_id",
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return referralCode;
}

async function authSession(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);

  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,first_name,last_name,username,nickname,referred_by,referral_asked_at,referral_code,rules_accepted_at,created_at,updated_at&limit=1`
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
  const user = rows[0];
  const referralCode = await ensureReferralCode(tg, user);
  return { exists: true, user: { ...user, referral_code: referralCode } };
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
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=referred_by,referral_asked_at,referral_code,rules_accepted_at&limit=1`
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
    referral_code: existing[0]?.referral_code || (await getUniqueReferralCode()),
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
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,nickname,referred_by,referral_asked_at,referral_code,rules_accepted_at&limit=1`
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
    referral_code: row.referral_code || (await getUniqueReferralCode()),
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

function assertInternalApiKey(req) {
  const expected = process.env.INTERNAL_API_KEY || "";
  if (!expected) throw new Error("Internal API key is not set");
  const provided = req.headers["x-internal-api-key"];
  if (!provided || provided !== expected) throw new Error("Forbidden");
}

function normalizeGameKey(value) {
  const key = String(value || "").trim();
  const allowed = new Set(["frog_hunt", "obstacle_race", "super_penalty", "basketball"]);
  if (!allowed.has(key)) throw new Error("Invalid game key");
  return key;
}

function asIsoDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function asObj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function recordMatchInternal(req) {
  assertInternalApiKey(req);
  const b = req.body || {};
  return persistMatchFromPayload(b);
}

async function persistMatchFromPayload(b) {
  const gameKey = normalizeGameKey(b.gameKey);
  const playersRaw = Array.isArray(b.players) ? b.players : [];
  if (playersRaw.length < 1) throw new Error("Missing players");

  const players = playersRaw.slice(0, 2).map((p) => ({
    tgUserId: p?.tgUserId ? String(p.tgUserId) : null,
    name: String(p?.name || "Player").slice(0, 64),
    score: Number(p?.score || 0),
    isWinner: !!p?.isWinner,
    isBot: !!p?.isBot,
  }));
  const finishedAt = asIsoDate(b.finishedAt);
  const mode = String(b.mode || (players.some((p) => p.isBot) ? "bot" : "pvp")).slice(0, 20);
  const winnerTgUserId = b.winnerTgUserId ? String(b.winnerTgUserId) : null;
  const score = asObj(b.score);
  const details = asObj(b.details);
  const serverMatchId = String(b.serverMatchId || `${gameKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 80);

  await sb("game_matches", {
    method: "POST",
    body: {
      game_key: gameKey,
      server_match_id: serverMatchId,
      mode,
      player1_tg_user_id: players[0]?.tgUserId || null,
      player1_name: players[0]?.name || "Player",
      player2_tg_user_id: players[1]?.tgUserId || null,
      player2_name: players[1]?.name || "Player",
      winner_tg_user_id: winnerTgUserId,
      score_json: score,
      details_json: details,
      finished_at: finishedAt,
      created_at: finishedAt,
    },
    prefer: "return=representation",
  });

  const nonBotPlayers = players.filter((p) => !p.isBot && p.tgUserId);
  for (const p of nonBotPlayers) {
    const tgId = String(p.tgUserId);
    const existingRows = await sb(
      `game_player_stats?tg_user_id=eq.${encodeURIComponent(tgId)}&game_key=eq.${encodeURIComponent(gameKey)}&select=tg_user_id,game_key,games_played,wins,losses,points_for,points_against&limit=1`
    );
    const existing = existingRows[0] || null;
    const opponent = players.find((x) => x !== p) || { score: 0 };
    const next = {
      tg_user_id: tgId,
      game_key: gameKey,
      games_played: Number(existing?.games_played || 0) + 1,
      wins: Number(existing?.wins || 0) + (p.isWinner ? 1 : 0),
      losses: Number(existing?.losses || 0) + (p.isWinner ? 0 : 1),
      points_for: Number(existing?.points_for || 0) + Number(p.score || 0),
      points_against: Number(existing?.points_against || 0) + Number(opponent.score || 0),
      last_result: p.isWinner ? "win" : "loss",
      last_match_at: finishedAt,
      updated_at: new Date().toISOString(),
    };
    await sb("game_player_stats", {
      method: "POST",
      body: next,
      onConflict: "tg_user_id,game_key",
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  return { gameKey, serverMatchId, savedPlayers: nonBotPlayers.length };
}

async function recordMatchClient(initData, payload) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const safePayload = asObj(payload);
  const players = Array.isArray(safePayload.players) ? safePayload.players : [];
  const includesCurrentUser = players.some((p) => String(p?.tgUserId || "") === tgId);
  if (!includesCurrentUser) throw new Error("Current user is not in match payload");
  return persistMatchFromPayload(safePayload);
}

async function getGameStats(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const rows = await sb(
    `game_player_stats?tg_user_id=eq.${encodeURIComponent(tgId)}&select=game_key,games_played,wins,losses,points_for,points_against,last_result,last_match_at`
  );
  const byGame = {};
  for (const r of rows || []) byGame[r.game_key] = r;
  return byGame;
}

async function getMatchHistory(initData, limit = 50) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await sb(
    `game_matches?or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&select=id,game_key,mode,player1_tg_user_id,player1_name,player2_tg_user_id,player2_name,winner_tg_user_id,score_json,details_json,finished_at&order=finished_at.desc&limit=${safeLimit}`
  );
  return rows || [];
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
    if (action === "recordMatchInternal") {
      const result = await recordMatchInternal(req);
      return res.status(200).json({ ok: true, result });
    }
    if (action === "recordMatch") {
      const result = await recordMatchClient(req.body?.initData || "", req.body?.payload || {});
      return res.status(200).json({ ok: true, result });
    }
    if (action === "getGameStats") {
      const stats = await getGameStats(req.body?.initData || "");
      return res.status(200).json({ ok: true, stats });
    }
    if (action === "getMatchHistory") {
      const matches = await getMatchHistory(req.body?.initData || "", req.body?.limit || 50);
      return res.status(200).json({ ok: true, matches });
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
            : msg === "Forbidden"
              ? 403
            : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
};
