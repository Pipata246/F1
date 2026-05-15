/**
 * Telegram Bot — премиальная навигация F1 Duel (один актуальный экран в чате).
 * GET  /api/bot?action=setup — webhook, команды, Menu Button (список команд)
 * POST /api/bot             — апдейты
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = (process.env.WEBAPP_URL || process.env.TELEGRAM_MINIAPP_URL || "https://f1-three-iota.vercel.app").replace(/\/+$/, "");
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";

/** Последнее навигационное сообщение бота по chat_id (best-effort на serverless) */
const lastNavMessageByChat = new Map();

const BOT_COMMANDS = [
  { command: "start", description: "О F1 Duel" },
  { command: "help", description: "Как играть" },
  { command: "games", description: "Режимы и игры" },
];

const GAMES = [
  { icon: "🎡", name: "Rolls", desc: "рулетка с общим банком и честным розыгрышем" },
  { icon: "🎲", name: "Случайная дуэль", desc: "мгновенный PvP в одной из игр" },
  { icon: "🐸", name: "Охота на жабу", desc: "тактика, блеф и точный выстрел" },
  { icon: "🏁", name: "Полоса препятствий", desc: "скорость и контроль в 1v1" },
  { icon: "⚽", name: "Супер-пенальти", desc: "серия пенальти на реакцию" },
  { icon: "🏀", name: "Баскетбол", desc: "точные броски против соперника" },
];

const CB = {
  HELP: "nav:help",
  GAMES: "nav:games",
  ABOUT: "nav:about",
  HOME: "nav:home",
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const DIVIDER = "────────────────";

function buildLaunchHint() {
  return (
    `\n${DIVIDER}\n` +
    `<i>Команды бота:</i> кнопка меню слева от поля ввода — <b>/start</b> · <b>/help</b> · <b>/games</b>\n` +
    `<i>Мини-приложение:</i> иконка F1 Duel у скрепки (запуск игры)`
  );
}

function buildNavKeyboard(active = "home") {
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

function buildWelcomeText(firstName) {
  const name = firstName ? `${escapeHtml(firstName)}, ` : "";
  return (
    `<b>✦ F1 Duel</b>\n\n` +
    `${name}добро пожаловать.\n\n` +
    `Платформа PvP-дуэлей и рулетки <b>Rolls</b> на TON — внутри Telegram, без лишних шагов.\n\n` +
    `Выберите раздел ниже, чтобы ознакомиться с режимами. Когда будете готовы — откройте мини-приложение.` +
    buildLaunchHint()
  );
}

function buildAboutText() {
  return (
    `<b>✦ О платформе</b>\n\n` +
    `<b>F1 Duel</b> — единое мини-приложение для ставок в TON и соревнований 1 на 1.\n\n` +
    `<b>Разделы приложения</b>\n` +
    `▸ <b>Игры</b> — PvP и быстрый случайный матч\n` +
    `▸ <b>Рулетка</b> — Rolls с общим банком\n` +
    `▸ <b>Баланс</b> — пополнение и вывод TON\n` +
    `▸ <b>Матчи</b> — история и результаты\n` +
    `▸ <b>Профиль</b> — статистика и настройки` +
    buildLaunchHint()
  );
}

function buildHelpText() {
  return (
    `<b>✦ Как начать</b>\n\n` +
    `<b>1.</b> Откройте мини-приложение — иконка F1 Duel рядом со скрепкой.\n` +
    `<b>2.</b> Примите правила при первом входе.\n` +
    `<b>3.</b> Пополните баланс TON во вкладке <b>Баланс</b>.\n` +
    `<b>4.</b> Выберите PvP-игру или вкладку <b>Рулетка</b>.\n\n` +
    `${DIVIDER}\n` +
    `<b>PvP</b> — ставка фиксируется до конца матча; победитель получает банк.\n` +
    `<b>Rolls</b> — шанс зависит от доли ставки; после таймера — розыгрыш колеса.` +
    buildLaunchHint()
  );
}

function buildGamesText() {
  const lines = GAMES.map(
    (g) => `${g.icon} <b>${escapeHtml(g.name)}</b>\n<i>${escapeHtml(g.desc)}</i>`
  );
  return (
    `<b>✦ Режимы</b>\n\n` +
    `${lines.join("\n\n")}\n\n` +
    `${DIVIDER}\n` +
    `Все режимы доступны в одном приложении — переключение через нижнее меню после запуска.` +
    buildLaunchHint()
  );
}

function buildHintText() {
  return (
    `<b>✦ F1 Duel</b>\n\n` +
    `Используйте кнопки ниже или команды:\n` +
    `<b>/help</b> — инструкция · <b>/games</b> — режимы\n\n` +
    `<i>Слева от поля ввода — меню команд бота. Игра — через иконку мини-приложения у скрепки.</i>`
  );
}

function screenTextByCallback(data, firstName) {
  if (data === CB.HELP) return { text: buildHelpText(), active: "help" };
  if (data === CB.GAMES) return { text: buildGamesText(), active: "games" };
  if (data === CB.ABOUT) return { text: buildAboutText(), active: "about" };
  return { text: buildWelcomeText(firstName), active: "home" };
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
    /* уже удалено или нельзя удалить */
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
 * Показать один «экран» навигации: редактирование или замена с удалением прошлого.
 */
async function showNavScreen(chatId, text, opts = {}) {
  const { editMessageId, deleteUserMessageId, active = "home" } = opts;
  const keyboard = buildNavKeyboard(active);

  if (deleteUserMessageId) {
    await deleteMessageSafe(chatId, deleteUserMessageId);
  }

  if (editMessageId) {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: editMessageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
      lastNavMessageByChat.set(String(chatId), editMessageId);
      return;
    } catch {
      /* слишком старое / тот же текст — отправим заново */
    }
  }

  const prevId = lastNavMessageByChat.get(String(chatId));
  if (prevId && prevId !== editMessageId) {
    await deleteMessageSafe(chatId, prevId);
  }

  const sent = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
  const newId = sent.result?.message_id;
  if (newId) lastNavMessageByChat.set(String(chatId), newId);
}

async function configureBotProfile() {
  const short =
    "PvP-дуэли и Rolls на TON. Меню команд слева от ввода · игра — мини-приложение у скрепки.";
  const full =
    "✦ F1 Duel\n\n" +
    "Мини-приложение для честных PvP-матчей и рулетки Rolls на TON.\n\n" +
    "Жаба · гонки · пенальти · баскетбол · случайный матч · Rolls\n\n" +
    "Слева от поля ввода — меню команд (/start, /help, /games).\n" +
    "Иконка мини-приложения у скрепки — запуск игры.";
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

/** Кнопка слева от поля ввода — выпадающий список команд (не Web App) */
async function configureBotMenu() {
  return {
    setMyCommands: await tg("setMyCommands", {
      commands: BOT_COMMANDS,
      scope: { type: "default" },
    }),
    setChatMenuButton: await tg("setChatMenuButton", {
      menu_button: { type: "commands" },
    }),
  };
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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const firstName = message.from?.first_name || "";
  const cmd = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase() || "";
  const userMsgId = message.message_id;

  if (text.startsWith("/start") || cmd === "/start") {
    await showNavScreen(chatId, buildWelcomeText(firstName), {
      deleteUserMessageId: userMsgId,
      active: "home",
    });
    return;
  }

  if (cmd === "/help") {
    await showNavScreen(chatId, buildHelpText(), {
      deleteUserMessageId: userMsgId,
      active: "help",
    });
    return;
  }

  if (cmd === "/games") {
    await showNavScreen(chatId, buildGamesText(), {
      deleteUserMessageId: userMsgId,
      active: "games",
    });
    return;
  }

  if (text) {
    await showNavScreen(chatId, buildHintText(), {
      deleteUserMessageId: userMsgId,
      active: "home",
    });
  }
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const editMessageId = cb.message?.message_id;
  const data = cb.data || "";
  const cqId = cb.id;
  const firstName = cb.from?.first_name || "";

  if (!chatId || !editMessageId) {
    await answerCallback(cqId);
    return;
  }

  await answerCallback(cqId);

  const { text, active } = screenTextByCallback(data, firstName);
  await showNavScreen(chatId, text, { editMessageId, active });
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
    webhook,
    menu,
    profile,
    webhookInfo,
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
        hint: "GET ?action=setup — webhook, команды, Menu Button (commands)",
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
