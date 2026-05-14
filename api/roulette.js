const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Минимальная ставка
const MIN_BET = 0.1;

// Комиссия платформы (%)
/** Комиссия с банка рулетки при победе (0 = победитель забирает весь банк). */
const PLATFORM_FEE_PERCENT = 0;

// Длительность таймера (секунды) — совпадайте с ROULETTE_ROUND_TIMER_SECONDS на клиенте
const TIMER_DURATION = 8;
const ACTION_RATE_LIMIT_PER_MIN = 10;
const ACTION_MIN_INTERVAL_MS = 400;
const MUTATING_ACTIONS = new Set(["joinRound", "raiseBet", "spinRoulette"]);
const localActionRate = new Map();

function displayNameFromProfile(first_name, last_name, username) {
  const fn = String(first_name || "").trim();
  const ln = String(last_name || "").trim();
  const un = String(username || "").trim();
  const full = [fn, ln].filter(Boolean).join(" ").trim();
  if (full) return full.slice(0, 64);
  if (un) return `@${un}`.slice(0, 64);
  return "Player";
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/** Solo в комнате: раунд `waiting`; после 2+ игроков — `active`. Повышать ставку нужно в обоих. */
function roundStatusAllowsRaise(status) {
  const s = String(status || "");
  return s === "active" || s === "waiting";
}

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

  return { ok: true, user };
}

async function supabaseQuery(query, params = []) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data, error } = await supabase.rpc(query, params);
  if (error) throw new Error(error.message);
  return data;
}

async function supabaseSelect(table, filters = {}) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  let query = supabase.from(table).select("*");
  
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value);
  }
  
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function supabaseInsert(table, data) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: result, error } = await supabase.from(table).insert(data).select().single();
  if (error) throw new Error(error.message);
  return result;
}

async function supabaseUpdate(table, id, data) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: result, error } = await supabase.from(table).update(data).eq("id", id).select().single();
  if (error) throw new Error(error.message);
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRequestId(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  return v.slice(0, 128);
}

function enforceLocalRateLimits(tgUserId) {
  const key = String(tgUserId);
  const now = Date.now();
  const prev = localActionRate.get(key) || { windowStart: now, count: 0, lastAt: 0 };

  if (now - prev.windowStart >= 60_000) {
    prev.windowStart = now;
    prev.count = 0;
  }
  if (prev.count >= ACTION_RATE_LIMIT_PER_MIN) {
    throw new Error("Слишком много запросов. Попробуйте через минуту.");
  }
  if (prev.lastAt && now - prev.lastAt < ACTION_MIN_INTERVAL_MS) {
    throw new Error("Слишком частые действия. Подождите немного.");
  }
  prev.count += 1;
  prev.lastAt = now;
  localActionRate.set(key, prev);
}

async function enforceDbRateLimit(supabase, tgUserId) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabase
    .from("roulette_action_logs")
    .select("id", { count: "exact", head: true })
    .eq("tg_user_id", String(tgUserId))
    .gte("created_at", since);
  if (error) {
    console.warn("[Roulette API] rate-limit db check failed:", error.message);
    return;
  }
  if ((count || 0) >= ACTION_RATE_LIMIT_PER_MIN) {
    throw new Error("Слишком много запросов. Попробуйте через минуту.");
  }
}

async function enforceDbMinInterval(supabase, tgUserId) {
  const { data, error } = await supabase
    .from("roulette_action_logs")
    .select("created_at")
    .eq("tg_user_id", String(tgUserId))
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.[0]?.created_at) return;
  const lastMs = new Date(data[0].created_at).getTime();
  if (Number.isFinite(lastMs) && Date.now() - lastMs < ACTION_MIN_INTERVAL_MS) {
    throw new Error("Слишком частые действия. Подождите немного.");
  }
}

async function createActionLogProcessing(supabase, { tgUserId, action, requestId, meta }) {
  const payload = {
    tg_user_id: String(tgUserId),
    action: String(action),
    request_id: requestId || null,
    status: "processing",
    meta: meta || {},
    updated_at: nowIso(),
  };
  const { data, error } = await supabase.from("roulette_action_logs").insert(payload).select().single();
  if (!error && data) return { mode: "new", row: data };

  const errMsg = String(error?.message || "");
  if (/roulette_action_logs|does not exist|schema cache/i.test(errMsg)) {
    // Миграция ещё не применена — продолжаем без DB-idempotency, чтобы не падать в проде.
    return { mode: "new", row: null };
  }

  // duplicate idempotency key
  if (requestId && String(error?.code || "") === "23505") {
    const { data: existing } = await supabase
      .from("roulette_action_logs")
      .select("id,status,result_json,created_at")
      .eq("tg_user_id", String(tgUserId))
      .eq("action", String(action))
      .eq("request_id", requestId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = existing?.[0];
    if (row?.status === "success" && row?.result_json) {
      return { mode: "replay", row };
    }
    throw new Error("Повторный запрос уже обрабатывается");
  }

  throw new Error(error?.message || "Не удалось создать action log");
}

async function finalizeActionLog(supabase, id, status, result, reason, suspicious = false) {
  if (!id) return;
  const patch = {
    status,
    updated_at: nowIso(),
    ...(reason ? { reason: String(reason).slice(0, 400) } : {}),
    ...(typeof suspicious === "boolean" ? { suspicious } : {}),
  };
  if (result !== undefined) patch.result_json = result;
  await supabase.from("roulette_action_logs").update(patch).eq("id", id);
}

// ============================================
// ROULETTE LOGIC
// ============================================

async function getActiveRound() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Ищем активные раунды (waiting, active, spinning)
  const { data: activeRound, error: activeError } = await supabase
    .from("roulette_rounds")
    .select("*")
    .in("status", ["waiting", "active", "spinning"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  
  if (activeRound) return activeRound;
  
  // Если нет активного, ищем недавно завершенный (finished за последние 10 секунд)
  // Это нужно чтобы все пользователи успели увидеть модалку победителя
  const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
  
  const { data: finishedRound, error: finishedError } = await supabase
    .from("roulette_rounds")
    .select("*")
    .eq("status", "finished")
    .gte("finished_at", tenSecondsAgo)
    .order("finished_at", { ascending: false })
    .limit(1)
    .single();
  
  if (finishedRound) return finishedRound;
  
  // Если ошибка не "не найдено", выбрасываем её
  if (activeError && activeError.code !== "PGRST116") throw new Error(activeError.message);
  if (finishedError && finishedError.code !== "PGRST116") throw new Error(finishedError.message);
  
  return null;
}

async function getRoundBets(roundId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data, error } = await supabase
    .from("roulette_bets")
    .select("*, users!inner(first_name, last_name, username)")
    .eq("round_id", roundId)
    .order("created_at", { ascending: true });
  
  if (error) throw new Error(error.message);
  return data || [];
}

async function createNewRound() {
  return await supabaseInsert("roulette_rounds", {
    status: "waiting",
    pot_amount: 0,
    players_count: 0,
    total_bets_count: 0,
    platform_fee_percent: PLATFORM_FEE_PERCENT
  });
}

async function calculateChances(roundId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Получить банк раунда
  const { data: round } = await supabase
    .from("roulette_rounds")
    .select("pot_amount")
    .eq("id", roundId)
    .single();
  
  if (!round || round.pot_amount === 0) return;
  
  // Получить все ставки
  const { data: bets } = await supabase
    .from("roulette_bets")
    .select("id, bet_amount")
    .eq("round_id", roundId);
  
  if (!bets || bets.length === 0) return;
  
  // Обновить шансы
  for (const bet of bets) {
    const chance = (bet.bet_amount / round.pot_amount) * 100;
    await supabase
      .from("roulette_bets")
      .update({ chance_percent: chance })
      .eq("id", bet.id);
  }
}

/**
 * Один криптографический бросок r∈[0,1) и проход по кольцу шансов — как на donut-колесе (sort by user_id, вес max(0.35, chance)).
 * Победитель и визуальная остановка колеса определяются ТОЛЬКО этим r (spin_pick в БД).
 */
function pickDonutSpinOutcome(bets) {
  if (!bets || bets.length < 2) {
    throw new Error("Недостаточно игроков для розыгрыша");
  }
  const sorted = [...bets].sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  const weights = sorted.map((b) => Math.max(0.35, parseFloat(b.chance_percent) || 0));
  const sum = weights.reduce((x, y) => x + y, 0) || 1;

  const buf = crypto.randomBytes(8);
  const rv = buf.readBigUInt64BE(0);
  const maxV = BigInt("0xFFFFFFFFFFFFFFFF");
  let r = Number(rv) / Number(maxV);
  if (!Number.isFinite(r) || r >= 1) r = 1 - Number.EPSILON * 4;
  if (r <= 0) r = Number.EPSILON * 4;

  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    const share = weights[i] / sum;
    const next = acc + share;
    if (r < next || i === sorted.length - 1) {
      return {
        winnerBet: sorted[i],
        winnerUserId: sorted[i].user_id,
        spinPick: r,
        sortedIndex: i,
      };
    }
    acc = next;
  }
  return {
    winnerBet: sorted[sorted.length - 1],
    winnerUserId: sorted[sorted.length - 1].user_id,
    spinPick: r,
    sortedIndex: sorted.length - 1,
  };
}

// ============================================
// API HANDLERS
// ============================================

async function getTelegramPhotoUrl(userId) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${userId}&limit=1`
    );
    const data = await response.json();
    
    if (data.ok && data.result?.photos?.length > 0) {
      const photo = data.result.photos[0];
      // Берем фото среднего размера (обычно индекс 1 или 2)
      const fileId = photo[Math.min(1, photo.length - 1)]?.file_id;
      
      if (fileId) {
        // Получаем путь к файлу
        const fileResponse = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
        );
        const fileData = await fileResponse.json();
        
        if (fileData.ok && fileData.result?.file_path) {
          return `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching Telegram photo:', error);
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ============================================
// TELEGRAM AVATAR CACHE (in-memory, best-effort)
// ============================================
// Важно: serverless инстансы могут быть холодными, но кэш всё равно
// резко снижает количество запросов к Telegram при частом polling.
const AVATAR_TTL_OK_MS = 5 * 60 * 1000; // 5 минут
const AVATAR_TTL_NULL_MS = 60 * 1000; // 1 минута (чтобы не спамить Telegram при таймаутах)
const avatarCache = new Map(); // userId -> { url: string|null, ts: number }

function cacheGet(userId) {
  const k = String(userId || "").trim();
  if (!k) return undefined;
  const v = avatarCache.get(k);
  if (!v) return undefined;
  const age = Date.now() - Number(v.ts || 0);
  const ttl = v.url ? AVATAR_TTL_OK_MS : AVATAR_TTL_NULL_MS;
  if (age > ttl) {
    avatarCache.delete(k);
    return undefined;
  }
  return v.url || null;
}

function cacheSet(userId, url) {
  const k = String(userId || "").trim();
  if (!k) return;
  avatarCache.set(k, { url: url ? String(url) : null, ts: Date.now() });
  // Ограничим рост (простая эвикция)
  if (avatarCache.size > 500) {
    const firstKey = avatarCache.keys().next().value;
    if (firstKey) avatarCache.delete(firstKey);
  }
}

async function getTelegramPhotoUrlCached(userId, timeoutMs) {
  const cached = cacheGet(userId);
  if (cached !== undefined) return cached; // может быть строкой или null
  // cached === undefined означает "нет в кэше или истёк" — попробуем получить
  let url = null;
  try {
    url = await withTimeout(getTelegramPhotoUrl(userId), timeoutMs);
  } catch {
    url = null;
  }
  cacheSet(userId, url);
  return url;
}

// Детерминированная "случайная" функция на основе seed
function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function getAdaptiveWheelCardCount(playerCount) {
  const n = Math.max(1, Number(playerCount) || 1);
  // Фиксированная квота на игрока + разумные границы.
  // Даёт предсказуемую плотность колеса без чрезмерной длины.
  const cards = n * 24;
  return Math.max(240, Math.min(720, cards));
}

// Генерация массива карточек для рулетки:
// - кол-во карточек строго пропорционально bet_amount (шансам)
// - порядок случайный, но детерминированный по seed (чтобы все клиенты видели одинаково)
function generateWheelCards(bets, seedInput, totalCards = 360) {
  const sorted = [...(bets || [])].sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  const totalBet = sorted.reduce((sum, bet) => sum + parseFloat(bet.bet_amount || 0), 0);
  if (!(totalBet > 0) || sorted.length === 0) return [];

  // 1) каждому игроку с ненулевой ставкой минимум 1 карточка (иначе может стать "0%" на колесе)
  const basePlayers = sorted.filter((b) => parseFloat(b.bet_amount || 0) > 0);
  const minEach = Math.min(basePlayers.length, totalCards);
  let remaining = totalCards - minEach;

  const raw = basePlayers.map((bet) => {
    const amt = parseFloat(bet.bet_amount || 0);
    const share = amt / totalBet;
    return {
      user_id: bet.user_id,
      display_name:
        bet.display_name ||
        displayNameFromProfile(bet.users?.first_name, bet.users?.last_name, bet.users?.username),
      photo_url: bet.photo_url || null,
      colorIndex: Math.abs(hashCode(String(bet.user_id))) % 5,
      share,
      base: 1,
      extra: 0,
      frac: 0,
    };
  });

  // 2) распределяем оставшиеся карточки методом наибольших дробных частей
  if (remaining > 0) {
    let sumFloor = 0;
    for (const p of raw) {
      const want = p.share * remaining;
      const f = Math.floor(want);
      p.extra = f;
      p.frac = want - f;
      sumFloor += f;
    }
    let left = remaining - sumFloor;
    raw.sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < raw.length && left > 0; i++, left--) {
      raw[i].extra += 1;
    }
    // возвращаем порядок к стабильному (по user_id), но shuffle ниже всё равно всё перемешает
    raw.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  }

  // 3) наполняем массив карточек
  const cards = [];
  for (const p of raw) {
    const count = p.base + p.extra;
    for (let i = 0; i < count; i++) {
      cards.push({
        user_id: p.user_id,
        display_name: p.display_name,
        photo_url: p.photo_url,
        colorIndex: p.colorIndex,
      });
    }
  }

  // 4) на всякий случай подгоняем размер (из-за minEach / remaining крайних случаев)
  if (cards.length > totalCards) cards.length = totalCards;
  while (cards.length < totalCards) {
    const p = raw[cards.length % raw.length];
    cards.push({
      user_id: p.user_id,
      display_name: p.display_name,
      photo_url: p.photo_url,
      colorIndex: p.colorIndex,
    });
  }

  // 5) детерминированный shuffle
  const seed = fnv1a32(seedInput);
  const rand = mulberry32(seed);
  shuffleInPlace(cards, rand);
  return cards;
}

// Генерация HTML карточек на СЕРВЕРЕ
function generateWheelCardsHTML(cards) {
  const colors = [
    'linear-gradient(135deg, #8CFFC1, #4DFF9A)',
    'linear-gradient(135deg, #fbbf24, #f59e0b)',
    'linear-gradient(135deg, #fb923c, #f97316)',
    'linear-gradient(135deg, #a78bfa, #8b5cf6)',
    'linear-gradient(135deg, #60a5fa, #3b82f6)',
  ];
  
  return cards.map((card, index) => {
    const color = colors[card.colorIndex % colors.length];
    const initial = (card.display_name || 'P').charAt(0).toUpperCase();
    
    // Аватар: фото или инициал
    const avatarContent = card.photo_url 
      ? `<img src="${escapeHtml(card.photo_url)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:900; font-size:18px; color:#07110c;">${initial}</div>`
      : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:18px; color:#07110c;">${initial}</div>`;

    return `
      <div class="roulette-card" data-user-id="${card.user_id}" data-card-index="${index}" style="
        min-width:100px;
        width:100px;
        height:100%;
        background:${color};
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        padding:8px;
        border-right:2px solid rgba(0,0,0,0.3);
        flex-shrink:0;
      ">
        <div style="width:48px; height:48px; border-radius:50%; background:rgba(255,255,255,0.9); overflow:hidden; margin-bottom:6px; flex-shrink:0;">
          ${avatarContent}
        </div>
        <div style="font-size:11px; font-weight:800; color:rgba(0,0,0,0.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; text-align:center;">
          ${escapeHtml(card.display_name)}
        </div>
      </div>
    `;
  }).join('');
}

// Escape HTML на сервере
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Простая хеш-функция для стабильного цвета
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

async function handleGetActiveRound(body) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  let round = await getActiveRound();
  
  if (!round) {
    return { ok: true, round: null, bets: [], wheelCardsHTML: '', serverTime: new Date().toISOString(), roulette_timer_duration_seconds: TIMER_DURATION };
  }

  // SERVER-DRIVEN SPIN:
  // Если таймер истек, сервер сам (однократно) переводит active -> spinning -> finished.
  if (round.status === 'active' && round.timer_ends_at) {
    const nowMs = Date.now();
    const endMs = new Date(round.timer_ends_at).getTime();
    if (Number.isFinite(endMs) && nowMs >= endMs) {
      try {
        const locked = await tryLockRoundForSpin(supabase, round.id, true);
        if (locked) {
          await finalizeRoundSpin(supabase, locked);
          const { data: refreshed } = await supabase
            .from("roulette_rounds")
            .select("*")
            .eq("id", round.id)
            .single();
          if (refreshed) round = refreshed;
        }
      } catch (e) {
        console.error("[Roulette API] auto-spin failed:", e?.message || e);
      }
    }
  }
  
  const bets = await getRoundBets(round.id);

  // Аватарки нужны на карточках, но нельзя тормозить polling.
  // Поэтому тянем через кэш и с коротким таймаутом (best-effort).
  const betsWithPhotos = await Promise.all(
    (bets || []).map(async (bet) => {
      const displayName = displayNameFromProfile(
        bet.users?.first_name,
        bet.users?.last_name,
        bet.users?.username
      );
      const photoUrl = await getTelegramPhotoUrlCached(bet.user_id, 650);
      return {
        id: bet.id,
        user_id: bet.user_id,
        bet_amount: bet.bet_amount,
        chance_percent: bet.chance_percent,
        display_name: displayName,
        created_at: bet.created_at,
        photo_url: photoUrl,
      };
    })
  );

  const betsLight = (betsWithPhotos || []).map((bet) => {
    const displayName = bet.display_name || "Player";
    return {
      id: bet.id,
      user_id: bet.user_id,
      bet_amount: bet.bet_amount,
      chance_percent: bet.chance_percent,
      display_name: displayName,
      created_at: bet.created_at,
      photo_url: bet.photo_url || null,
    };
  });
  
  // ГЕНЕРИРУЕМ КАРТОЧКИ НА СЕРВЕРЕ
  // КРИТИЧЕСКИ ВАЖНО: порядок карточек должен быть ОДИН на весь раунд,
  // иначе winner_card_index может указывать на другую карточку на фронте.
  const wheelSeed = `${round.id}`;
  const wheelCardsCount = getAdaptiveWheelCardCount(betsLight.length);
  const wheelCards = betsLight.length > 0 
    ? generateWheelCards(betsLight, wheelSeed, wheelCardsCount) 
    : [];

  // Победитель и угол остановки: spin_pick + winner_user_id из БД (после finalizeRoundSpin).
  // Старый self-heal по winner_card_index / ленте карточек отключён — он расходился с donut UI.

  // ГЕНЕРИРУЕМ HTML НА СЕРВЕРЕ
  const wheelCardsHTML = wheelCards.length > 0 
    ? generateWheelCardsHTML(wheelCards)
    : '';
  
  console.log('[Roulette API] Generated', wheelCards.length, 'cards and HTML for round', round.id, 'with', betsLight.length, 'players');

  // Если раунд завершён — вернём winner объект (включая photo_url), чтобы всем клиентам было что показать.
  let winner = null;
  if (round.status === 'finished' && round.winner_user_id) {
    const winnerBet = (betsLight || []).find((b) => String(b.user_id) === String(round.winner_user_id));
    const displayName = winnerBet?.display_name || "Player";
    let photoUrl = null;
    try {
      // Для победителя важнее точность, чем микролатентность:
      // если в bets нет фото, принудительно пробуем прямой запрос (без null-кэша).
      photoUrl = winnerBet?.photo_url;
      if (!photoUrl) {
        try {
          photoUrl = await withTimeout(getTelegramPhotoUrl(round.winner_user_id), 1500);
          if (photoUrl) cacheSet(round.winner_user_id, photoUrl);
        } catch {
          photoUrl = await getTelegramPhotoUrlCached(round.winner_user_id, 900);
        }
      }
    } catch {
      photoUrl = null;
    }
    winner = { user_id: String(round.winner_user_id), display_name: displayName, photo_url: photoUrl };
  }
  
  return {
    ok: true,
    round,
    bets: betsLight,
    wheelCardsHTML,
    serverTime: new Date().toISOString(),
    winner,
    winner_card_index: round.winner_card_index ?? null,
    spin_seed: round.spin_seed ?? null,
    spin_pick: round.spin_pick != null && round.spin_pick !== "" ? Number(round.spin_pick) : null,
    roulette_timer_duration_seconds: TIMER_DURATION,
  };
}

async function tryLockRoundForSpin(supabase, roundId, requireTimerExpired = false) {
  let q = supabase
    .from("roulette_rounds")
    .update({ status: "spinning" })
    .eq("id", roundId)
    .eq("status", "active");

  if (requireTimerExpired) {
    q = q.lte("timer_ends_at", new Date().toISOString());
  }

  const { data, error } = await q.select().single();
  if (error || !data) return null;
  return data;
}

async function finalizeRoundSpin(supabase, round) {
  // Получить все ставки
  const bets = await getRoundBets(round.id);
  if (bets.length < 2) {
    await supabaseUpdate("roulette_rounds", round.id, { status: "active" });
    throw new Error("Недостаточно игроков для розыгрыша");
  }

  // Один криптобросок r∈[0,1) на кольце шансов (как donut UI): по нему и выплата, и угол спина.
  const spinSeed = crypto.randomBytes(4).readUInt32BE(0);
  const outcome = pickDonutSpinOutcome(bets);
  const winnerId = outcome.winnerUserId;
  const winnerBet = outcome.winnerBet;
  const spinPick = outcome.spinPick;
  const winnerSortedIndex = outcome.sortedIndex;

  const totalPot = parseFloat(round.pot_amount);
  const platformFee = totalPot * (PLATFORM_FEE_PERCENT / 100);
  const winnerAmount = totalPot - platformFee;

  const { data: winner } = await supabase
    .from("users")
    .select("balance")
    .eq("tg_user_id", winnerId)
    .single();

  if (winner) {
    await supabase
      .from("users")
      .update({ balance: parseFloat(winner.balance) + winnerAmount })
      .eq("tg_user_id", winnerId);
  }

  await supabaseUpdate("roulette_rounds", round.id, {
    status: "finished",
    winner_user_id: winnerId,
    winner_amount: winnerAmount,
    platform_fee_amount: platformFee,
    finished_at: new Date().toISOString(),
    spin_seed: spinSeed,
    spin_pick: spinPick,
    winner_card_index: winnerSortedIndex,
  });

  const winnerDisplayName = displayNameFromProfile(
    winnerBet.users?.first_name,
    winnerBet.users?.last_name,
    winnerBet.users?.username
  );

  let winnerPhotoUrl = null;
  try {
    winnerPhotoUrl = await withTimeout(getTelegramPhotoUrl(winnerId), 1500);
  } catch {
    winnerPhotoUrl = null;
  }

  await supabaseInsert("roulette_results", {
    round_id: round.id,
    winner_user_id: winnerId,
    winner_amount: winnerAmount,
    total_pot: totalPot,
    platform_fee: platformFee,
    players_count: round.players_count,
    winner_chance_percent: parseFloat(winnerBet.chance_percent),
    winner_display_name: winnerDisplayName,
    winner_bet_amount: parseFloat(winnerBet.bet_amount)
  });

  for (const bet of bets) {
    const isWinner = String(bet.user_id) === String(winnerId);
    const eventType = isWinner ? "win" : "loss";
    const amount = isWinner ? winnerAmount : -parseFloat(bet.bet_amount);
    const text = isWinner
      ? `Победа в рулетке +${winnerAmount.toFixed(2)} TON`
      : `Проигрыш в рулетке -${parseFloat(bet.bet_amount).toFixed(2)} TON`;

    await supabaseInsert("pvp_balance_events", {
      tg_user_id: bet.user_id,
      room_id: null,
      game_key: "roulette",
      event_type: eventType,
      amount: amount,
      stake_ton: parseFloat(bet.bet_amount),
      meta: {
        reason: "roulette_finished",
        text: text,
        round_id: round.id,
        players_count: round.players_count,
        total_pot: totalPot,
        winner_user_id: winnerId,
        winner_display_name: winnerDisplayName,
        winner_amount: winnerAmount,
        spin_pick: spinPick,
        my_chance: parseFloat(bet.chance_percent),
        my_bet: parseFloat(bet.bet_amount)
      }
    });
  }

  return {
    winner: {
      user_id: winnerId,
      display_name: winnerDisplayName,
      amount: winnerAmount,
      chance: parseFloat(winnerBet.chance_percent),
      bet: parseFloat(winnerBet.bet_amount),
      photo_url: winnerPhotoUrl
    },
    round_id: round.id,
    winner_card_index: winnerSortedIndex,
    spin_seed: spinSeed,
    spin_pick: spinPick,
    round: {
      id: round.id,
      total_pot: totalPot,
      platform_fee: platformFee,
      players_count: round.players_count
    }
  };
}

async function handleSpinRoulette(body, tgUserId) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Получить активный раунд
  const round = await getActiveRound();
  if (!round) {
    throw new Error("Нет активного раунда");
  }
  
  // Проверить что раунд в статусе active (не spinning и не finished)
  if (round.status === 'spinning') {
    // Раунд уже крутится - просто ждем
    throw new Error("Розыгрыш уже идет, ожидайте результата");
  }
  
  if (round.status === 'finished') {
    throw new Error("Раунд уже завершен");
  }
  
  if (round.status !== 'active') {
    throw new Error("Раунд не активен");
  }
  
  // Проверить что таймер истек.
  // ВАЖНО: без раннего старта, иначе у инициатора спин начинается раньше остальных.
  if (round.timer_ends_at) {
    const endsAt = new Date(round.timer_ends_at);
    const now = new Date();
    const diff = now - endsAt;
    
    // Разрешаем старт только когда таймер реально истек (с минимальным допуском на лаг).
    if (diff < -150) {
      const remaining = Math.ceil(-diff / 1000);
      throw new Error(`Таймер еще не истек. Осталось ${remaining} сек`);
    }
  }
  
  // АТОМАРНО меняем статус на spinning (защита от двойного спина)
  const lockedRound = await tryLockRoundForSpin(supabase, round.id, false);
  if (!lockedRound) {
    // Кто-то другой уже начал спин
    throw new Error("Розыгрыш уже запущен другим игроком");
  }

  const result = await finalizeRoundSpin(supabase, lockedRound);
  return { ok: true, ...result };
}

async function handleJoinRound(body, tgUserId) {
  const { betAmount } = body;
  
  if (!betAmount || betAmount < MIN_BET) {
    throw new Error(`Минимальная ставка: ${MIN_BET} TON`);
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Проверить баланс
  const { data: user } = await supabase
    .from("users")
    .select("balance")
    .eq("tg_user_id", tgUserId)
    .single();
  
  if (!user || user.balance < betAmount) {
    throw new Error("Недостаточно средств");
  }
  
  // Получить или создать раунд.
  // ВАЖНО: getActiveRound может вернуть недавно finished (для показа модалки),
  // но в finished/spinning ставки принимать нельзя.
  let round = await getActiveRound();
  if (!round || round.status === 'finished') {
    round = await createNewRound();
  } else if (round.status === 'spinning') {
    throw new Error("Розыгрыш уже идет, дождитесь следующего раунда");
  }
  if (round.status === 'active' && round.timer_ends_at) {
    const msLeft = new Date(round.timer_ends_at).getTime() - Date.now();
    if (Number.isFinite(msLeft) && msLeft <= 0) {
      throw new Error("Таймер истек, дождитесь следующего раунда");
    }
  }
  
  // Получить раунд с блокировкой FOR UPDATE
  const { data: lockedRound, error: lockError } = await supabase
    .rpc('get_and_lock_round', { round_id: round.id });
  
  if (lockError) {
    // Если нет функции, используем обычный запрос
    const { data: freshRound } = await supabase
      .from("roulette_rounds")
      .select("*")
      .eq("id", round.id)
      .single();
    round = freshRound || round;
  } else if (lockedRound && lockedRound.length > 0) {
    round = lockedRound[0];
  }
  
  // Проверить что пользователь еще не в раунде
  const { data: existingBet } = await supabase
    .from("roulette_bets")
    .select("id")
    .eq("round_id", round.id)
    .eq("user_id", tgUserId)
    .single();
  
  if (existingBet) {
    throw new Error("Вы уже в этом раунде. Используйте повышение ставки.");
  }
  
  // Добавить ставку
  await supabaseInsert("roulette_bets", {
    round_id: round.id,
    user_id: tgUserId,
    bet_amount: betAmount,
    chance_percent: 0
  });
  
  // Получить ВСЕ ставки и пересчитать банк и игроков
  const { data: allBets } = await supabase
    .from("roulette_bets")
    .select("user_id, bet_amount")
    .eq("round_id", round.id);
  
  // Считаем реальный банк из всех ставок
  const realPot = (allBets || []).reduce((sum, bet) => sum + parseFloat(bet.bet_amount || 0), 0);
  
  // Считаем уникальных игроков
  const uniquePlayerIds = [...new Set((allBets || []).map(b => b.user_id))];
  const newPlayersCount = uniquePlayerIds.length;
  const wasOnePlayer = round.players_count <= 1;
  const isSecondPlayer = newPlayersCount === 2 && wasOnePlayer;
  
  // Обновить раунд
  const updateData = {
    pot_amount: realPot,
    players_count: newPlayersCount,
    total_bets_count: (allBets || []).length
  };
  
  // Таймер: стартует когда игроков стало >=2, и СБРАСЫВАЕТСЯ на TIMER_DURATION сек при каждом новом игроке.
  // Это даёт всем "досыпать" игроков перед розыгрышем.
  if (newPlayersCount >= 2) {
    // Если это второй игрок — фиксируем started_at (одноразово).
    if (isSecondPlayer) {
      updateData.started_at = new Date().toISOString();
    }
    updateData.status = "active";
    updateData.timer_ends_at = new Date(Date.now() + TIMER_DURATION * 1000).toISOString();
  }
  
  await supabaseUpdate("roulette_rounds", round.id, updateData);
  
  // Пересчитать шансы на основе реального банка
  await calculateChances(round.id);
  
  // Списать со счета
  await supabase
    .from("users")
    .update({ balance: user.balance - betAmount })
    .eq("tg_user_id", tgUserId);
  
  return { ok: true, message: "Ставка принята" };
}

async function handleRaiseBet(body, tgUserId) {
  const { raiseAmount } = body;
  
  if (!raiseAmount || raiseAmount < MIN_BET) {
    throw new Error(`Минимальное повышение: ${MIN_BET} TON`);
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Проверить баланс
  const { data: user } = await supabase
    .from("users")
    .select("balance")
    .eq("tg_user_id", tgUserId)
    .single();
  
  if (!user || user.balance < raiseAmount) {
    throw new Error("Недостаточно средств");
  }
  
  // Получить активный раунд
  let round = await getActiveRound();
  if (!round) {
    throw new Error("Нет активного раунда");
  }
  if (round.status === 'spinning') {
    throw new Error("Розыгрыш уже идет, ставку повышать нельзя");
  }
  if (round.status === 'finished') {
    throw new Error("Раунд уже завершен");
  }
  if (!roundStatusAllowsRaise(round.status)) {
    throw new Error("Раунд не активен для повышения ставки");
  }
  if (round.status === 'active' && round.timer_ends_at) {
    const msLeft = new Date(round.timer_ends_at).getTime() - Date.now();
    if (Number.isFinite(msLeft) && msLeft <= 0) {
      throw new Error("Таймер истек, ставку повышать нельзя");
    }
  }

  // КРИТИЧЕСКИ ВАЖНО: берём блокировку раунда перед изменением ставки,
  // чтобы не было гонки с переводом active -> spinning и выбором победителя.
  const { data: lockedRound, error: lockError } = await supabase
    .rpc('get_and_lock_round', { round_id: round.id });
  if (lockError) {
    // Если RPC недоступна, делаем жёсткий re-check статуса прямо перед апдейтами.
    const { data: freshRound, error: freshErr } = await supabase
      .from("roulette_rounds")
      .select("id,status")
      .eq("id", round.id)
      .single();
    if (freshErr || !freshRound || !roundStatusAllowsRaise(freshRound.status)) {
      throw new Error("Розыгрыш уже идет, ставку повышать нельзя");
    }
  } else if (lockedRound && lockedRound.length > 0) {
    round = lockedRound[0];
    if (!roundStatusAllowsRaise(round.status)) {
      throw new Error("Розыгрыш уже идет, ставку повышать нельзя");
    }
  }
  
  // Получить ставку пользователя
  const { data: bet } = await supabase
    .from("roulette_bets")
    .select("*")
    .eq("round_id", round.id)
    .eq("user_id", tgUserId)
    .single();
  
  if (!bet) {
    throw new Error("Вы не в этом раунде");
  }
  
  // Обновить ставку
  await supabase
    .from("roulette_bets")
    .update({ 
      bet_amount: parseFloat(bet.bet_amount) + raiseAmount,
      updated_at: new Date().toISOString()
    })
    .eq("id", bet.id);
  
  // Получить ВСЕ ставки и пересчитать банк
  const { data: allBets } = await supabase
    .from("roulette_bets")
    .select("user_id, bet_amount")
    .eq("round_id", round.id);
  
  // Считаем реальный банк из всех ставок
  const realPot = (allBets || []).reduce((sum, b) => sum + parseFloat(b.bet_amount || 0), 0);
  
  // Обновить раунд (таймер НЕ обновляется!)
  await supabaseUpdate("roulette_rounds", round.id, {
    pot_amount: realPot,
    total_bets_count: (allBets || []).length
  });
  
  // Пересчитать шансы на основе реального банка
  await calculateChances(round.id);
  
  // Списать со счета
  await supabase
    .from("users")
    .update({ balance: user.balance - raiseAmount })
    .eq("tg_user_id", tgUserId);
  
  // Возвращаем актуальные данные после пересчёта, чтобы клиент сразу видел
  // новые шансы/ставку без промежуточной устаревшей фазы.
  const { data: refreshedBet } = await supabase
    .from("roulette_bets")
    .select("bet_amount, chance_percent")
    .eq("round_id", round.id)
    .eq("user_id", tgUserId)
    .single();
  
  return {
    ok: true,
    message: "Ставка повышена",
    my_bet: refreshedBet ? {
      bet_amount: parseFloat(refreshedBet.bet_amount || 0),
      chance_percent: parseFloat(refreshedBet.chance_percent || 0),
    } : null,
  };
}

async function handleGetRecentWinners(body) {
  const limit = Math.max(1, Math.min(50, Number(body.limit) || 10));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: recent, error: errRecent }, { data: topArr, error: errTop }] = await Promise.all([
    supabase.from("roulette_results").select("*").order("created_at", { ascending: false }).limit(limit),
    supabase.from("roulette_results").select("*").order("winner_amount", { ascending: false }).limit(1),
  ]);

  if (errRecent) throw new Error(errRecent.message);
  if (errTop) throw new Error(errTop.message);

  const winnersWithPhotos = await Promise.all(
    (recent || []).map(async (winner) => {
      const photoUrl = await getTelegramPhotoUrl(winner.winner_user_id);
      return {
        ...winner,
        photo_url: photoUrl,
      };
    })
  );

  const topRaw = topArr?.[0] || null;
  let topGame = null;
  if (topRaw) {
    const found = winnersWithPhotos.find((w) => w.id === topRaw.id);
    if (found) {
      topGame = found;
    } else {
      const photoUrl = await getTelegramPhotoUrl(topRaw.winner_user_id);
      topGame = { ...topRaw, photo_url: photoUrl };
    }
  }

  const lastGame = winnersWithPhotos[0] || null;

  return {
    ok: true,
    winners: winnersWithPhotos,
    lastGame,
    topGame,
  };
}

async function handleGetMyHistory(body, tgUserId) {
  const { limit = 10 } = body;
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 10));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from("roulette_bets")
    .select(`
      id,
      user_id,
      bet_amount,
      chance_percent,
      created_at,
      round:roulette_rounds!inner(
        id,
        status,
        winner_user_id,
        winner_amount,
        pot_amount,
        platform_fee_amount,
        finished_at,
        created_at
      )
    `)
    .eq("user_id", String(tgUserId))
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new Error(error.message);

  const history = (data || []).map((row) => {
    const round = row.round || {};
    const status = String(round.status || "waiting");
    const betAmount = parseFloat(row.bet_amount || 0);
    const myChance = parseFloat(row.chance_percent || 0);
    const isFinished = status === "finished";
    const isWinner = isFinished && String(round.winner_user_id || "") === String(tgUserId);
    const result = !isFinished ? "pending" : (isWinner ? "win" : "loss");
    const amountTon = !isFinished ? null : (isWinner ? parseFloat(round.winner_amount || 0) : -betAmount);

    return {
      bet_id: row.id,
      round_id: round.id || null,
      round_status: status,
      result,
      bet_amount: betAmount,
      chance_percent: myChance,
      amount_ton: amountTon,
      total_pot: parseFloat(round.pot_amount || 0),
      finished_at: round.finished_at || null,
      created_at: row.created_at,
    };
  });

  return { ok: true, history };
}

/** Общая история завершённых раундов (по таблице roulette_results). */
async function handleGetPublicRouletteHistory(body) {
  const filter = String(body?.filter || "recent").toLowerCase();
  const limit = Math.max(1, Math.min(60, Number(body.limit) || 40));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let query = supabase.from("roulette_results").select("*");
  if (filter === "large") {
    query = query.order("winner_amount", { ascending: false }).limit(limit);
  } else if (filter === "lucky") {
    query = query
      .lte("winner_chance_percent", 15)
      .order("created_at", { ascending: false })
      .limit(limit);
  } else {
    query = query.order("created_at", { ascending: false }).limit(limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const history = await Promise.all(
    (data || []).map(async (row) => {
      const photoUrl = await getTelegramPhotoUrl(row.winner_user_id);
      return { ...row, photo_url: photoUrl };
    })
  );

  return { ok: true, history };
}

// ============================================
// MAIN HANDLER
// ============================================

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const { action, initData } = body;

    if (!action) {
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    const allowedActions = new Set([
      "getRecentWinners",
      "getPublicRouletteHistory",
      "getMyHistory",
      "getActiveRound",
      "joinRound",
      "raiseBet",
      "spinRoulette",
    ]);
    if (!allowedActions.has(action)) {
      return res.status(400).json({ ok: false, error: "Unknown action" });
    }

    // Actions that don't require auth
    if (action === "getRecentWinners") {
      const result = await handleGetRecentWinners(body);
      return res.status(200).json(result);
    }
    if (action === "getPublicRouletteHistory") {
      const result = await handleGetPublicRouletteHistory(body);
      return res.status(200).json(result);
    }

    // Verify Telegram auth for other actions
    const verification = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!verification.ok) {
      return res.status(401).json({ ok: false, error: verification.error });
    }

    const tgUserId = verification.user.id;
    const requestId = normalizeRequestId(body.request_id || body.idempotency_key || body.idempotencyKey);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Route actions
    let result;
    const executeAction = async () => {
      switch (action) {
        case "getActiveRound":
          return await handleGetActiveRound(body);
        case "joinRound":
          return await handleJoinRound(body, tgUserId);
        case "raiseBet":
          return await handleRaiseBet(body, tgUserId);
        case "spinRoulette":
          return await handleSpinRoulette(body, tgUserId);
        case "getMyHistory":
          return await handleGetMyHistory(body, tgUserId);
        default:
          throw new Error("Unknown action");
      }
    };

    if (!MUTATING_ACTIONS.has(action)) {
      result = await executeAction();
    } else {
      enforceLocalRateLimits(tgUserId);
      await enforceDbRateLimit(supabase, tgUserId);
      await enforceDbMinInterval(supabase, tgUserId);

      const logStart = await createActionLogProcessing(supabase, {
        tgUserId,
        action,
        requestId,
        meta: {
          ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      if (logStart.mode === "replay") {
        return res.status(200).json(logStart.row.result_json);
      }

      try {
        result = await executeAction();
        await finalizeActionLog(supabase, logStart.row?.id, "success", result, null, false);
      } catch (e) {
        const msg = String(e?.message || e);
        const suspicious = /duplicate|already|гонк|част|rate|таймер истек/i.test(msg);
        await finalizeActionLog(
          supabase,
          logStart.row?.id,
          "rejected",
          { ok: false, error: msg },
          msg,
          suspicious
        );
        throw e;
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Roulette API error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
