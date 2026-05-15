/**
 * F1 Duel — бот-навигация (одно сообщение в чате).
 * Кнопка меню у поля ввода: type "commands" → 4 команды (не Web App).
 * GET /api/bot?action=setup
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = (process.env.WEBAPP_URL || process.env.TELEGRAM_MINIAPP_URL || "https://f1-three-iota.vercel.app").replace(/\/+$/, "");
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const lastNavMessageByChat = new Map();

/** Совпадают с кнопками в чате и пунктами меню у поля ввода */
const BOT_COMMANDS = [
  { command: "start", description: "Главная" },
  { command: "help", description: "Как играть" },
  { command: "games", description: "Режимы" },
  { command: "about", description: "О платформе" },
];

const GAMES = [
  { icon: "🎡", name: "Rolls", desc: "рулетка: общий банк, шанс от размера ставки" },
  { icon: "🎲", name: "Случайная дуэль", desc: "быстрый матч в одной из PvP-игр" },
  { icon: "🐸", name: "Охота на жабу", desc: "прятки и выстрел по кувшинкам" },
  { icon: "🏁", name: "Полоса препятствий", desc: "гонка 1 на 1" },
  { icon: "⚽", name: "Супер-пенальти", desc: "серия пенальти" },
  { icon: "🏀", name: "Баскетбол", desc: "броски на очки" },
];

const CB = {
  HOME: "nav:home",
  HELP: "nav:help",
  GAMES: "nav:games",
  ABOUT: "nav:about",
};

const SCREEN = {
  home: "home",
  help: "help",
  games: "games",
  about: "about",
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildNavKeyboard(active) {
  const mark = (key, label) => (active === key ? `▸ ${label}` : label);
  return {
    inline_keyboard: [
      [
        { text: mark("help", "Как играть"), callback_data: CB.HELP },
        { text: mark("games", "Режимы"), callback_data: CB.GAMES },
      ],
      [
        { text: mark("about", "О платформе"), callback_data: CB.ABOUT },
        { text: mark("home", "Главная"), callback_data: CB.HOME },
      ],
    ],
  };
}

function buildHomeText(firstName) {
  const name = firstName ? `${escapeHtml(firstName)}, ` : "";
  return (
    `<b>✦ F1 Duel</b>\n\n` +
    `${name}PvP-дуэли и рулетка <b>Rolls</b> на балансе в <b>TON</b>.\n\n` +
    `Игра — в мини-приложении (иконка у скрепки). Здесь — справка: правила, режимы, баланс и рефералка.\n\n` +
    `<i>Меню у поля ввода или кнопки ниже — те же 4 раздела.</i>`
  );
}

/** Приветствие по /start — только актуальные режимы (4 PvP + Rolls). */
function buildStartWelcomeText(firstName) {
  const name = firstName ? escapeHtml(firstName) : "";
  const hello = name ? `Привет, ${name}, добро пожаловать в <b>F1 Duel</b>!` : `Привет, добро пожаловать в <b>F1 Duel</b>!`;
  return (
    `${hello}\n\n` +
    `Это мульти-игровой Telegram WebApp с PvP-дуэлями и рулеткой <b>Rolls</b>.\n\n` +
    `<b>Доступные режимы:</b>\n` +
    `• 🎡 Rolls (рулетка)\n` +
    `• 🐸 Frog Hunt (PvP)\n` +
    `• 🏁 Obstacle Race (PvP)\n` +
    `• ⚽ Super Penalty (PvP)\n` +
    `• 🏀 Basketball (PvP)\n\n` +
    `Нажми кнопку ниже, чтобы открыть приложение.`
  );
}

function buildStartWelcomeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎮 Открыть F1 Duel", web_app: { url: APP_URL } }],
    ],
  };
}

function buildHelpText() {
  return (
    `<b>✦ Как играть</b>\n\n` +
    `<b>PvP</b>\n` +
    `1. Вкладка <b>Игры</b> → выберите режим или «Случайная игра».\n` +
    `2. Укажите ставку и дождитесь соперника.\n` +
    `3. Ставка блокируется до конца матча — победитель забирает банк.\n\n` +
    `<b>Rolls (рулетка)</b>\n` +
    `1. Вкладка <b>Рулетка</b> → «Войти в игру».\n` +
    `2. Минимальная ставка 0.1 TON; можно повышать на 0.1 TON.\n` +
    `3. После таймера — розыгрыш; шанс выигрыша = доля вашей ставки в банке.`
  );
}

function buildGamesText() {
  const lines = GAMES.map((g) => `${g.icon} <b>${escapeHtml(g.name)}</b> — ${g.desc}`);
  return `<b>✦ Режимы</b>\n\n${lines.join("\n")}`;
}

function buildAboutText() {
  return (
    `<b>✦ О платформе</b>\n\n` +
    `<b>Пополнение</b> (вкладка <b>Баланс</b> → Пополнить)\n` +
    `▸ <b>TON</b> — кошелёк Ton Connect, перевод на адрес сервиса.\n` +
    `▸ <b>USDT</b> — оплата счёта в @CryptoBot, зачисление в TON по курсу.\n\n` +
    `<b>Вывод</b> (вкладка <b>Баланс</b> → Вывести)\n` +
    `▸ <b>TON</b> — на ваш TON-кошелёк (комиссия сервиса, см. форму вывода).\n` +
    `▸ <b>USDT</b> — на @CryptoBot (конвертация + комиссия, обычно 20%).\n\n` +
    `<b>Рефералка</b> (вкладка <b>Профиль</b> → <b>Рефералы</b>)\n` +
    `▸ Делитесь своим кодом — друг вводит его при регистрации.\n` +
    `▸ Друг получает <b>0.5 TON</b> на баланс при первом входе с кодом.\n` +
    `▸ Вы получаете <b>5%</b> с каждого пополнения приглашённого.\n` +
    `▸ Накопленные реферальные средства можно вывести на баланс от <b>50 TON</b>.`
  );
}

function textForScreen(screen, firstName) {
  switch (screen) {
    case SCREEN.help:
      return { text: buildHelpText(), active: SCREEN.help };
    case SCREEN.games:
      return { text: buildGamesText(), active: SCREEN.games };
    case SCREEN.about:
      return { text: buildAboutText(), active: SCREEN.about };
    default:
      return { text: buildHomeText(firstName), active: SCREEN.home };
  }
}

function screenFromCommand(cmd) {
  if (cmd === "/help") return SCREEN.help;
  if (cmd === "/games") return SCREEN.games;
  if (cmd === "/about") return SCREEN.about;
  return SCREEN.home;
}

function screenFromCallback(data) {
  if (data === CB.HELP) return SCREEN.help;
  if (data === CB.GAMES) return SCREEN.games;
  if (data === CB.ABOUT) return SCREEN.about;
  return SCREEN.home;
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || `Telegram ${method} failed`);
    err.telegram = data;
    throw err;
  }
  return data;
}

async function deleteMessageSafe(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    /* ignore */
  }
}

async function answerCallback(callbackQueryId) {
  try {
    await tg("answerCallbackQuery", { callback_query_id: callbackQueryId });
  } catch {
    /* ignore */
  }
}

/**
 * Один экран в чате: правим то же сообщение (плавная смена в клиенте TG).
 * Команды пользователя удаляются; лишние сообщения бота — тоже.
 */
async function showNavScreen(chatId, text, opts = {}) {
  const { editMessageId, deleteUserMessageId, active = SCREEN.home } = opts;
  const keyboard = buildNavKeyboard(active);
  const chatKey = String(chatId);

  if (deleteUserMessageId) {
    await deleteMessageSafe(chatId, deleteUserMessageId);
  }

  const storedId = lastNavMessageByChat.get(chatKey);
  const targetEditId = editMessageId || storedId;

  if (targetEditId) {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: targetEditId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      lastNavMessageByChat.set(chatKey, targetEditId);
      return;
    } catch {
      await deleteMessageSafe(chatId, targetEditId);
      if (storedId === targetEditId) lastNavMessageByChat.delete(chatKey);
    }
  }

  const sent = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
  const newId = sent.result?.message_id;
  if (newId) lastNavMessageByChat.set(chatKey, newId);
}

async function navigateTo(chatId, screen, firstName, opts = {}) {
  const { text, active } = textForScreen(screen, firstName);
  await showNavScreen(chatId, text, { ...opts, active });
}

async function configureBotProfile() {
  const short = "PvP и Rolls на TON. Frog Hunt, Obstacle Race, Penalty, Basketball.";
  const full =
    "F1 Duel — PvP-дуэли и рулетка Rolls в Telegram.\n\n" +
    "Режимы: Rolls, Frog Hunt, Obstacle Race, Super Penalty, Basketball.\n\n" +
    "Меню слева от ввода: /start /help /games /about\n" +
    "Игра — мини-приложение (иконка у скрепки).";
  const results = {};
  try {
    results.setMyShortDescription = await tg("setMyShortDescription", { short_description: short });
  } catch (e) {
    results.setMyShortDescription = { ok: false, error: e.message };
  }
  try {
    results.setMyDescription = await tg("setMyDescription", { description: full });
  } catch (e) {
    results.setMyDescription = { ok: false, error: e.message };
  }
  return results;
}

/** Меню у поля ввода = список команд (не «Играть» / Web App) */
async function configureBotMenu() {
  const commands = await tg("setMyCommands", {
    commands: BOT_COMMANDS,
    scope: { type: "default" },
  });
  const menuButton = await tg("setChatMenuButton", {
    menu_button: { type: "commands" },
  });
  return { setMyCommands: commands, setChatMenuButton: menuButton };
}

async function registerWebhook() {
  const webhookUrl = `${APP_URL}/api/bot`;
  const payload = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  };
  if (SECRET_TOKEN) payload.secret_token = SECRET_TOKEN;
  return tg("setWebhook", payload);
}

async function showStartWelcome(chatId, firstName, opts = {}) {
  const { deleteUserMessageId } = opts;
  if (deleteUserMessageId) {
    await deleteMessageSafe(chatId, deleteUserMessageId);
  }
  const chatKey = String(chatId);
  const storedId = lastNavMessageByChat.get(chatKey);
  if (storedId) {
    await deleteMessageSafe(chatId, storedId);
    lastNavMessageByChat.delete(chatKey);
  }
  const sent = await tg("sendMessage", {
    chat_id: chatId,
    text: buildStartWelcomeText(firstName),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildStartWelcomeKeyboard(),
  });
  const newId = sent.result?.message_id;
  if (newId) lastNavMessageByChat.set(chatKey, newId);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const firstName = message.from?.first_name || "";
  const cmd = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase() || "";
  const userMsgId = message.message_id;

  if (!text.startsWith("/")) {
    if (text) {
      await deleteMessageSafe(chatId, userMsgId);
      await navigateTo(chatId, SCREEN.home, firstName, {});
    }
    return;
  }

  if (cmd === "/start") {
    await showStartWelcome(chatId, firstName, { deleteUserMessageId: userMsgId });
    return;
  }

  const screen = screenFromCommand(cmd);
  await navigateTo(chatId, screen, firstName, {
    deleteUserMessageId: userMsgId,
  });
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const editMessageId = cb.message?.message_id;
  const cqId = cb.id;
  const firstName = cb.from?.first_name || "";

  if (!chatId || !editMessageId) {
    await answerCallback(cqId);
    return;
  }

  await answerCallback(cqId);
  const screen = screenFromCallback(cb.data || "");
  await navigateTo(chatId, screen, firstName, { editMessageId });
}

async function runFullSetup() {
  const webhook = await registerWebhook();
  const menu = await configureBotMenu();
  const profile = await configureBotProfile();
  let webhookInfo = null;
  try {
    webhookInfo = await tg("getWebhookInfo", {});
  } catch (e) {
    webhookInfo = { ok: false, error: e.message };
  }
  return {
    ok: true,
    appUrl: APP_URL,
    webhookUrl: `${APP_URL}/api/bot`,
    menuType: "commands",
    commands: BOT_COMMANDS.map((c) => c.command),
    webhook,
    menu,
    profile,
    webhookInfo,
    botFatherNote:
      "Если у поля ввода всё ещё «Играть» с Web App: @BotFather → Bot Settings → Menu Button → Commands. " +
      "Иконка мини-приложения у скрепки настраивается отдельно в Mini Apps.",
  };
}

module.exports = async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set" });
    }

    if (req.method === "GET") {
      const action = req.query?.action || "info";

      if (action === "setWebhook" || action === "setup") {
        return res.status(200).json(await runFullSetup());
      }

      if (action === "getWebhookInfo") {
        const info = await tg("getWebhookInfo", {});
        return res.status(200).json({ ok: true, appUrl: APP_URL, info });
      }

      return res.status(200).json({
        ok: true,
        appUrl: APP_URL,
        commands: BOT_COMMANDS,
        hint: "GET ?action=setup — webhook + menu type commands (4 пункта)",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    if (SECRET_TOKEN) {
      const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (incomingSecret !== SECRET_TOKEN) {
        return res.status(401).json({ ok: false, error: "Invalid secret token" });
      }
    }

    const update = req.body || {};

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    if (update.message) {
      await handleMessage(update.message);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[bot]", e?.message || e, e?.telegram);
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
};
