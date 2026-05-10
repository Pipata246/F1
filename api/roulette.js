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

// Детерминированная "случайная" функция на основе seed
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

// Генерация порядка карточек для рулетки (одинаково для всех клиентов)
// КРИТИЧЕСКИ ВАЖНО: Использует только roundId как seed, не зависит от chance_percent
function generateWheelCards(bets, roundId) {
  const totalCards = 200;
  
  // Сортируем ставки по user_id для консистентности
  const sortedBets = [...bets].sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  
  // Вычисляем сколько карточек у каждого игрока на основе bet_amount
  // ВАЖНО: Используем bet_amount, а не chance_percent (chance_percent может быть разным)
  const totalBet = sortedBets.reduce((sum, bet) => sum + parseFloat(bet.bet_amount || 0), 0);
  
  const playerCards = sortedBets.map((bet, index) => {
    const betAmount = parseFloat(bet.bet_amount || 0);
    const percentage = totalBet > 0 ? (betAmount / totalBet) : 0;
    const count = Math.round(percentage * totalCards);
    
    return {
      user_id: bet.user_id,
      display_name: bet.display_name || bet.users?.username || bet.users?.first_name || 'Player',
      photo_url: bet.photo_url || null,
      count: count,
      colorIndex: Math.abs(hashCode(String(bet.user_id))) % 5
    };
  });
  
  // Распределяем карточки равномерно (round-robin)
  const cards = [];
  let cardIndex = 0;
  let safetyCounter = 0;
  const maxIterations = totalCards * 10;
  
  while (cardIndex < totalCards && safetyCounter < maxIterations) {
    safetyCounter++;
    let addedInThisRound = false;
    
    for (let i = 0; i < playerCards.length && cardIndex < totalCards; i++) {
      const pc = playerCards[i];
      if (pc.count > 0) {
        cards.push({
          user_id: pc.user_id,
          display_name: pc.display_name,
          photo_url: pc.photo_url,
          colorIndex: pc.colorIndex
        });
        pc.count--;
        cardIndex++;
        addedInThisRound = true;
      }
    }
    
    if (!addedInThisRound) break;
  }
  
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
  
  const round = await getActiveRound();
  
  if (!round) {
    return { ok: true, round: null, bets: [], wheelCardsHTML: '', serverTime: new Date().toISOString() };
  }
  
  const bets = await getRoundBets(round.id);
  
  // Получаем фото профилей для всех игроков ПАРАЛЛЕЛЬНО с timeout
  const betsWithPhotos = await Promise.all(
    bets.map(async (bet) => {
      const displayName = bet.users?.username 
        || bet.users?.first_name 
        || "Player";
      
      // Получаем URL фото профиля с timeout (макс 2 секунды)
      let photoUrl = null;
      try {
        photoUrl = await Promise.race([
          getTelegramPhotoUrl(bet.user_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);
      } catch (err) {
        // Timeout или ошибка - используем null (инициалы)
        console.log(`Avatar timeout for ${bet.user_id}, using initials`);
      }
      
      return {
        id: bet.id,
        user_id: bet.user_id,
        bet_amount: bet.bet_amount,
        chance_percent: bet.chance_percent,
        display_name: displayName,
        created_at: bet.created_at,
        photo_url: photoUrl
      };
    })
  );
  
  // ГЕНЕРИРУЕМ КАРТОЧКИ НА СЕРВЕРЕ
  const wheelCards = betsWithPhotos.length > 0 
    ? generateWheelCards(betsWithPhotos, round.id) 
    : [];
  
  // ГЕНЕРИРУЕМ HTML НА СЕРВЕРЕ
  const wheelCardsHTML = wheelCards.length > 0 
    ? generateWheelCardsHTML(wheelCards)
    : '';
  
  console.log('[Roulette API] Generated', wheelCards.length, 'cards and HTML for round', round.id, 'with', betsWithPhotos.length, 'players');
  
  return {
    ok: true,
    round,
    bets: betsWithPhotos,
    wheelCardsHTML,
    serverTime: new Date().toISOString()
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
  
  // Добавить записи в pvp_balance_events для истории баланса
  for (const bet of bets) {
    const isWinner = bet.user_id === winnerId;
    const eventType = isWinner ? 'win' : 'loss';
    const amount = isWinner ? winnerAmount : -parseFloat(bet.bet_amount);
    const displayName = bet.users?.username || bet.users?.first_name || "Player";
    const text = isWinner 
      ? `Победа в рулетке +${winnerAmount.toFixed(2)} TON`
      : `Проигрыш в рулетке -${parseFloat(bet.bet_amount).toFixed(2)} TON`;
    
    await supabaseInsert("pvp_balance_events", {
      tg_user_id: bet.user_id,
      room_id: null,
      game_key: 'roulette',
      event_type: eventType,
      amount: amount,
      stake_ton: parseFloat(bet.bet_amount),
      meta: {
        reason: 'roulette_finished',
        text: text,
        round_id: round.id,
        players_count: round.players_count,
        total_pot: totalPot,
        winner_user_id: winnerId,
        winner_display_name: winnerDisplayName,
        winner_amount: winnerAmount,
        my_chance: parseFloat(bet.chance_percent),
        my_bet: parseFloat(bet.bet_amount)
      }
    });
  }
  
  return {
    ok: true,
    winner: {
      user_id: winnerId,
      display_name: winnerDisplayName,
      amount: winnerAmount,
      chance: parseFloat(winnerBet.chance_percent),
      bet: parseFloat(winnerBet.bet_amount)
    },
    round_id: round.id, // ВАЖНО: для синхронизации анимации
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
  
  // Получить или создать активный раунд С БЛОКИРОВКОЙ
  let round = await getActiveRound();
  if (!round) {
    round = await createNewRound();
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
  
  // Если это второй игрок - запустить таймер
  if (isSecondPlayer) {
    updateData.status = "active";
    updateData.started_at = new Date().toISOString();
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
  
  // Добавляем фото профилей для победителей
  const winnersWithPhotos = await Promise.all(
    (data || []).map(async (winner) => {
      const photoUrl = await getTelegramPhotoUrl(winner.winner_user_id);
      return {
        ...winner,
        photo_url: photoUrl
      };
    })
  );
  
  return {
    ok: true,
    winners: winnersWithPhotos
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
