/**
 * Telegram Bot webhook — вход в F1 Duel Mini App (TMA).
 * GET  /api/bot?action=setWebhook  — webhook + меню + кнопка «Играть»
 * GET  /api/bot?action=setup       — то же + описание бота
 * POST /api/bot                    — апдейты Telegram
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = (process.env.WEBAPP_URL || process.env.TELEGRAM_MINIAPP_URL || "https://f1-three-iota.vercel.app").replace(/\/+$/, "");
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const SUPPORT_URL = (process.env.SUPPORT_TG_URL || process.env.SUPPORT_URL || "").trim();

const BOT_COMMANDS = [
  { command: "start", description: "Открыть F1 Duel" },
  { command: "play", description: "Запустить мини-приложение" },
  { command: "help", description: "Как играть" },
  { command: "games", description: "Список режимов" },
  { command: "support", description: "Поддержка" },
];

const GAMES = [
  "🎡 Rolls — рулетка на TON",
  "🎲 Случайная PvP-игра",
  "🐸 Охота на жабу",
  "🏁 Полоса препятствий",
  "⚽ Супер-пенальти",
  "🏀 Баскетбол",
];

const CB = {
  PLAY: "nav:play",
  HELP: "nav:help",
  GAMES: "nav:games",
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** /start refCODE или /start@BotName refCODE */
function parseStartPayload(text) {
  const t = String(text || "").trim();
  const m = t.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
  const raw = (m?.[1] || "").trim();
  if (!raw) return "";
  return raw.slice(0, 64);
}

/** URL мини-приложения; ref — из deep link /start */
function webAppUrl(startPayload) {
  if (!startPayload) return APP_URL;
  const sep = APP_URL.includes("?") ? "&" : "?";
  return `${APP_URL}${sep}ref=${encodeURIComponent(startPayload)}`;
}

function buildPlayKeyboard(startPayload) {
  const url = webAppUrl(startPayload);
  return {
    inline_keyboard: [
      [{ text: "🎮 Играть в F1 Duel", web_app: { url } }],
      [
        { text: "📖 Как играть", callback_data: CB.HELP },
        { text: "🎯 Режимы", callback_data: CB.GAMES },
      ],
    ],
  };
}

function buildWelcomeText(firstName, startPayload) {
  const name = firstName ? `${escapeHtml(firstName)}, ` : "";
  const refHint = startPayload
    ? "\n\n🔗 Реферальная ссылка учтена — код подставится при регистрации в приложении."
    : "";
  return (
    `<b>F1 Duel</b>\n\n` +
    `Привет, ${name}это мини-приложение с PvP-играми и рулеткой Rolls на TON.\n\n` +
    `Нажми <b>«Играть в F1 Duel»</b> — откроется приложение в Telegram.${refHint}`
  );
}

function buildHelpText() {
  return (
    `<b>Как играть</b>\n\n` +
    `1️⃣ Нажми <b>«Играть в F1 Duel»</b> под этим сообщением.\n` +
    `2️⃣ Примите правила при первом входе.\n` +
    `3️⃣ Пополните баланс TON во вкладке <b>Баланс</b>.\n` +
    `4️⃣ Выберите игру или вкладку <b>Рулетка</b> (Rolls).\n\n` +
    `<b>PvP</b> — ставка блокируется до конца матча, победитель забирает банк.\n` +
    `<b>Rolls</b> — общий банк, шанс пропорционален ставке; таймер и честный розыгрыш.\n\n` +
    `Команды: /play — открыть приложение · /games — режимы · /support — помощь`
  );
}

function buildGamesText() {
  return (
    `<b>Режимы в приложении</b>\n\n` +
    `${GAMES.map((g) => `• ${g}`).join("\n")}\n\n` +
    `Всё в одном мини-приложении — нижнее меню: игры, рулетка, баланс, матчи, профиль.`
  );
}

function buildSupportText() {
  if (SUPPORT_URL) {
    return (
      `<b>Поддержка</b>\n\n` +
      `Если что-то не работает — напишите нам:\n` +
      `<a href="${escapeHtml(SUPPORT_URL)}">открыть чат поддержки</a>\n\n` +
      `Перед обращением убедитесь, что открываете игру кнопкой <b>«Играть»</b>, а не во внешнем браузере.`
    );
  }
  return (
    `<b>Поддержка</b>\n\n` +
    `Опишите проблему в ответ на это сообщение (скриншот + что нажимали).\n\n` +
    `Важно: играйте только через кнопку <b>«Играть в F1 Duel»</b> внутри Telegram.`
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

async function answerCallback(callbackQueryId, text) {
  try {
    await tg("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || "",
      show_alert: false,
    });
  } catch {
    /* ignore */
  }
}

async function sendNavMessage(chatId, text, startPayload, extra = {}) {
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildPlayKeyboard(startPayload),
    ...extra,
  });
}

async function configureBotProfile() {
  const short =
    "PvP-игры и рулетка Rolls на TON. Нажми «Играть» — откроется мини-приложение.";
  const full =
    "F1 Duel — мульти-игровое мини-приложение в Telegram.\n\n" +
    "• PvP: жаба, гонки, пенальти, баскетбол\n" +
    "• Rolls — рулетка с общим банком\n" +
    "• Баланс TON, матчи, реферальная программа\n\n" +
    "Команда /play — запуск приложения.";
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

async function configureBotMenu() {
  const results = {};
  results.setMyCommands = await tg("setMyCommands", {
    commands: BOT_COMMANDS,
    scope: { type: "default" },
  });
  results.setChatMenuButton = await tg("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "🎮 Играть",
      web_app: { url: APP_URL },
    },
  });
  return results;
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

  if (text.startsWith("/start")) {
    const payload = parseStartPayload(text);
    await sendNavMessage(chatId, buildWelcomeText(firstName, payload), payload);
    return;
  }

  const cmd = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase() || "";

  if (cmd === "/play") {
    await sendNavMessage(
      chatId,
      "🚀 <b>Запуск F1 Duel</b>\n\nНажми кнопку ниже — мини-приложение откроется прямо в Telegram.",
      ""
    );
    return;
  }

  if (cmd === "/help") {
    await sendNavMessage(chatId, buildHelpText(), "");
    return;
  }

  if (cmd === "/games") {
    await sendNavMessage(chatId, buildGamesText(), "");
    return;
  }

  if (cmd === "/support") {
    const kb = buildPlayKeyboard("");
    if (SUPPORT_URL) {
      kb.inline_keyboard.push([{ text: "💬 Написать в поддержку", url: SUPPORT_URL }]);
    }
    await tg("sendMessage", {
      chat_id: chatId,
      text: buildSupportText(),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: kb,
    });
    return;
  }

  // Любой другой текст — одна точка входа
  if (text) {
    await sendNavMessage(
      chatId,
      "Я помогу открыть <b>F1 Duel</b>.\n\nИспользуй кнопку ниже или команды:\n/play · /help · /games · /support",
      ""
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

  if (data === CB.PLAY) {
    await answerCallback(cqId, "Откройте мини-приложение кнопкой выше");
    await sendNavMessage(
      chatId,
      "🎮 <b>F1 Duel</b>\n\nНажмите <b>«Играть в F1 Duel»</b> — это официальный запуск TMA в Telegram.",
      ""
    );
    return;
  }

  if (data === CB.HELP) {
    await answerCallback(cqId);
    await sendNavMessage(chatId, buildHelpText(), "");
    return;
  }

  if (data === CB.GAMES) {
    await answerCallback(cqId);
    await sendNavMessage(chatId, buildGamesText(), "");
    return;
  }

  await answerCallback(cqId);
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
        const result = await runFullSetup();
        return res.status(200).json(result);
      }

      if (action === "getWebhookInfo") {
        const info = await tg("getWebhookInfo", {});
        return res.status(200).json({ ok: true, appUrl: APP_URL, info });
      }

      return res.status(200).json({
        ok: true,
        appUrl: APP_URL,
        hint: "GET ?action=setup — webhook, команды, кнопка «Играть», описание бота",
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

    const message = update.message;
    if (message) {
      await handleMessage(message);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[bot]", e?.message || e, e?.telegram);
    return res.status(500).json({ ok: false, error: e.message || "Internal error" });
  }
};
