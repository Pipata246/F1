/**
 * Telegram Bot — ознакомление с F1 Duel (запуск TMA через кнопки Telegram, не в чате).
 * GET  /api/bot?action=setup — webhook, команды, Menu Button «Играть»
 * POST /api/bot             — апдейты
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = (process.env.WEBAPP_URL || process.env.TELEGRAM_MINIAPP_URL || "https://f1-three-iota.vercel.app").replace(/\/+$/, "");
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const BOT_COMMANDS = [
  { command: "start", description: "О F1 Duel" },
  { command: "help", description: "Как играть" },
  { command: "games", description: "Режимы и игры" },
];

const GAMES = [
  { icon: "🎡", name: "Rolls", desc: "рулетка на TON — общий банк, шанс от ставки" },
  { icon: "🎲", name: "Случайная игра", desc: "быстрый PvP в любой из игр по ставке" },
  { icon: "🐸", name: "Охота на жабу", desc: "прятки и выстрелы, BO2 + тайбрейк" },
  { icon: "🏁", name: "Полоса препятствий", desc: "гонка на выживание 1 на 1" },
  { icon: "⚽", name: "Супер-пенальти", desc: "серия пенальти PvP" },
  { icon: "🏀", name: "Баскетбол", desc: "броски на очки против соперника" },
];

const CB = {
  HELP: "nav:help",
  GAMES: "nav:games",
  ABOUT: "nav:about",
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Единая inline-клавиатура: только навигация по информации */
function buildNavKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📖 Как играть", callback_data: CB.HELP },
        { text: "🎯 Режимы", callback_data: CB.GAMES },
      ],
      [{ text: "ℹ️ О F1 Duel", callback_data: CB.ABOUT }],
    ],
  };
}

function buildLaunchHint() {
  return (
    `\n\n🎮 <b>Запуск игры</b> — кнопка <b>«Играть»</b> слева от поля ввода ` +
    `(меню бота) или иконка мини-приложения рядом со скрепкой.`
  );
}

function buildWelcomeText(firstName) {
  const name = firstName ? `${escapeHtml(firstName)}, ` : "";
  return (
    `<b>F1 Duel</b>\n\n` +
    `Привет, ${name}здесь PvP-игры и рулетка <b>Rolls</b> на TON — всё в одном мини-приложении.\n\n` +
    `Сначала ознакомься с режимами кнопками ниже, затем открой игру через Telegram.` +
    buildLaunchHint()
  );
}

function buildAboutText() {
  return (
    `<b>F1 Duel</b>\n\n` +
    `Мини-приложение в Telegram: ставки в TON, честные PvP-матчи и рулетка Rolls.\n\n` +
    `<b>В приложении</b>\n` +
    `• вкладка <b>Игры</b> — PvP и случайный подбор\n` +
    `• вкладка <b>Рулетка</b> — Rolls\n` +
    `• <b>Баланс</b> — пополнение и вывод TON\n` +
    `• <b>Матчи</b> — история\n` +
    `• <b>Профиль</b> — настройки и статистика` +
    buildLaunchHint()
  );
}

function buildHelpText() {
  return (
    `<b>Как начать</b>\n\n` +
    `1️⃣ Открой мини-приложение кнопкой <b>«Играть»</b> у поля ввода.\n` +
    `2️⃣ Прими правила (один раз).\n` +
    `3️⃣ Пополни баланс TON во вкладке <b>Баланс</b>.\n` +
    `4️⃣ Выбери игру или вкладку <b>Рулетка</b>.\n\n` +
    `<b>Правила ставок</b>\n` +
    `• PvP: ставка блокируется до конца матча, победитель забирает банк.\n` +
    `• Rolls: общий банк, шанс пропорционален ставке; таймер и розыгрыш колеса.\n\n` +
    `Команды: /games — подробнее о режимах` +
    buildLaunchHint()
  );
}

function buildGamesText() {
  const lines = GAMES.map((g) => `• ${g.icon} <b>${escapeHtml(g.name)}</b> — ${g.desc}`);
  return (
    `<b>Режимы</b>\n\n` +
    `${lines.join("\n")}\n\n` +
    `Все режимы в одном приложении — переключайся через нижнее меню после запуска.` +
    buildLaunchHint()
  );
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

async function answerCallback(callbackQueryId) {
  try {
    await tg("answerCallbackQuery", { callback_query_id: callbackQueryId });
  } catch {
    /* ignore */
  }
}

async function sendNavMessage(chatId, text) {
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildNavKeyboard(),
  });
}

async function configureBotProfile() {
  const short = "PvP и Rolls на TON. Кнопка «Играть» у поля ввода — мини-приложение.";
  const full =
    "F1 Duel — игры в Telegram.\n\n" +
    "Rolls, PvP (жаба, гонки, пенальти, баскетбол), баланс TON.\n\n" +
    "Откройте бота → «Играть» слева от поля ввода.\n" +
    "В чате: /help и /games — подсказки перед игрой.";
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

/** Кнопка меню у поля ввода — единственная точка запуска TMA из API */
async function configureBotMenu() {
  return {
    setMyCommands: await tg("setMyCommands", {
      commands: BOT_COMMANDS,
      scope: { type: "default" },
    }),
    setChatMenuButton: await tg("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "🎮 Играть",
        web_app: { url: APP_URL },
      },
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

  if (text.startsWith("/start") || cmd === "/start") {
    await sendNavMessage(chatId, buildWelcomeText(firstName));
    return;
  }

  if (cmd === "/help") {
    await sendNavMessage(chatId, buildHelpText());
    return;
  }

  if (cmd === "/games") {
    await sendNavMessage(chatId, buildGamesText());
    return;
  }

  if (text) {
    await sendNavMessage(
      chatId,
      "Выбери раздел кнопками ниже или команды:\n/help — как играть · /games — режимы\n\n" +
        "Чтобы играть — кнопка <b>«Играть»</b> у поля ввода в Telegram."
    );
  }
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || "";
  const cqId = cb.id;

  if (!chatId) {
    await answerCallback(cqId);
    return;
  }

  await answerCallback(cqId);

  if (data === CB.HELP) {
    await sendNavMessage(chatId, buildHelpText());
    return;
  }
  if (data === CB.GAMES) {
    await sendNavMessage(chatId, buildGamesText());
    return;
  }
  if (data === CB.ABOUT) {
    await sendNavMessage(chatId, buildAboutText());
    return;
  }

  await sendNavMessage(chatId, buildWelcomeText(cb.from?.first_name || ""));
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
        hint: "GET ?action=setup — webhook, команды, Menu Button «Играть»",
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
