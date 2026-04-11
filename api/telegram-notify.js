/**
 * Опциональное уведомление пользователю в Telegram (тот же бот, что и WebApp).
 */
"use strict";

async function sendTelegramUserMessage(chatUserId, text) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(chatUserId || "").trim();
  const msg = String(text || "").trim();
  if (!token || !chatId || !msg) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

function formatTonRu(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 9, minimumFractionDigits: 0 });
}

/** После успешного нового зачисления на баланс (один раз на tx hash). */
async function notifyDepositCredited(tgUserId, amountTon) {
  if (String(process.env.DEPOSIT_TELEGRAM_NOTIFY || "1").trim() === "0") return;
  const amt = formatTonRu(amountTon);
  await sendTelegramUserMessage(
    tgUserId,
    `Вы успешно пополнили баланс на ${amt} TON. Средства уже на вашем счёте в приложении.`
  );
}

/** После успешной отправки вывода в сеть (completed + есть tx hash). */
async function notifyWithdrawalCompleted(tgUserId, opts) {
  if (String(process.env.WITHDRAWAL_TELEGRAM_NOTIFY || "1").trim() === "0") return;
  const netTon = opts && opts.netTon != null ? opts.netTon : null;
  const txHash = opts && opts.txHash != null ? String(opts.txHash).trim() : "";
  const amt = formatTonRu(netTon);
  let text = `Вывод ${amt} TON отправлен на ваш кошелёк.`;
  if (txHash.length >= 12) {
    text += ` Tx: ${txHash.slice(0, 16)}…`;
  }
  text += ` Подробности — в разделе «История» в приложении.`;
  await sendTelegramUserMessage(tgUserId, text);
}

module.exports = { notifyDepositCredited, notifyWithdrawalCompleted, sendTelegramUserMessage };
