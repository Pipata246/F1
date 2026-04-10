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

function getPvpRole(state, tgId) {
  const key = String(state?.player1_tg_user_id) === String(tgId) ? "p1" : "p2";
  return state?.state_json?.roles?.[key] || null;
}

function getPvpSide(state, tgId) {
  return String(state?.player1_tg_user_id) === String(tgId) ? "p1" : "p2";
}

function isPvpRoomParticipant(room, tgId) {
  return String(room?.player1_tg_user_id || "") === String(tgId || "") ||
    String(room?.player2_tg_user_id || "") === String(tgId || "");
}

function pvpDefaultState(player1Id, player2Id) {
  const firstFrog = Math.random() < 0.5 ? "p1" : "p2";
  const firstHunter = firstFrog === "p1" ? "p2" : "p1";
  return {
    phase: "turn_input",
    gameNum: 1,
    currentRound: 1,
    totalRounds: 5,
    totalCells: 8,
    hunterShots: 1,
    roles: { p1: firstFrog === "p1" ? "frog" : "hunter", p2: firstFrog === "p2" ? "frog" : "hunter" },
    frogCell: null,
    pending: { frogCell: null, hunterCells: [] },
    matchScores: { p1: 0, p2: 0 },
    markers: { round: 0, game: 0, switch: 0, tiebreak: 0, match: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    players: { p1: String(player1Id), p2: String(player2Id) },
  };
}

function pvpConfigForGame(gameNum) {
  if (gameNum === 3) return { totalRounds: 1, totalCells: 4, hunterShots: 2 };
  return { totalRounds: 5, totalCells: 8, hunterShots: 1 };
}

function asMs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function pvpHeartbeat(state, tgId) {
  const next = { ...asObj(state) };
  const side = String(next?.players?.p1 || "") === String(tgId) ? "p1" : "p2";
  const now = Date.now();
  const presence = { ...(next.presence || {}) };
  const prev = Number(presence[side] || 0);
  if (now - prev < 8000) return { changed: false, state: next };
  presence[side] = now;
  next.presence = presence;
  next.updatedAt = new Date().toISOString();
  return { changed: true, state: next };
}

async function pvpCancelRooms(ids) {
  const uniq = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  if (!uniq.length) return;
  await sb(`pvp_rooms?id=in.(${uniq.join(",")})`, {
    method: "PATCH",
    body: { status: "cancelled", updated_at: new Date().toISOString() },
    prefer: "return=minimal",
  });
}

async function pvpPruneUserNonActiveRooms(tgId, gameKey) {
  const rows = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=in.(finished,cancelled)&or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&select=id&order=updated_at.desc&limit=100`
  );
  const ids = (rows || []).map((r) => Number(r.id)).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return;
  await sb(`pvp_rooms?id=in.(${ids.join(",")})`, { method: "DELETE" });
}

function pvpRoomHasSamePair(room, a, b) {
  const p1 = String(room?.player1_tg_user_id || "");
  const p2 = String(room?.player2_tg_user_id || "");
  const x = String(a || "");
  const y = String(b || "");
  return (p1 === x && p2 === y) || (p1 === y && p2 === x);
}

async function pvpDedupPairRooms(gameKey, tgA, tgB, keepRoomId) {
  const rows = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=in.(waiting,active)&select=*&order=updated_at.desc&limit=50`
  );
  const dupIds = (rows || [])
    .filter((r) => Number(r.id) !== Number(keepRoomId))
    .filter((r) => pvpRoomHasSamePair(r, tgA, tgB))
    .map((r) => r.id);
  await pvpCancelRooms(dupIds);
}

async function pvpTryJoinWaiting(gameKey, tgId, safeName) {
  const waiting = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=eq.waiting&player2_tg_user_id=is.null&player1_tg_user_id=neq.${encodeURIComponent(tgId)}&select=*&order=created_at.asc&limit=10`
  );
  for (const room of waiting || []) {
    const state = pvpDefaultState(room.player1_tg_user_id, tgId);
    const joined = await sb(
      `pvp_rooms?id=eq.${room.id}&status=eq.waiting&player2_tg_user_id=is.null`,
      {
        method: "PATCH",
        body: {
          player2_tg_user_id: tgId,
          player2_name: safeName,
          status: "active",
          current_actor_tg_user_id: null,
          state_json: { ...state, phaseAtMs: Date.now() },
          updated_at: new Date().toISOString(),
        },
        prefer: "return=representation",
      }
    );
    if (joined?.length) return joined[0];
  }
  return null;
}

async function pvpCleanupUserRooms(tgId, gameKey) {
  const rows = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=in.(waiting,active)&or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&select=*&order=updated_at.desc&limit=20`
  );
  if (!rows?.length) return null;
  const now = Date.now();
  const staleMs = 2 * 60 * 1000;
  const alive = [];
  const cancelIds = [];
  for (const r of rows) {
    const age = now - Math.max(asMs(r.updated_at), asMs(r.created_at));
    if (age > staleMs) {
      cancelIds.push(r.id);
      continue;
    }
    const s = asObj(r.state_json);
    const p = asObj(s.presence);
    const p1Beat = Number(p.p1 || 0);
    const p2Beat = Number(p.p2 || 0);
    const heartbeatStale = r.status === "active" && p1Beat > 0 && p2Beat > 0 && (now - Math.max(p1Beat, p2Beat) > 30000);
    if (heartbeatStale) {
      cancelIds.push(r.id);
      continue;
    }
    alive.push(r);
  }
  let keep = null;
  for (const r of alive) {
    if (r.status === "active") { keep = r; break; }
  }
  if (!keep) {
    for (const r of alive) {
      if (r.status === "waiting" && String(r.player1_tg_user_id) === String(tgId) && !r.player2_tg_user_id) {
        keep = r;
        break;
      }
    }
  }
  const toCancelDup = alive.filter((r) => !keep || Number(r.id) !== Number(keep.id)).map((r) => r.id);
  await pvpCancelRooms(cancelIds.concat(toCancelDup));
  return keep;
}

async function pvpEnforceSingleActiveRoom(gameKey, tgId, playerName, keepRoomId) {
  const safeName = String(playerName || "").trim();
  const byUser = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=in.(waiting,active)&or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&select=id&limit=100`
  );
  let byName = [];
  if (safeName) {
    byName = await sb(
      `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=in.(waiting,active)&or=(player1_name.eq.${encodeURIComponent(safeName)},player2_name.eq.${encodeURIComponent(safeName)})&select=id&limit=100`
    );
  }
  const ids = [...(byUser || []), ...(byName || [])]
    .map((r) => Number(r.id))
    .filter((id) => Number.isInteger(id) && id > 0 && Number(id) !== Number(keepRoomId));
  await pvpCancelRooms(ids);
}

function pvpAdvanceByTime(room) {
  const s = asObj(room?.state_json);
  const now = Date.now();
  const phaseAt = Number(s?.phaseAtMs || 0);
  if (!phaseAt) return { changed: false, state: s };
  const elapsed = now - phaseAt;
  const next = { ...s };
  const roles = asObj(s.roles);
  const frogSide = roles.p1 === "frog" ? "p1" : "p2";
  const hunterSide = frogSide === "p1" ? "p2" : "p1";
  const totalCells = Number(s.totalCells || 8);
  const safeCell = Number.isInteger(Number(s.frogCell)) ? Number(s.frogCell) : 0;
  const presence = asObj(s.presence);
  const p1Beat = Number(presence.p1 || 0);
  const p2Beat = Number(presence.p2 || 0);

  // If one side stopped polling for long enough, end match by forfeit.
  if ((s.phase === "turn_input" || s.phase === "round_result" || s.phase === "game_over") && p1Beat > 0 && p2Beat > 0) {
    const staleMs = 15000;
    const p1Stale = now - p1Beat > staleMs;
    const p2Stale = now - p2Beat > staleMs;
    // Protect from false positives during brief network hiccups.
    if (p1Stale !== p2Stale && elapsed >= 4000) {
      const leftSide = p1Stale ? "p1" : "p2";
      const winnerSide = leftSide === "p1" ? "p2" : "p1";
      next.phase = "match_over";
      next.phaseAtMs = now;
      next.endedByLeave = true;
      next.leftBy = String(next?.players?.[leftSide] || "");
      next.leftAt = new Date().toISOString();
      next.matchScores = { ...(s.matchScores || { p1: 0, p2: 0 }) };
      if (Number(next.matchScores.p1 || 0) === Number(next.matchScores.p2 || 0)) {
        next.matchScores[winnerSide] = Number(next.matchScores[winnerSide] || 0) + 1;
      }
      next.markers = { ...(s.markers || {}), match: Number(s?.markers?.match || 0) + 1 };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
  }

  // Turn timeout: side that did not submit in time loses the round.
  if (s.phase === "turn_input" && elapsed >= 16000) {
    const pending = asObj(s.pending);
    const frogChosen =
      pending.frogCell !== null &&
      pending.frogCell !== undefined &&
      Number.isInteger(Number(pending.frogCell));
    const hunterChosen = Array.isArray(pending.hunterCells) && pending.hunterCells.length === Number(s.hunterShots || 1);
    if (!frogChosen || !hunterChosen) {
      const timedOutSide = !frogChosen ? frogSide : hunterSide;
      const winnerSide = timedOutSide === frogSide ? hunterSide : frogSide;
      next.matchScores = { ...(s.matchScores || { p1: 0, p2: 0 }) };
      next.matchScores[winnerSide] = Number(next.matchScores[winnerSide] || 0) + 1;
      next.phase = "game_over";
      next.phaseAtMs = now;
      next.roundHit = timedOutSide === frogSide;
      next.nextFrogCell = frogChosen ? Number(pending.frogCell) : safeCell;
      next.markers = { ...(s.markers || {}), round: Number(s?.markers?.round || 0) + 1, game: Number(s?.markers?.game || 0) + 1 };
      next.lastRoundResult = {
        marker: next.markers.round,
        hit: timedOutSide === frogSide,
        frogCell: frogChosen ? Number(pending.frogCell) : safeCell,
        hunterCells: hunterChosen ? pending.hunterCells.map(Number) : [],
        round: s.currentRound,
        totalRounds: s.totalRounds,
        isFinal: true,
        timedOutSide,
        winnerRole: timedOutSide === frogSide ? "hunter" : "frog",
      };
      next.pending = { frogCell: null, hunterCells: [] };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
  }

  if (s.phase === "round_result" && elapsed >= 2600) {
    if (s.roundHit) {
      next.phase = "game_over";
      next.phaseAtMs = now;
      next.markers = { ...(s.markers || {}), game: Number(s?.markers?.game || 0) + 1 };
    } else if (s.currentRound >= s.totalRounds) {
      next.phase = "game_over";
      next.phaseAtMs = now;
      next.markers = { ...(s.markers || {}), game: Number(s?.markers?.game || 0) + 1 };
    } else {
      next.currentRound = Number(s.currentRound || 1) + 1;
      next.phase = "turn_input";
      next.phaseAtMs = now;
      next.pending = { frogCell: null, hunterCells: [] };
      next.frogCell = s.nextFrogCell ?? s.frogCell ?? null;
      delete next.roundHit;
      delete next.nextFrogCell;
    }
    next.updatedAt = new Date().toISOString();
    return { changed: true, state: next };
  }

  if (s.phase === "game_over" && elapsed >= 1800) {
    const p1 = Number(s?.matchScores?.p1 || 0);
    const p2 = Number(s?.matchScores?.p2 || 0);
    if (s.gameNum === 1) {
      next.gameNum = 2;
      next.currentRound = 1;
      const cfg = pvpConfigForGame(2);
      next.totalRounds = cfg.totalRounds;
      next.totalCells = cfg.totalCells;
      next.hunterShots = cfg.hunterShots;
      next.roles = { p1: s.roles?.p1 === "frog" ? "hunter" : "frog", p2: s.roles?.p2 === "frog" ? "hunter" : "frog" };
      next.frogCell = null;
      next.pending = { frogCell: null, hunterCells: [] };
      next.phase = "switch_roles";
      next.phaseAtMs = now;
      next.markers = { ...(s.markers || {}), switch: Number(s?.markers?.switch || 0) + 1 };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
    if (s.gameNum === 2 && p1 === p2) {
      const cfg = pvpConfigForGame(3);
      const frog = Math.random() < 0.5 ? "p1" : "p2";
      next.gameNum = 3;
      next.currentRound = 1;
      next.totalRounds = cfg.totalRounds;
      next.totalCells = cfg.totalCells;
      next.hunterShots = cfg.hunterShots;
      next.roles = { p1: frog === "p1" ? "frog" : "hunter", p2: frog === "p2" ? "frog" : "hunter" };
      next.frogCell = null;
      next.pending = { frogCell: null, hunterCells: [] };
      next.phase = "tiebreak_start";
      next.phaseAtMs = now;
      next.markers = { ...(s.markers || {}), tiebreak: Number(s?.markers?.tiebreak || 0) + 1 };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
    next.phase = "match_over";
    next.phaseAtMs = now;
    next.markers = { ...(s.markers || {}), match: Number(s?.markers?.match || 0) + 1 };
    next.updatedAt = new Date().toISOString();
    return { changed: true, state: next };
  }

  if ((s.phase === "switch_roles" || s.phase === "tiebreak_start") && elapsed >= 1100) {
    next.phase = "turn_input";
    next.phaseAtMs = now;
    next.updatedAt = new Date().toISOString();
    return { changed: true, state: next };
  }

  return { changed: false, state: s };
}

function pvpApplyMove(room, tgId, move) {
  const s = asObj(room?.state_json);
  if (s.phase !== "turn_input") return s;
  const side = getPvpSide(room, tgId);
  const role = s?.roles?.[side];
  if (!role) throw new Error("Invalid room side");

  const totalCells = Number(s.totalCells || 8);
  const hunterShots = Number(s.hunterShots || 1);
  const next = { ...s, pending: { ...(s.pending || {}) } };

  if (role === "frog") {
    const alreadyChosen =
      next?.pending?.frogCell !== null &&
      next?.pending?.frogCell !== undefined &&
      Number.isInteger(Number(next.pending.frogCell));
    if (alreadyChosen) {
      next.updatedAt = new Date().toISOString();
      return next;
    }
    const frogCell = Number(move?.frogCell);
    if (!Number.isInteger(frogCell) || frogCell < 0 || frogCell >= totalCells) throw new Error("Invalid frog cell");
    next.pending.frogCell = frogCell;
  } else {
    const alreadyChosen = Array.isArray(next?.pending?.hunterCells) && next.pending.hunterCells.length === hunterShots;
    if (alreadyChosen) {
      next.updatedAt = new Date().toISOString();
      return next;
    }
    const arr = Array.isArray(move?.hunterCells) ? move.hunterCells : [];
    const cells = [];
    for (const c of arr) {
      const n = Number(c);
      if (!Number.isInteger(n) || n < 0 || n >= totalCells) throw new Error("Invalid hunter cell");
      if (!cells.includes(n)) cells.push(n);
      if (cells.length >= hunterShots) break;
    }
    if (cells.length !== hunterShots) throw new Error("Invalid hunter cells count");
    next.pending.hunterCells = cells;
  }

  const hasFrog =
    next?.pending?.frogCell !== null &&
    next?.pending?.frogCell !== undefined &&
    Number.isInteger(Number(next.pending.frogCell));
  const hasHunter = Array.isArray(next?.pending?.hunterCells) && next.pending.hunterCells.length === hunterShots;
  if (!hasFrog || !hasHunter) {
    next.updatedAt = new Date().toISOString();
    return next;
  }

  const frogCell = Number(next.pending.frogCell);
  const hunterCells = next.pending.hunterCells.map(Number);
  const hit = hunterCells.includes(frogCell);
  const frogSide = next.roles?.p1 === "frog" ? "p1" : "p2";
  const hunterSide = frogSide === "p1" ? "p2" : "p1";
  const winnerSide = hit ? hunterSide : (Number(next.currentRound) >= Number(next.totalRounds) ? frogSide : null);
  if (winnerSide) {
    next.matchScores = { ...(next.matchScores || { p1: 0, p2: 0 }) };
    next.matchScores[winnerSide] = Number(next.matchScores[winnerSide] || 0) + 1;
  }

  next.phase = "round_result";
  next.phaseAtMs = Date.now();
  next.markers = { ...(next.markers || {}), round: Number(next?.markers?.round || 0) + 1 };
  next.roundHit = hit;
  next.nextFrogCell = frogCell;
  next.lastRoundResult = {
    marker: next.markers.round,
    hit,
    frogCell,
    hunterCells,
    round: next.currentRound,
    totalRounds: next.totalRounds,
    isFinal: Number(next.currentRound) === Number(next.totalRounds),
    winnerRole: hit ? "hunter" : (Number(next.currentRound) === Number(next.totalRounds) ? "frog" : null),
  };
  next.pending = { frogCell: null, hunterCells: [] };
  next.updatedAt = new Date().toISOString();
  return next;
}

async function pvpFindMatch(initData, gameKey, playerName) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const safeName = String(playerName || verified.user.first_name || "Игрок").slice(0, 64);
  const key = normalizeGameKey(gameKey);
  if (key !== "frog_hunt") throw new Error("PvP is enabled only for frog_hunt now");
  await pvpPruneUserNonActiveRooms(tgId, key);
  await pvpEnforceSingleActiveRoom(key, tgId, safeName, 0);

  const existing = await pvpCleanupUserRooms(tgId, key);
  if (existing) return existing;

  const joinedBeforeCreate = await pvpTryJoinWaiting(key, tgId, safeName);
  if (joinedBeforeCreate) {
    await pvpEnforceSingleActiveRoom(key, tgId, safeName, joinedBeforeCreate.id);
    await pvpDedupPairRooms(key, joinedBeforeCreate.player1_tg_user_id, joinedBeforeCreate.player2_tg_user_id, joinedBeforeCreate.id);
    return joinedBeforeCreate;
  }

  const created = await sb("pvp_rooms", {
    method: "POST",
    body: {
      game_key: key,
      status: "waiting",
      player1_tg_user_id: tgId,
      player1_name: safeName,
      player2_tg_user_id: null,
      player2_name: null,
      winner_tg_user_id: null,
      state_json: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    prefer: "return=representation",
  });
  const ownRoom = created?.[0];
  if (!ownRoom) throw new Error("Failed to create queue room");

  // Anti-race: if two users created waiting rooms simultaneously,
  // try to join again and cancel own waiting duplicate.
  const joinedAfterCreate = await pvpTryJoinWaiting(key, tgId, safeName);
  if (joinedAfterCreate && Number(joinedAfterCreate.id) !== Number(ownRoom.id)) {
    await pvpCancelRooms([ownRoom.id]);
    await pvpEnforceSingleActiveRoom(key, tgId, safeName, joinedAfterCreate.id);
    await pvpDedupPairRooms(key, joinedAfterCreate.player1_tg_user_id, joinedAfterCreate.player2_tg_user_id, joinedAfterCreate.id);
    return joinedAfterCreate;
  }

  await pvpEnforceSingleActiveRoom(key, tgId, safeName, ownRoom.id);
  return ownRoom;
}

async function pvpGetRoomState(initData, roomId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid room id");

  const rows = await sb(
    `pvp_rooms?id=eq.${id}&select=*`
  );
  const room = rows?.[0];
  if (!room) throw new Error("Room not found");
  if (!isPvpRoomParticipant(room, tgId)) {
    throw new Error("Forbidden");
  }

  const advanced = pvpAdvanceByTime(room);
  let nextRoom = room;
  const hb = pvpHeartbeat(advanced.state, tgId);
  if (advanced.changed || hb.changed) {
    const patched = await sb(`pvp_rooms?id=eq.${id}`, {
      method: "PATCH",
      body: { state_json: hb.state, updated_at: new Date().toISOString() },
      prefer: "return=representation",
    });
    if (patched?.length) nextRoom = patched[0];
  }
  return finalizePvpRoomIfNeeded(nextRoom);
}

async function pvpSubmitMove(initData, roomId, move) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid room id");

  // Optimistic retries protect from concurrent writes from both clients.
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await sb(`pvp_rooms?id=eq.${id}&select=*`);
    const room = rows?.[0];
    if (!room) throw new Error("Room not found");
    if (!isPvpRoomParticipant(room, tgId)) throw new Error("Forbidden");
    if (room.status !== "active") return room;

    const nowState = pvpAdvanceByTime(room).state;
    const withHeartbeat = pvpHeartbeat(nowState, tgId).state;
    const nextState = pvpApplyMove({ ...room, state_json: withHeartbeat }, tgId, asObj(move));
    const patched = await sb(
      `pvp_rooms?id=eq.${id}&updated_at=eq.${encodeURIComponent(room.updated_at)}&status=eq.active`,
      {
        method: "PATCH",
        body: { state_json: nextState, updated_at: new Date().toISOString() },
        prefer: "return=representation",
      }
    );
    if (patched?.length) {
      return finalizePvpRoomIfNeeded(patched[0]);
    }
  }
  throw new Error("Room update conflict");
}

async function finalizePvpRoomIfNeeded(room) {
  const s = asObj(room?.state_json);
  if (s.phase !== "match_over") return room;
  if (s.matchSavedAt) return room;

  const p1 = Number(s?.matchScores?.p1 || 0);
  const p2 = Number(s?.matchScores?.p2 || 0);
  const winner = p1 === p2 ? null : (p1 > p2 ? String(room.player1_tg_user_id) : String(room.player2_tg_user_id));
  const nextState = { ...s, matchSavedAt: new Date().toISOString() };

  const patched = await sb(`pvp_rooms?id=eq.${room.id}&status=eq.active`, {
    method: "PATCH",
    body: {
      status: "finished",
      winner_tg_user_id: winner,
      state_json: nextState,
      updated_at: new Date().toISOString(),
    },
    prefer: "return=representation",
  });
  if (!patched?.length) return room;
  const finalized = patched[0];

  await persistMatchFromPayload({
    gameKey: "frog_hunt",
    mode: "pvp",
    winnerTgUserId: winner,
    score: { left: p1, right: p2 },
    details: { roomId: room.id },
    players: [
      {
        tgUserId: room.player1_tg_user_id,
        name: room.player1_name || "Игрок 1",
        score: p1,
        isWinner: winner && String(winner) === String(room.player1_tg_user_id),
        isBot: false,
      },
      {
        tgUserId: room.player2_tg_user_id,
        name: room.player2_name || "Игрок 2",
        score: p2,
        isWinner: winner && String(winner) === String(room.player2_tg_user_id),
        isBot: false,
      },
    ],
  });

  return finalized;
}

async function pvpLeaveRoom(initData, roomId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) return { left: false };
  const rows = await sb(`pvp_rooms?id=eq.${id}&select=*`);
  let room = rows?.[0];
  if (!room) return { left: false };
  if (!isPvpRoomParticipant(room, tgId)) {
    throw new Error("Forbidden");
  }
  if (room.status === "waiting") {
    await sb(`pvp_rooms?id=eq.${id}&status=eq.waiting`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
    return { left: true };
  }
  if (room.status === "active") {
    const s = asObj(room.state_json);
    const p1 = Number(s?.matchScores?.p1 || 0);
    const p2 = Number(s?.matchScores?.p2 || 0);
    const winner = String(room.player1_tg_user_id) === tgId
      ? String(room.player2_tg_user_id || "")
      : String(room.player1_tg_user_id || "");
    const nextState = {
      ...s,
      phase: "match_over",
      leftBy: tgId,
      leftAt: new Date().toISOString(),
      endedByLeave: true,
      matchSavedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const patched = await sb(`pvp_rooms?id=eq.${id}&status=eq.active`, {
      method: "PATCH",
      body: {
        status: "finished",
        winner_tg_user_id: winner || null,
        state_json: nextState,
        updated_at: new Date().toISOString(),
      },
      prefer: "return=representation",
    });
    if (patched?.length) room = patched[0];
    if (patched?.length && winner) {
      await persistMatchFromPayload({
        gameKey: "frog_hunt",
        mode: "pvp",
        winnerTgUserId: winner,
        score: { left: p1, right: p2 },
        details: { roomId: id, endedByLeave: true, leftBy: tgId },
        players: [
          {
            tgUserId: room.player1_tg_user_id,
            name: room.player1_name || "Игрок 1",
            score: p1,
            isWinner: String(winner) === String(room.player1_tg_user_id),
            isBot: false,
          },
          {
            tgUserId: room.player2_tg_user_id,
            name: room.player2_name || "Игрок 2",
            score: p2,
            isWinner: String(winner) === String(room.player2_tg_user_id),
            isBot: false,
          },
        ],
      });
    }
    return { left: true };
  }
  return { left: false };
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
    if (action === "pvpFindMatch") {
      const room = await pvpFindMatch(
        req.body?.initData || "",
        req.body?.gameKey || "frog_hunt",
        req.body?.playerName || ""
      );
      return res.status(200).json({ ok: true, room });
    }
    if (action === "pvpGetRoomState") {
      const room = await pvpGetRoomState(req.body?.initData || "", req.body?.roomId || 0);
      return res.status(200).json({ ok: true, room });
    }
    if (action === "pvpSubmitMove") {
      const room = await pvpSubmitMove(
        req.body?.initData || "",
        req.body?.roomId || 0,
        req.body?.move || {}
      );
      return res.status(200).json({ ok: true, room });
    }
    if (action === "pvpLeaveRoom") {
      const result = await pvpLeaveRoom(req.body?.initData || "", req.body?.roomId || 0);
      return res.status(200).json({ ok: true, result });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    const msg = e.message || "Internal error";
    const code =
      msg.includes("Invalid Telegram") || msg.includes("Expired Telegram") || msg.includes("No hash") || msg.includes("No Telegram user")
        ? 401
        : msg === "User not found"
          ? 404
          : msg === "Room not found"
            ? 404
          : msg === "Invalid nickname format" || msg.includes("Rules must be accepted")
            ? 400
            : msg === "Forbidden"
              ? 403
              : msg === "Room update conflict"
                ? 409
            : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
};
