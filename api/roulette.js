const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Минимальная ставка
const MIN_BET = 0.1;

// Комиссия платформы (%)
const PLATFORM_FEE_PERCENT = 5.0;

// Длительность таймера (секунды)
const TIMER_DURATION = 20;

// ============================================
// HELPER FUNCTIONS
// ============================================

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

// ============================================
// ROULETTE LOGIC
// ============================================

async function getActiveRound() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data, error } = await supabase
    .from("roulette_rounds")
    .select("*")
    .in("status", ["waiting", "active"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  
  if (error && error.code !== "PGRST116") throw new Error(error.message);
  return data || null;
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

function selectWinner(bets) {
  const totalPot = bets.reduce((sum, bet) => sum + parseFloat(bet.bet_amount), 0);
  
  // Cryptographically secure random
  const randomBuffer = crypto.randomBytes(8);
  const randomValue = randomBuffer.readBigUInt64BE(0);
  const maxValue = BigInt("0xFFFFFFFFFFFFFFFF");
  const random = (Number(randomValue) / Number(maxValue)) * totalPot;
  
  let cumulative = 0;
  for (const bet of bets) {
    cumulative += parseFloat(bet.bet_amount);
    if (random <= cumulative) {
      return bet.user_id;
    }
  }
  
  // Fallback (не должно произойти)
  return bets[bets.length - 1].user_id;
}

// ============================================
// API HANDLERS
// ============================================

async function handleGetActiveRound(body) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const round = await getActiveRound();
  
  if (!round) {
    return { ok: true, round: null, bets: [], serverTime: new Date().toISOString() };
  }
  
  const bets = await getRoundBets(round.id);
  
  return {
    ok: true,
    round,
    bets: bets.map(bet => {
      // Формируем отображаемое имя из доступных полей
      const displayName = bet.users?.username 
        || bet.users?.first_name 
        || "Player";
      
      return {
        id: bet.id,
        user_id: bet.user_id,
        bet_amount: bet.bet_amount,
        chance_percent: bet.chance_percent,
        display_name: displayName,
        created_at: bet.created_at
      };
    }),
    serverTime: new Date().toISOString() // Отправляем серверное время
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
  
  // Проверить что таймер истек (с запасом 5 секунд для сетевой задержки)
  if (round.timer_ends_at) {
    const endsAt = new Date(round.timer_ends_at);
    const now = new Date();
    const diff = now - endsAt;
    
    // Разрешаем спин если прошло хотя бы -5 секунды (5 секунд до истечения)
    if (diff < -5000) {
      const remaining = Math.ceil(-diff / 1000);
      throw new Error(`Таймер еще не истек. Осталось ${remaining} сек`);
    }
  }
  
  // АТОМАРНО меняем статус на spinning (защита от двойного спина)
  const { data: updated, error: updateError } = await supabase
    .from("roulette_rounds")
    .update({ status: "spinning" })
    .eq("id", round.id)
    .eq("status", "active") // Обновится только если статус все еще active
    .select()
    .single();
  
  if (updateError || !updated) {
    // Кто-то другой уже начал спин
    throw new Error("Розыгрыш уже запущен другим игроком");
  }
  
  // Получить все ставки
  const bets = await getRoundBets(round.id);
  if (bets.length < 2) {
    // Откатываем статус обратно
    await supabaseUpdate("roulette_rounds", round.id, { status: "active" });
    throw new Error("Недостаточно игроков для розыгрыша");
  }
  
  // Выбрать победителя
  const winnerId = selectWinner(bets);
  const winnerBet = bets.find(b => b.user_id === winnerId);
  
  if (!winnerBet) {
    // Откатываем статус обратно
    await supabaseUpdate("roulette_rounds", round.id, { status: "active" });
    throw new Error("Ошибка выбора победителя");
  }
  
  // Рассчитать выигрыш
  const totalPot = parseFloat(round.pot_amount);
  const platformFee = totalPot * (PLATFORM_FEE_PERCENT / 100);
  const winnerAmount = totalPot - platformFee;
  
  // Начислить выигрыш победителю
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
  
  // Обновить раунд на finished
  await supabaseUpdate("roulette_rounds", round.id, {
    status: "finished",
    winner_user_id: winnerId,
    winner_amount: winnerAmount,
    platform_fee_amount: platformFee,
    finished_at: new Date().toISOString()
  });
  
  // Сохранить результат в историю
  const winnerDisplayName = winnerBet.users?.username 
    || winnerBet.users?.first_name 
    || "Player";
  
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
  
  return {
    ok: true,
    winner: {
      user_id: winnerId,
      display_name: winnerDisplayName,
      amount: winnerAmount,
      chance: parseFloat(winnerBet.chance_percent),
      bet: parseFloat(winnerBet.bet_amount)
    },
    round: {
      id: round.id,
      total_pot: totalPot,
      platform_fee: platformFee,
      players_count: round.players_count
    }
  };
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
  
  // Получить или создать активный раунд
  let round = await getActiveRound();
  if (!round) {
    round = await createNewRound();
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
  
  // Обновить раунд
  const newPot = parseFloat(round.pot_amount) + betAmount;
  const newPlayersCount = round.players_count + 1;
  const isSecondPlayer = newPlayersCount === 2;
  
  const updateData = {
    pot_amount: newPot,
    players_count: newPlayersCount,
    total_bets_count: round.total_bets_count + 1
  };
  
  // Если это второй игрок - запустить таймер
  if (isSecondPlayer) {
    updateData.status = "active";
    updateData.started_at = new Date().toISOString();
    updateData.timer_ends_at = new Date(Date.now() + TIMER_DURATION * 1000).toISOString();
  }
  
  await supabaseUpdate("roulette_rounds", round.id, updateData);
  
  // Пересчитать шансы
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
  const round = await getActiveRound();
  if (!round) {
    throw new Error("Нет активного раунда");
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
  
  // Обновить раунд (таймер НЕ обновляется!)
  await supabaseUpdate("roulette_rounds", round.id, {
    pot_amount: parseFloat(round.pot_amount) + raiseAmount,
    total_bets_count: round.total_bets_count + 1
  });
  
  // Пересчитать шансы
  await calculateChances(round.id);
  
  // Списать со счета
  await supabase
    .from("users")
    .update({ balance: user.balance - raiseAmount })
    .eq("tg_user_id", tgUserId);
  
  return { ok: true, message: "Ставка повышена" };
}

async function handleGetRecentWinners(body) {
  const { limit = 10 } = body;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const { data, error } = await supabase
    .from("roulette_results")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  
  if (error) throw new Error(error.message);
  
  return {
    ok: true,
    winners: data || []
  };
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

    // Actions that don't require auth
    if (action === "getRecentWinners") {
      const result = await handleGetRecentWinners(body);
      return res.status(200).json(result);
    }

    // Verify Telegram auth for other actions
    const verification = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!verification.ok) {
      return res.status(401).json({ ok: false, error: verification.error });
    }

    const tgUserId = verification.user.id;

    // Route actions
    let result;
    switch (action) {
      case "getActiveRound":
        result = await handleGetActiveRound(body);
        break;
      
      case "joinRound":
        result = await handleJoinRound(body, tgUserId);
        break;
      
      case "raiseBet":
        result = await handleRaiseBet(body, tgUserId);
        break;
      
      case "spinRoulette":
        result = await handleSpinRoulette(body, tgUserId);
        break;
      
      default:
        return res.status(400).json({ ok: false, error: "Unknown action" });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Roulette API error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
