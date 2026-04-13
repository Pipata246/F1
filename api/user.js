const crypto = require("crypto");
const {
  tryFinalizeDepositFromBoc,
  processSubmittedIntentsForUser,
  cleanupDepositIntents,
} = require("./wallet-deposit-verify");
const { withdrawalBreakdown, withdrawalFeePercentDisplay } = require("./withdraw-fee");

/** Сравнение секретов без утечки по времени (длины должны совпадать). */
function safeSecretEqual(provided, expected) {
  const a = String(provided || "");
  const b = String(expected || "");
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** Лимит заявок на вывод на пользователя (in-memory; на serverless каждый инстанс свой). */
const withdrawalRateBuckets = new Map();

/** Не чаще одного syncMyDeposits на пользователя (секунды). */
const depositSyncLastByTg = new Map();

function touchWithdrawalRateLimit(tgId) {
  const maxEnv = Number(process.env.WITHDRAWAL_RATE_LIMIT_MAX);
  const windowEnv = Number(process.env.WITHDRAWAL_RATE_LIMIT_WINDOW_SEC);
  const max = Number.isFinite(maxEnv) && maxEnv > 0 ? Math.min(100, Math.floor(maxEnv)) : 8;
  const windowSec = Number.isFinite(windowEnv) && windowEnv > 0 ? Math.min(86400, Math.floor(windowEnv)) : 900;
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const cutoff = now - windowMs;

  let arr = withdrawalRateBuckets.get(tgId);
  if (!arr) arr = [];
  arr = arr.filter((t) => t > cutoff);
  if (arr.length >= max) {
    throw new Error("Too many withdrawal requests. Try again later.");
  }
  arr.push(now);
  withdrawalRateBuckets.set(tgId, arr);

  if (withdrawalRateBuckets.size > 5000) {
    const pruneCut = now - windowMs * 2;
    for (const [id, ts] of [...withdrawalRateBuckets.entries()]) {
      const f = ts.filter((t) => t > pruneCut);
      if (f.length) withdrawalRateBuckets.set(id, f);
      else withdrawalRateBuckets.delete(id);
    }
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRYPTO_BOT_TOKEN = String(process.env.CRYPTO_BOT_TOKEN || "").trim();
const USDT_WITHDRAW_FEE_BPS = Math.max(
  0,
  Math.min(10_000, Number(process.env.USDT_WITHDRAW_FEE_BPS) || 2000)
);

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

async function sbRpc(functionName, payload) {
  assertSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.message || data?.hint || data?.error || `RPC error: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function rpcScalar(data) {
  if (data == null) return null;
  if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0] !== null) {
    const k = Object.keys(data[0])[0];
    return k !== undefined ? data[0][k] : null;
  }
  return data;
}

function requireCryptoBot() {
  if (!CRYPTO_BOT_TOKEN) throw new Error("CRYPTO_BOT_TOKEN is not configured");
}

function usdtWithdrawFeePercentDisplay() {
  return Number((USDT_WITHDRAW_FEE_BPS / 100).toFixed(2));
}

async function callCryptoBotApi(method, payload) {
  requireCryptoBot();
  const res = await fetch(`https://pay.crypt.bot/api/${method}`, {
    method: "POST",
    headers: {
      "Crypto-Pay-API-Token": CRYPTO_BOT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    const msg = data?.error?.name || data?.error?.code || `Crypto Bot API error: ${res.status}`;
    throw new Error(String(msg));
  }
  return data.result;
}

async function resolveUsdtTonRate() {
  const fixed = Number(process.env.USDT_TON_FIXED_RATE || 0);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const source = String(process.env.USDT_TON_RATE_SOURCE || "crypto_bot").toLowerCase();
  if (source !== "crypto_bot") throw new Error("USDT rate source is not supported");
  const rates = await callCryptoBotApi("getExchangeRates", {});
  const arr = Array.isArray(rates)
    ? rates
    : Array.isArray(rates?.rates)
      ? rates.rates
      : Array.isArray(rates?.items)
        ? rates.items
        : [];
  const norm = (v) =>
    String(v || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const parsedPairs = [];
  for (const row of arr) {
    const src = norm(row?.source || row?.from || row?.left || row?.asset_from || row?.currency_from);
    const tgt = norm(row?.target || row?.to || row?.right || row?.asset_to || row?.currency_to);
    const rate = Number(row?.rate || row?.value || row?.price || row?.exchange_rate || 0);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    parsedPairs.push({ src, tgt, rate });
    const srcIsUsdt = src.startsWith("USDT");
    const tgtIsUsdt = tgt.startsWith("USDT");
    const srcIsTon = src === "TON" || src === "TONCOIN";
    const tgtIsTon = tgt === "TON" || tgt === "TONCOIN";
    if (srcIsUsdt && tgtIsTon) return rate;
    if (srcIsTon && tgtIsUsdt) return 1 / rate;
  }
  // Fallback: derive USDT->TON via USD/USDT cross rates if direct pair is absent.
  // Example: TON->USD and USDT->USD (or inverse).
  const getPairRate = (isSrc, isTgt) => {
    for (const p of parsedPairs) {
      if (isSrc(p.src) && isTgt(p.tgt)) return p.rate;
      if (isSrc(p.tgt) && isTgt(p.src)) return p.rate > 0 ? 1 / p.rate : null;
    }
    return null;
  };
  const isTon = (v) => v === "TON" || v === "TONCOIN";
  const isUsdt = (v) => v.startsWith("USDT");
  const isUsd = (v) => v === "USD";
  const tonPerUsd =
    getPairRate(isUsd, isTon) ??
    (() => {
      const usdPerTon = getPairRate(isTon, isUsd);
      return usdPerTon && usdPerTon > 0 ? 1 / usdPerTon : null;
    })();
  const usdPerUsdt =
    getPairRate(isUsdt, isUsd) ??
    (() => {
      const usdtPerUsd = getPairRate(isUsd, isUsdt);
      return usdtPerUsd && usdtPerUsd > 0 ? 1 / usdtPerUsd : null;
    })();
  if (tonPerUsd && usdPerUsdt) {
    const derived = tonPerUsd * usdPerUsdt;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  throw new Error(
    "Failed to resolve dynamic USDT->TON rate. Set USDT_TON_FIXED_RATE temporarily in env."
  );
}

function generateDepositMemoToken() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function ensureDepositMemoForUser(tgId) {
  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=deposit_memo&limit=1`
  );
  if (!rows?.length) throw new Error("User not found");
  if (rows[0]?.deposit_memo) return String(rows[0].deposit_memo);

  for (let i = 0; i < 25; i++) {
    const memo = generateDepositMemoToken();
    try {
      await sb(`users?tg_user_id=eq.${encodeURIComponent(tgId)}&deposit_memo=is.null`, {
        method: "PATCH",
        body: { deposit_memo: memo, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      const check = await sb(
        `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=deposit_memo&limit=1`
      );
      if (check?.[0]?.deposit_memo) return String(check[0].deposit_memo);
    } catch {
      /* collision or race */
    }
  }
  throw new Error("Failed to assign deposit memo");
}

function tonDepositAddress() {
  const raw = String(process.env.TON_DEPOSIT_ADDRESS || "").trim();
  return raw;
}

/** BOC base64: text comment для TonConnect sendTransaction (mainnet). */
function tonTextCommentPayloadBocBase64(text) {
  const { beginCell } = require("@ton/ton");
  const t = String(text || "");
  const cell = beginCell().storeUint(0, 32).storeStringTail(t).endCell();
  return Buffer.from(cell.toBoc({ idx: false })).toString("base64");
}

function isPlausibleTonAddress(addr) {
  const s = String(addr || "").trim();
  if (s.length < 40 || s.length > 96) return false;
  return /^(EQ|UQ|eq|uq)[A-Za-z0-9_-]+$/.test(s);
}

async function getWalletInfo(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);

  const depositAddress = tonDepositAddress();
  if (!depositAddress) throw new Error("Deposit address is not configured");

  const session = await authSession(initData);
  if (!session.exists) {
    throw new Error("Complete registration first");
  }

  const memo = await ensureDepositMemoForUser(tgId);
  const bal = session.user?.balance != null ? String(session.user.balance) : "0";
  let depositPayloadBoc = "";
  try {
    depositPayloadBoc = tonTextCommentPayloadBocBase64(memo);
  } catch (e) {
    throw new Error(`Не удалось подготовить комментарий для TON Connect: ${String(e?.message || e)}`);
  }
  if (!depositPayloadBoc) {
    throw new Error("Пустой payload комментария — пополнение только через кнопку в приложении недоступно, обратитесь к администратору");
  }
  const twaReturnUrl = String(process.env.TELEGRAM_MINIAPP_URL || "").trim();
  const minWEnv = Number(process.env.MIN_WITHDRAWAL_TON);
  const minWithdrawalTon = Number.isFinite(minWEnv) && minWEnv > 0 ? minWEnv : 0.05;
  const minNetEnv = Number(process.env.MIN_WITHDRAW_NET_TON);
  const minWithdrawNetTon = Number.isFinite(minNetEnv) && minNetEnv > 0 ? minNetEnv : 0.02;
  return {
    depositAddress,
    depositMemo: memo,
    depositPayloadBoc,
    balance: bal,
    withdrawalFeePercent: withdrawalFeePercentDisplay(),
    minWithdrawalTon,
    minWithdrawNetTon,
    ...(twaReturnUrl.startsWith("https://t.me/") ? { tonConnectTwaReturnUrl: twaReturnUrl } : {}),
  };
}

async function mergeWalletOpMeta(opId, partial) {
  const id = encodeURIComponent(opId);
  const rows = await sb(`wallet_operations?id=eq.${id}&select=meta&limit=1`);
  const prev =
    rows?.[0]?.meta && typeof rows[0].meta === "object" && !Array.isArray(rows[0].meta) ? rows[0].meta : {};
  await sb(`wallet_operations?id=eq.${id}`, {
    method: "PATCH",
    body: {
      meta: { ...prev, ...partial },
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
}

async function requestWithdrawal(initData, toAddress, amountStr) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);

  const addr = String(toAddress || "").trim();
  if (!isPlausibleTonAddress(addr)) throw new Error("Invalid TON address");

  const amount = Number(String(amountStr || "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  const minEnv = Number(process.env.MIN_WITHDRAWAL_TON);
  const minW = Number.isFinite(minEnv) && minEnv > 0 ? minEnv : 0.05;
  if (amount < minW) {
    throw new Error(`Minimum withdrawal is ${minW} TON`);
  }

  const br = withdrawalBreakdown(amount);
  if (!br) throw new Error("Invalid withdrawal amount after fee");

  const minNetEnv = Number(process.env.MIN_WITHDRAW_NET_TON);
  const minNet = Number.isFinite(minNetEnv) && minNetEnv > 0 ? minNetEnv : 0.02;
  if (br.netTon + 1e-12 < minNet) {
    throw new Error(
      `После комиссии на кошелёк придёт меньше ${minNet} TON. Укажите большую сумму списания.`
    );
  }

  const exists = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id&limit=1`
  );
  if (!exists?.length) throw new Error("Complete registration first");

  touchWithdrawalRateLimit(tgId);

  const rpcRes = await sbRpc("wallet_request_withdrawal", {
    p_tg_user_id: tgId,
    p_amount: br.grossTon,
    p_to_address: addr,
  });
  const opId = rpcScalar(rpcRes);

  if (opId) {
    try {
      await mergeWalletOpMeta(opId, {
        withdraw_payout_v: 2,
        withdraw_gross_ton: br.grossTon,
        withdraw_net_ton: br.netTon,
        withdraw_fee_ton: br.feeTon,
        withdraw_fee_bps: br.feeBps,
      });
    } catch (e) {
      console.error("mergeWalletOpMeta withdrawal:", e?.message || e);
    }
  }

  /* Сразу пробуем отправить в сеть: иначе на Hobby cron только раз в сутки — tx «висит» в pending. */
  if (opId && String(process.env.WITHDRAW_SKIP_IMMEDIATE_PROCESS || "").trim() !== "1") {
    try {
      const walletCronMod = require("./wallet-cron");
      if (typeof walletCronMod.runWithdrawalsPass === "function") {
        await walletCronMod.runWithdrawalsPass();
      }
    } catch (e) {
      console.error("immediate withdraw process:", e?.message || e);
    }
  }

  return {
    operationId: opId,
    grossTon: br.grossTon,
    netTon: br.netTon,
    feeTon: br.feeTon,
    feePercent: withdrawalFeePercentDisplay(),
  };
}

async function getUsdtWalletTerms(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const session = await authSession(initData);
  if (!session.exists) throw new Error("Complete registration first");
  const rate = await resolveUsdtTonRate();
  return {
    usdtTonRate: rate,
    usdtWithdrawFeePercent: usdtWithdrawFeePercentDisplay(),
  };
}

async function createUsdtDepositInvoice(initData, amountTonStr) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const session = await authSession(initData);
  if (!session.exists) throw new Error("Complete registration first");

  const rate = await resolveUsdtTonRate();
  const tonAmount = Number(String(amountTonStr || "").replace(",", "."));
  if (!Number.isFinite(tonAmount) || tonAmount <= 0) throw new Error("Invalid amount");
  const amountUsdt = Number((tonAmount / rate).toFixed(2));
  if (amountUsdt < 0.1) throw new Error("Минимальная сумма счёта: 0.1 USDT");
  const payload = `f1duel_usdt_dep_${tgId}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const description = `F1 Duel deposit ${amountUsdt} USDT -> ${tonAmount} TON`;
  const invoice = await callCryptoBotApi("createInvoice", {
    asset: "USDT",
    amount: Number(amountUsdt.toFixed(2)),
    description,
    payload,
    allow_comments: false,
    allow_anonymous: false,
  });
  const invoiceId = String(invoice?.invoice_id || "");
  const payUrl = String(invoice?.pay_url || "");
  if (!invoiceId || !payUrl) throw new Error("Failed to create USDT invoice");

  const inserted = await sb("usdt_operations", {
    method: "POST",
    body: {
      tg_user_id: tgId,
      direction: "deposit",
      status: "pending",
      amount_usdt: Number(amountUsdt.toFixed(8)),
      ton_rate: rate,
      ton_amount: tonAmount,
      fee_bps: 0,
      fee_ton: 0,
      net_ton: tonAmount,
      crypto_invoice_id: invoiceId,
      crypto_payload: payload,
      meta: { pay_url: payUrl },
    },
    prefer: "return=representation",
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;

  return {
    payUrl,
    invoiceId,
    usdtOperationId: row?.id || null,
    amountTon: tonAmount,
    amountUsdt: Number(amountUsdt.toFixed(2)),
    expectedTon: tonAmount,
    usdtTonRate: rate,
  };
}

async function finalizeUsdtDepositInvoice(invoiceId, extStatus) {
  const rows = await sb(
    `usdt_operations?crypto_invoice_id=eq.${encodeURIComponent(String(invoiceId))}&direction=eq.deposit&select=id,tg_user_id,status,net_ton,wallet_operation_id&limit=1`
  );
  const row = rows?.[0];
  if (!row) return { found: false, completed: false };
  if (row.status === "completed" || row.wallet_operation_id) return { found: true, completed: true };
  const status = String(extStatus || "").toLowerCase();
  if (!(status === "paid" || status === "confirmed")) {
    return { found: true, completed: false, status };
  }
  const tonAmount = Number(row.net_ton || 0);
  if (!(tonAmount > 0)) throw new Error("Invalid TON amount");
  const txHash = `usdtdep:${invoiceId}`;
  const opRes = await sbRpc("wallet_credit_deposit", {
    p_tg_user_id: String(row.tg_user_id),
    p_amount: tonAmount,
    p_tx_hash: txHash,
  });
  const opId = rpcScalar(opRes);
  await sb(`usdt_operations?id=eq.${encodeURIComponent(String(row.id))}`, {
    method: "PATCH",
    body: {
      status: "completed",
      wallet_operation_id: opId || null,
      external_tx_hash: txHash,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
  return { found: true, completed: true, operationId: opId || null };
}

async function checkUsdtDepositStatus(initData, usdtOperationIdRaw) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const usdtOperationId = String(usdtOperationIdRaw || "").trim();
  if (!usdtOperationId) throw new Error("Missing usdtOperationId");
  const rows = await sb(
    `usdt_operations?id=eq.${encodeURIComponent(usdtOperationId)}&tg_user_id=eq.${encodeURIComponent(tgId)}&direction=eq.deposit&select=id,status,crypto_invoice_id,wallet_operation_id,completed_at&limit=1`
  );
  const row = rows?.[0];
  if (!row) throw new Error("USDT operation not found");
  if (row.status === "completed" || row.wallet_operation_id) {
    return { status: "completed", paid: true };
  }
  if (row.status === "failed" || row.status === "cancelled") {
    return { status: row.status, paid: false };
  }
  const invoiceId = String(row.crypto_invoice_id || "");
  if (!invoiceId) return { status: row.status || "pending", paid: false };
  const inv = await callCryptoBotApi("getInvoices", { invoice_ids: invoiceId });
  const invRows = Array.isArray(inv?.items) ? inv.items : Array.isArray(inv) ? inv : [];
  const item = invRows.find((x) => String(x?.invoice_id || "") === invoiceId);
  const status = String(item?.status || row.status || "pending").toLowerCase();
  const fin = await finalizeUsdtDepositInvoice(invoiceId, status);
  if (fin.completed) return { status: "completed", paid: true };
  if (status === "expired" || status === "failed") {
    await sb(`usdt_operations?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: "PATCH",
      body: { status: "failed", updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    }).catch(() => {});
    return { status: "failed", paid: false };
  }
  return { status, paid: false };
}

async function cancelUsdtDeposit(initData, usdtOperationIdRaw) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const usdtOperationId = String(usdtOperationIdRaw || "").trim();
  if (!usdtOperationId) throw new Error("Missing usdtOperationId");
  const rows = await sb(
    `usdt_operations?id=eq.${encodeURIComponent(usdtOperationId)}&tg_user_id=eq.${encodeURIComponent(tgId)}&direction=eq.deposit&select=id,status,crypto_invoice_id,wallet_operation_id&limit=1`
  );
  const row = rows?.[0];
  if (!row) return { ok: true, removed: false };
  if (row.status === "completed" || row.wallet_operation_id) {
    return { ok: true, removed: false, alreadyCompleted: true };
  }
  const invoiceId = String(row.crypto_invoice_id || "");
  if (invoiceId) {
    await callCryptoBotApi("deleteInvoice", { invoice_id: Number(invoiceId) || invoiceId }).catch(() => {});
  }
  await sb(
    `usdt_operations?id=eq.${encodeURIComponent(usdtOperationId)}&tg_user_id=eq.${encodeURIComponent(tgId)}&status=neq.completed&wallet_operation_id=is.null`,
    {
      method: "DELETE",
      prefer: "return=minimal",
    }
  );
  return { ok: true, removed: true };
}

async function requestUsdtWithdrawal(initData, amountTonStr, cryptoBotUserIdRaw) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);

  const amountTon = Number(String(amountTonStr || "").replace(",", "."));
  if (!Number.isFinite(amountTon) || amountTon <= 0) throw new Error("Invalid amount");
  const minEnv = Number(process.env.MIN_WITHDRAWAL_TON);
  const minW = Number.isFinite(minEnv) && minEnv > 0 ? minEnv : 0.05;
  if (amountTon + 1e-12 < minW) throw new Error(`Minimum withdrawal is ${minW} TON`);
  const cryptoBotUserId = String(cryptoBotUserIdRaw || "").trim();
  if (!/^\d{4,20}$/.test(cryptoBotUserId)) {
    throw new Error("Укажите корректный Crypto Bot user id");
  }

  const feeTon = Number((amountTon * USDT_WITHDRAW_FEE_BPS / 10_000).toFixed(9));
  const netTon = Number((amountTon - feeTon).toFixed(9));
  if (netTon <= 0) throw new Error("Invalid withdrawal amount after fee");
  const rate = await resolveUsdtTonRate();
  const netUsdt = Number((netTon / rate).toFixed(2));
  if (netUsdt <= 0) throw new Error("USDT amount too small after conversion");

  touchWithdrawalRateLimit(tgId);
  const rpcRes = await sbRpc("wallet_request_withdrawal", {
    p_tg_user_id: tgId,
    p_amount: amountTon,
    p_to_address: `cryptobot:${cryptoBotUserId}`,
  });
  const opId = rpcScalar(rpcRes);
  if (!opId) throw new Error("Failed to create withdrawal operation");

  const spendId = `f1duel_usdt_wd_${opId}`;
  await mergeWalletOpMeta(opId, {
    usdt_withdraw: true,
    usdt_rate: rate,
    usdt_net: netUsdt,
    withdraw_fee_bps: USDT_WITHDRAW_FEE_BPS,
    withdraw_fee_ton: feeTon,
    withdraw_net_ton: netTon,
  });
  const usdtInsert = await sb("usdt_operations", {
    method: "POST",
    body: {
      tg_user_id: tgId,
      direction: "withdrawal",
      status: "processing",
      amount_usdt: netUsdt,
      ton_rate: rate,
      ton_amount: amountTon,
      fee_bps: USDT_WITHDRAW_FEE_BPS,
      fee_ton: feeTon,
      net_ton: netTon,
      wallet_operation_id: opId,
      to_details: cryptoBotUserId,
      crypto_payload: spendId,
    },
    prefer: "return=representation",
  });
  const usdtRow = Array.isArray(usdtInsert) ? usdtInsert[0] : usdtInsert;

  try {
    const transfer = await callCryptoBotApi("transfer", {
      user_id: Number(cryptoBotUserId),
      asset: "USDT",
      amount: netUsdt,
      spend_id: spendId,
      comment: `F1 Duel withdrawal (${amountTon} TON)`,
    });
    const transferId = String(transfer?.transfer_id || transfer?.spend_id || spendId);
    const txHash = `usdtwd:${transferId}`;
    await sbRpc("wallet_complete_withdrawal", { p_op_id: opId, p_tx_hash: txHash });
    await sb(`usdt_operations?id=eq.${encodeURIComponent(usdtRow?.id || "")}`, {
      method: "PATCH",
      body: {
        status: "completed",
        crypto_transfer_id: transferId,
        external_tx_hash: txHash,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
  } catch (e) {
    await sbRpc("wallet_fail_withdrawal", { p_op_id: opId }).catch(() => {});
    await sb(`usdt_operations?id=eq.${encodeURIComponent(usdtRow?.id || "")}`, {
      method: "PATCH",
      body: {
        status: "failed",
        updated_at: new Date().toISOString(),
        meta: { error: String(e?.message || e) },
      },
      prefer: "return=minimal",
    }).catch(() => {});
    throw new Error("USDT payout failed. Try again later.");
  }

  return {
    operationId: opId,
    grossTon: amountTon,
    netTon,
    feeTon,
    feePercent: usdtWithdrawFeePercentDisplay(),
    usdtAmount: netUsdt,
    usdtTonRate: rate,
  };
}

async function getWalletHistory(initData, limit) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  try {
    await cleanupDepositIntents(sb, []);
  } catch {
    /* ignore */
  }
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await sb(
    `wallet_operations?tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,kind,amount,status,ton_tx_hash,to_address,created_at,meta&order=created_at.desc&limit=${safeLimit}`
  );
  let intentsRaw = [];
  let stakeEventsRaw = [];
  let usdtRowsRaw = [];
  try {
    intentsRaw = await sb(
      `deposit_intents?tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,declared_amount_ton,status,wallet_operation_id,ton_tx_hash,created_at,expires_at,submitted_at&order=created_at.desc&limit=${safeLimit}`
    );
  } catch {
    /* таблица deposit_intents ещё не создана — только ledger */
  }
  try {
    stakeEventsRaw = await sb(
      `pvp_balance_events?tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,event_type,amount,stake_ton,game_key,room_id,meta,created_at&order=created_at.desc&limit=${safeLimit}`
    );
  } catch {
    /* таблица может отсутствовать до миграции */
  }
  try {
    usdtRowsRaw = await sb(
      `usdt_operations?tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,direction,status,amount_usdt,ton_rate,ton_amount,fee_bps,fee_ton,net_ton,created_at,completed_at,to_details,meta&order=created_at.desc&limit=${safeLimit}`
    );
  } catch {
    /* таблица может отсутствовать до миграции */
  }
  const opRows = (rows || []).map((r) => ({ ...r, is_deposit_intent: false }));
  const intentRows = (intentsRaw || [])
    .filter((r) => !(r.status === "completed" && r.wallet_operation_id))
    .map((r) => ({
      id: r.id,
      kind: "deposit",
      amount: String(r.declared_amount_ton ?? ""),
      status:
        r.status === "pending"
          ? "awaiting_payment"
          : r.status === "submitted"
            ? "awaiting_confirm"
            : r.status,
      ton_tx_hash: r.ton_tx_hash || null,
      to_address: null,
      created_at: r.created_at,
      is_deposit_intent: true,
      intent_status: r.status,
      expires_at: r.expires_at,
    }));
  const stakeRows = (stakeEventsRaw || []).map((r) => ({
    id: `pvp_${r.id}`,
    kind: r.event_type === "win" ? "pvp_win" : r.event_type === "loss" ? "pvp_loss" : "pvp_refund",
    amount: String(r.amount ?? ""),
    status: "completed",
    ton_tx_hash: null,
    to_address: null,
    created_at: r.created_at,
    is_deposit_intent: false,
    meta: {
      game_key: r.game_key || null,
      stake_ton: r.stake_ton != null ? String(r.stake_ton) : null,
      room_id: r.room_id || null,
      note:
        r.event_type === "win"
          ? `Победа в матче +${r.amount} TON`
          : r.event_type === "loss"
            ? `Поражение в матче ${r.amount} TON`
            : `Возврат ставки ${r.amount} TON`,
      ...(asObj(r.meta) || {}),
    },
  }));
  const usdtRows = (usdtRowsRaw || []).map((r) => ({
    id: `usdt_${r.id}`,
    kind: r.direction === "deposit" ? "usdt_deposit" : "usdt_withdrawal",
    amount: String(r.direction === "deposit" ? r.net_ton : -Math.abs(Number(r.ton_amount || 0))),
    status: r.status,
    ton_tx_hash: null,
    to_address: r.to_details || null,
    created_at: r.created_at,
    is_deposit_intent: false,
    meta: {
      usdt_amount: String(r.amount_usdt ?? ""),
      usdt_rate: String(r.ton_rate ?? ""),
      ton_amount: String(r.ton_amount ?? ""),
      net_ton: String(r.net_ton ?? ""),
      fee_ton: String(r.fee_ton ?? ""),
      fee_bps: r.fee_bps,
      ...(asObj(r.meta) || {}),
    },
  }));
  const combined = [...intentRows, ...opRows, ...stakeRows, ...usdtRows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  return combined.slice(0, safeLimit);
}

async function createDepositIntent(initData, amountStr) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const session = await authSession(initData);
  if (!session.exists) throw new Error("Complete registration first");

  try {
    await cleanupDepositIntents(sb, []);
  } catch {
    /* ignore */
  }

  const amount = Number(String(amountStr || "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");
  const minAuto = Number(process.env.MIN_AUTO_DEPOSIT_TON);
  const minDeclared = Number.isFinite(minAuto) && minAuto > 0 ? minAuto : 0.001;
  if (amount < minDeclared) {
    throw new Error(`Minimum deposit is ${minDeclared} TON`);
  }

  const nowIso = new Date().toISOString();
  const pendingRows = await sb(
    `deposit_intents?tg_user_id=eq.${encodeURIComponent(tgId)}&status=eq.pending&wallet_operation_id=is.null&expires_at=gt.${encodeURIComponent(nowIso)}&select=id,declared_amount_ton,expires_at&order=created_at.desc`
  );
  const amountTol = Math.max(amount * 1e-9, 1e-12);
  for (const row of pendingRows || []) {
    const d = Number(row.declared_amount_ton);
    if (Number.isFinite(d) && Math.abs(d - amount) <= amountTol) {
      return { intentId: row.id, expiresAt: row.expires_at, reusedPendingIntent: true };
    }
  }

  const open = await sb(
    `deposit_intents?tg_user_id=eq.${encodeURIComponent(tgId)}&status=in.(pending,submitted)&wallet_operation_id=is.null&select=id`
  );
  const maxOpen = Math.min(20, Math.max(3, Number(process.env.DEPOSIT_INTENT_MAX_OPEN) || 8));
  if ((open || []).length >= maxOpen) {
    throw new Error("Too many open top-ups. Wait until they expire or complete.");
  }

  const ttlMin = Math.min(180, Math.max(10, Number(process.env.DEPOSIT_INTENT_TTL_MIN) || 25));
  const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();

  const inserted = await sb("deposit_intents", {
    method: "POST",
    body: {
      tg_user_id: tgId,
      declared_amount_ton: amount,
      status: "pending",
      expires_at: expiresAt,
      meta: {},
    },
    prefer: "return=representation",
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!row?.id) throw new Error("Failed to create deposit intent");
  return { intentId: row.id, expiresAt: row.expires_at };
}

async function cancelDepositIntent(initData, intentId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const id = String(intentId || "").trim();
  if (!id) throw new Error("Missing intentId");

  const found = await sb(
    `deposit_intents?id=eq.${encodeURIComponent(id)}&tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,status,wallet_operation_id&limit=1`
  );
  if (!found?.length) return { ok: true };
  const cur = found[0];
  if (cur.wallet_operation_id) return { ok: true };
  if (cur.status !== "pending") return { ok: true };

  await sb(`deposit_intents?id=eq.${encodeURIComponent(id)}&tg_user_id=eq.${encodeURIComponent(tgId)}`, {
    method: "PATCH",
    body: {
      status: "expired",
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
  return { ok: true };
}

async function submitDepositIntent(initData, intentId, boc) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const id = String(intentId || "").trim();
  if (!id) throw new Error("Missing intentId");

  const memoPlain = await ensureDepositMemoForUser(tgId).catch(() => "");
  if (!memoPlain) throw new Error("Не удалось получить тег пополнения (deposit_memo)");

  const depositAddress = tonDepositAddress();
  if (!depositAddress) throw new Error("Deposit address is not configured");

  const found = await sb(
    `deposit_intents?id=eq.${encodeURIComponent(id)}&tg_user_id=eq.${encodeURIComponent(tgId)}&select=id,status,expires_at,meta,declared_amount_ton,wallet_operation_id&limit=1`
  );
  if (!found?.length) throw new Error("Intent not found");
  const cur = found[0];
  if (cur.wallet_operation_id) {
    return { ok: true, credited: false, alreadyCompleted: true, scanLog: [] };
  }
  if (cur.status !== "pending" && cur.status !== "submitted") {
    throw new Error("Intent is not awaiting payment");
  }
  if (new Date(cur.expires_at).getTime() < Date.now()) {
    await sb(`deposit_intents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { status: "expired", updated_at: new Date().toISOString() },
      prefer: "return=minimal",
    });
    throw new Error("Intent expired — create a new top-up");
  }

  const bocStr = String(boc || "").trim();
  if (bocStr.length < 24) throw new Error("Кошелёк не вернул BOC транзакции — попробуйте ещё раз");

  const extMin = Math.min(
    7 * 24 * 60,
    Math.max(120, Number(process.env.DEPOSIT_INTENT_SUBMIT_TTL_MIN) || 2880)
  );
  const newExpires = new Date(Date.now() + extMin * 60_000).toISOString();
  const prevMeta = cur.meta && typeof cur.meta === "object" && !Array.isArray(cur.meta) ? cur.meta : {};
  const meta = {
    ...prevMeta,
    connect_boc: bocStr.slice(0, 120000),
    tx_boc_tail: bocStr.slice(-500),
  };

  const nowIso = new Date().toISOString();
  if (cur.status === "pending") {
    await sb(`deposit_intents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: {
        status: "submitted",
        submitted_at: nowIso,
        expires_at: newExpires,
        meta,
        updated_at: nowIso,
      },
      prefer: "return=minimal",
    });
  } else {
    await sb(`deposit_intents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { meta, expires_at: newExpires, updated_at: nowIso },
      prefer: "return=minimal",
    });
  }

  const scanLog = [];
  const submitAttempts = Math.min(10, Math.max(2, Number(process.env.DEPOSIT_SUBMIT_TX_ATTEMPTS) || 4));
  const submitDelay = Math.min(2500, Math.max(350, Number(process.env.DEPOSIT_SUBMIT_TX_DELAY_MS) || 550));

  const api = { sb, sbRpc, rpcScalar };
  const fin = await tryFinalizeDepositFromBoc(api, {
    tgId,
    intentId: id,
    bocBase64: bocStr,
    depositAddress,
    memoPlain,
    declaredTon: cur.declared_amount_ton,
    waitOpts: { maxAttempts: submitAttempts, delayMs: submitDelay, log: scanLog },
    log: scanLog,
  });

  return {
    credited: fin.credited ? 1 : 0,
    depositReason: fin.reason || null,
    scanLog: scanLog.slice(-40),
  };
}

/** @returns {boolean} false — слишком рано, пропускаем скан (без ошибки для клиента). */
function touchDepositSyncRateLimit(tgId) {
  const minSec = Math.min(90, Math.max(2, Number(process.env.DEPOSIT_SYNC_MIN_INTERVAL_SEC) || 4));
  const now = Date.now();
  const prev = depositSyncLastByTg.get(tgId) || 0;
  if (now - prev < minSec * 1000) {
    return false;
  }
  depositSyncLastByTg.set(tgId, now);
  if (depositSyncLastByTg.size > 8000) {
    const cut = now - 600000;
    for (const [k, t] of [...depositSyncLastByTg.entries()]) {
      if (t < cut) depositSyncLastByTg.delete(k);
    }
  }
  return true;
}

/** Дожим submitted-заявки по сохранённому connect_boc (TonConnect + TEP-467). */
async function syncMyDeposits(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const session = await authSession(initData);
  if (!session.exists) throw new Error("Complete registration first");
  try {
    await cleanupDepositIntents(sb, []);
  } catch {
    /* ignore */
  }
  if (!touchDepositSyncRateLimit(tgId)) {
    return { credited: 0, log: [], rateLimited: true };
  }
  const log = [];
  const api = { sb, sbRpc, rpcScalar };
  const { credited } = await processSubmittedIntentsForUser(api, tgId, { log });
  return { credited, log: log.slice(-30), rateLimited: false };
}

async function walletCreditDepositInternal(req) {
  assertWalletInternalApiKey(req);
  const b = req.body || {};
  const tgUserId = b.tgUserId != null ? String(b.tgUserId).trim() : "";
  const amount = Number(b.amount);
  const txHash = String(b.txHash || "").trim();
  if (!tgUserId) throw new Error("Missing tgUserId");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");
  if (txHash.length < 8) throw new Error("Invalid txHash");
  const rpcRes = await sbRpc("wallet_credit_deposit", {
    p_tg_user_id: tgUserId,
    p_amount: amount,
    p_tx_hash: txHash,
  });
  return { operationId: rpcScalar(rpcRes) };
}

async function walletCompleteWithdrawalInternal(req) {
  assertWalletInternalApiKey(req);
  const b = req.body || {};
  const opId = b.operationId || b.opId;
  const txHash = String(b.txHash || "").trim();
  if (!opId) throw new Error("Missing operationId");
  if (txHash.length < 8) throw new Error("Invalid txHash");
  const rpcRes = await sbRpc("wallet_complete_withdrawal", {
    p_op_id: opId,
    p_tx_hash: txHash,
  });
  const ok = rpcScalar(rpcRes);
  if (!ok) throw new Error("Operation not updated");
  return { ok: true };
}

async function walletFailWithdrawalInternal(req) {
  assertWalletInternalApiKey(req);
  const b = req.body || {};
  const opId = b.operationId || b.opId;
  if (!opId) throw new Error("Missing operationId");
  const rpcRes = await sbRpc("wallet_fail_withdrawal", { p_op_id: opId });
  const ok = rpcScalar(rpcRes);
  if (!ok) throw new Error("Operation not updated");
  return { ok: true };
}

/** Публичное имя из полей Telegram (как в профиле TG). */
function displayNameFromProfile(first_name, last_name, username) {
  const fn = String(first_name || "").trim();
  const ln = String(last_name || "").trim();
  const un = String(username || "").trim();
  const full = [fn, ln].filter(Boolean).join(" ").trim();
  if (full) return full.slice(0, 64);
  if (un) return `@${un}`.slice(0, 64);
  return "Player";
}

function displayNameFromTg(tg) {
  return displayNameFromProfile(tg?.first_name, tg?.last_name, tg?.username);
}

async function patchUserTelegramNames(tgId, tg) {
  await sb(`users?tg_user_id=eq.${encodeURIComponent(tgId)}`, {
    method: "PATCH",
    body: {
      first_name: tg.first_name || "",
      last_name: tg.last_name || "",
      username: tg.username || "",
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
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

async function upsertPresenceTgId(tgId) {
  const id = String(tgId || "").trim();
  if (!id) return;
  await sb("app_online_presence", {
    method: "POST",
    body: { tg_user_id: id, last_seen_at: new Date().toISOString() },
    onConflict: "tg_user_id",
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

function touchPresenceTgId(tgId) {
  upsertPresenceTgId(tgId).catch(() => {});
}

async function authSession(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);
  touchPresenceTgId(tgId);

  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,first_name,last_name,username,referred_by,referral_asked_at,referral_code,rules_accepted_at,balance,deposit_memo,created_at,updated_at&limit=1`
  );

  if (!rows.length) {
    return {
      exists: false,
      user: {
        tg_user_id: tgId,
        first_name: tg.first_name || "",
        last_name: tg.last_name || "",
        username: tg.username || "",
        display_name: displayNameFromTg(tg),
        balance: 0,
      },
    };
  }
  await patchUserTelegramNames(tgId, tg).catch(() => {});
  let user = rows[0];
  if (!user.deposit_memo) {
    try {
      const memo = await ensureDepositMemoForUser(tgId);
      user = { ...user, deposit_memo: memo };
    } catch {
      /* строка users есть, но мемо не выдалось — getWalletInfo попробует снова */
    }
  }
  const referralCode = await ensureReferralCode(tg, user);
  const merged = {
    ...user,
    first_name: tg.first_name || user.first_name || "",
    last_name: tg.last_name || user.last_name || "",
    username: tg.username || user.username || "",
  };
  const display_name = displayNameFromProfile(merged.first_name, merged.last_name, merged.username);
  return { exists: true, user: { ...merged, referral_code: referralCode, display_name } };
}

async function upsertUser(initData, referredBy, rulesAcceptedAtMs) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);
  const cleanRef = String(referredBy || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  touchPresenceTgId(tgId);

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
  const row = rows?.[0] || payload;
  let deposit_memo = row.deposit_memo;
  try {
    if (!deposit_memo) deposit_memo = await ensureDepositMemoForUser(tgId);
  } catch {
    /* мемо подтянется при следующем authSession / getWalletInfo */
  }
  return {
    ...row,
    deposit_memo: deposit_memo || row.deposit_memo,
    display_name: displayNameFromProfile(row.first_name, row.last_name, row.username),
  };
}

async function markReferralAsked(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tg = verified.user;
  const tgId = String(tg.id);
  touchPresenceTgId(tgId);

  const existing = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,referred_by,referral_asked_at,referral_code,rules_accepted_at&limit=1`
  );
  if (!existing.length) throw new Error("User not found");

  const row = existing[0];
  const payload = {
    tg_user_id: tgId,
    first_name: tg.first_name || "",
    last_name: tg.last_name || "",
    username: tg.username || "",
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
  const out = rows?.[0] || payload;
  return {
    ...out,
    display_name: displayNameFromProfile(out.first_name, out.last_name, out.username),
  };
}

function assertInternalApiKey(req) {
  const expected = process.env.INTERNAL_API_KEY || "";
  if (!expected) throw new Error("Internal API key is not set");
  const provided = req.headers["x-internal-api-key"];
  if (!provided || !safeSecretEqual(provided, expected)) throw new Error("Forbidden");
}

/** Кошелёк: если задан WALLET_INTERNAL_API_KEY — только он; иначе как раньше — INTERNAL_API_KEY. */
function assertWalletInternalApiKey(req) {
  const walletKey = String(process.env.WALLET_INTERNAL_API_KEY || "").trim();
  if (walletKey) {
    const provided = req.headers["x-internal-api-key"];
    if (!provided || !safeSecretEqual(provided, walletKey)) throw new Error("Forbidden");
    return;
  }
  assertInternalApiKey(req);
}

function normalizeGameKey(value) {
  const key = String(value || "").trim();
  const allowed = new Set(["frog_hunt", "obstacle_race", "super_penalty", "basketball"]);
  if (!allowed.has(key)) throw new Error("Invalid game key");
  return key;
}

const PVP_ALLOWED_STAKES = Object.freeze([1, 5, 10, 25, 50, 100]);

function normalizeStakeOptions(values) {
  const arr = Array.isArray(values) ? values : [];
  const uniq = [];
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const fixed = Number(n.toFixed(9));
    if (!PVP_ALLOWED_STAKES.includes(fixed)) continue;
    if (!uniq.includes(fixed)) uniq.push(fixed);
  }
  uniq.sort((a, b) => a - b);
  if (!uniq.length) throw new Error("Choose at least one stake amount");
  return uniq;
}

function stakeOptionsFromRoom(room) {
  const raw = Array.isArray(room?.stake_options_ton) ? room.stake_options_ton : [];
  try {
    const normalized = normalizeStakeOptions(raw);
    return normalized.length ? normalized : [...PVP_ALLOWED_STAKES];
  } catch {
    return [...PVP_ALLOWED_STAKES];
  }
}

function pickSharedStake(a, b) {
  const left = normalizeStakeOptions(a);
  const right = normalizeStakeOptions(b);
  const inter = left.filter((x) => right.includes(x));
  return inter.length ? inter[0] : null;
}

async function assertUserCanQueueStake(tgId, stakeOptions) {
  const maxStake = Math.max(...normalizeStakeOptions(stakeOptions));
  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=balance&limit=1`
  );
  const bal = Number(rows?.[0]?.balance || 0);
  if (!Number.isFinite(bal) || bal < maxStake) {
    throw new Error(`Insufficient balance for selected stakes (need at least ${maxStake} TON)`);
  }
}

async function pvpTryJoinWaitingWithStake(room, tgId, safeName, state, stakeTon) {
  const rpcRes = await sbRpc("pvp_join_waiting_with_stake", {
    p_room_id: Number(room.id),
    p_player2_tg_user_id: String(tgId),
    p_player2_name: String(safeName || "").slice(0, 64),
    p_state_json: state || {},
    p_stake_ton: Number(stakeTon),
  });
  const roomId = Number(rpcScalar(rpcRes) || 0);
  if (!Number.isInteger(roomId) || roomId <= 0) return null;
  const rows = await sb(`pvp_rooms?id=eq.${roomId}&select=*`);
  return rows?.[0] || null;
}

async function pvpFinalizeStakeForRoom(roomId, winnerTgUserId, reason) {
  const rid = Number(roomId);
  if (!Number.isInteger(rid) || rid <= 0) return;
  try {
    await sbRpc("pvp_finalize_stake", {
      p_room_id: rid,
      p_winner_tg_user_id: winnerTgUserId ? String(winnerTgUserId) : null,
      p_reason: String(reason || "match_finished").slice(0, 60),
    });
  } catch (e) {
    console.error("pvp_finalize_stake:", e?.message || e);
    throw e;
  }
}

async function pvpStartBotMatchWithStake(room, botName, stakeTon, state) {
  const rpcRes = await sbRpc("pvp_start_bot_match_with_stake", {
    p_room_id: Number(room.id),
    p_bot_tg_user_id: pvpBotTgId(room.id),
    p_bot_name: String(botName || "player").slice(0, 64),
    p_state_json: state || {},
    p_stake_ton: Number(stakeTon),
  });
  const roomId = Number(rpcScalar(rpcRes) || 0);
  if (!Number.isInteger(roomId) || roomId <= 0) return null;
  const rows = await sb(`pvp_rooms?id=eq.${roomId}&select=*`);
  return rows?.[0] || null;
}

async function pvpFinalizeBotStakeForRoom(roomId, userTgId, userWon, reason) {
  const rid = Number(roomId);
  if (!Number.isInteger(rid) || rid <= 0) return;
  try {
    await sbRpc("pvp_finalize_bot_stake", {
      p_room_id: rid,
      p_user_tg_user_id: String(userTgId || ""),
      p_user_won: !!userWon,
      p_reason: String(reason || "match_finished").slice(0, 60),
    });
  } catch (e) {
    console.error("pvp_finalize_bot_stake:", e?.message || e);
    throw e;
  }
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

function pvpRandomAbility() {
  const r = Math.random() * 5;
  if (r < 2) return "xray";
  if (r < 4) return "sabotage";
  return "double";
}

function pvpRandomTraps(total, count) {
  const out = new Set();
  const max = Math.max(1, Number(total) || 1);
  const need = Math.max(1, Math.min(max, Number(count) || 1));
  while (out.size < need) {
    out.add(Math.floor(Math.random() * max));
  }
  return [...out];
}

function pvpDefaultObstacleState(player1Id, player2Id) {
  return {
    engine: "obstacle_race_v1",
    phase: "placing_traps",
    phaseAtMs: Date.now(),
    currentStep: 0,
    mainRounds: 7,
    winScore: 5,
    overtime: false,
    overtimeRound: 0,
    overtimeRounds: 3,
    trapsPerMain: 3,
    trapsPerOvertime: 1,
    traps: { p1: null, p2: null },
    overtimeTraps: { p1: null, p2: null },
    pendingMoves: { p1: null, p2: null },
    scores: { p1: 0, p2: 0 },
    abilities: { p1: pvpRandomAbility(), p2: pvpRandomAbility() },
    abilityUsed: { p1: false, p2: false },
    markers: { round: 0, match: 0, overtime: 0, xray: 0 },
    players: { p1: String(player1Id), p2: String(player2Id) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function pvpDefaultSuperPenaltyState(player1Id, player2Id) {
  return {
    engine: "super_penalty_v1",
    phase: "turn_input",
    phaseAtMs: Date.now(),
    round: 0,
    maxRounds: 10,
    suddenDeath: false,
    sdStart: 0,
    kickerOverride: null,
    choices: { p1: null, p2: null },
    scores: { p1: 0, p2: 0 },
    history: [],
    markers: { round: 0, match: 0 },
    players: { p1: String(player1Id), p2: String(player2Id) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function pvpDefaultBasketballState(player1Id, player2Id) {
  return {
    engine: "basketball_v1",
    phase: "turn_input",
    phaseAtMs: Date.now(),
    phaseNum: 2, // 2 main, 3 overtime
    round: 0,
    maxRounds: 5,
    choices: { p1: null, p2: null },
    scores: { p1: 0, p2: 0 },
    markers: { round: 0, phase: 0, match: 0 },
    players: { p1: String(player1Id), p2: String(player2Id) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function pvpDefaultStateForGame(gameKey, player1Id, player2Id) {
  if (gameKey === "obstacle_race") return pvpDefaultObstacleState(player1Id, player2Id);
  if (gameKey === "super_penalty") return pvpDefaultSuperPenaltyState(player1Id, player2Id);
  if (gameKey === "basketball") return pvpDefaultBasketballState(player1Id, player2Id);
  return pvpDefaultState(player1Id, player2Id);
}

const PVP_BOT_WAIT_MIN_MS = 57_000;
const PVP_BOT_WAIT_SPAN_MS = 10_000; // 57..67 sec
const PVP_BOT_MOVE_MIN_MS = 1000;
const PVP_BOT_MOVE_MAX_MS = 3000;
const PVP_BOT_NAME_RECENT = new Set();
const PVP_BOT_NAME_RECENT_LIMIT = 200;

function pvpBotFallbackDelayMs(roomId) {
  const base = Number(roomId || 0);
  const salt = ((base * 1103515245 + 12345) >>> 0) % (PVP_BOT_WAIT_SPAN_MS + 1);
  return PVP_BOT_WAIT_MIN_MS + salt;
}

function pvpBotTgId(roomId) {
  return `bot_fallback_${Number(roomId || 0)}`;
}

function isPvpBotFallbackRoom(room) {
  const id = String(room?.player2_tg_user_id || "");
  return id.startsWith("bot_fallback_");
}

function pvpPickBotName() {
  const roots = [
    "Alex", "Nika", "Mila", "Den", "Artem", "Vera", "Lena", "Roma", "Kir", "Ira",
    "Max", "Dima", "Sasha", "Maks", "Vlad", "Yana", "Liza", "Oleg", "Misha", "Egor",
  ];
  const tails = [
    "", "", "", "_", ".", "x", "xx", "pro", "top", "go", "one", "play", "win", "live",
  ];
  const digits = ["", "", "", "7", "9", "11", "21", "23", "77", "99"];
  for (let i = 0; i < 120; i++) {
    const root = roots[Math.floor(Math.random() * roots.length)];
    const tail = tails[Math.floor(Math.random() * tails.length)];
    const dg = digits[Math.floor(Math.random() * digits.length)];
    let s = `${root}${tail}${dg}`.replace(/\.\./g, ".").replace(/__+/g, "_");
    if (s.length < 3) s = `${s}x`;
    if (s.length > 12) s = s.slice(0, 12);
    // Keep nickname-like format: letters/numbers/._ only.
    s = s.replace(/[^A-Za-z0-9._]/g, "");
    if (s.length < 3) continue;
    if (!PVP_BOT_NAME_RECENT.has(s)) {
      PVP_BOT_NAME_RECENT.add(s);
      if (PVP_BOT_NAME_RECENT.size > PVP_BOT_NAME_RECENT_LIMIT) {
        const first = PVP_BOT_NAME_RECENT.values().next().value;
        if (first) PVP_BOT_NAME_RECENT.delete(first);
      }
      return s;
    }
  }
  return `Player${Math.floor(100 + Math.random() * 900)}`;
}

function pvpBotMoveDelayMs() {
  return PVP_BOT_MOVE_MIN_MS + Math.floor(Math.random() * (PVP_BOT_MOVE_MAX_MS - PVP_BOT_MOVE_MIN_MS + 1));
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
  let rooms = [];
  try {
    rooms = await sb(`pvp_rooms?id=in.(${uniq.join(",")})&select=id,stake_ton,stake_settled_at,status`);
  } catch {
    rooms = [];
  }
  for (const room of rooms || []) {
    if (room?.stake_ton == null || room?.stake_settled_at) continue;
    await pvpFinalizeStakeForRoom(room.id, null, "cancelled_refund");
  }
  await sb(`pvp_rooms?id=in.(${uniq.join(",")})`, {
    method: "PATCH",
    body: { status: "cancelled", updated_at: new Date().toISOString() },
    prefer: "return=minimal",
  });
  await sb(`pvp_rooms?id=in.(${uniq.join(",")})&status=eq.cancelled`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
}

async function pvpDeleteRoomAfterDone(roomId, expectedStatus = "finished") {
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) return;
  const statusFilter = encodeURIComponent(expectedStatus);
  await sb(`pvp_rooms?id=eq.${id}&status=eq.${statusFilter}`, {
    method: "DELETE",
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

async function pvpTryJoinWaiting(gameKey, tgId, safeName, wantedStakes) {
  const waiting = await sb(
    `pvp_rooms?game_key=eq.${encodeURIComponent(gameKey)}&status=eq.waiting&player2_tg_user_id=is.null&player1_tg_user_id=neq.${encodeURIComponent(tgId)}&select=*&order=created_at.asc&limit=20`
  );
  for (const room of waiting || []) {
    const sharedStake = pickSharedStake(wantedStakes, stakeOptionsFromRoom(room));
    if (!sharedStake) continue;
    const state = pvpDefaultStateForGame(gameKey, room.player1_tg_user_id, tgId);
    const joined = await pvpTryJoinWaitingWithStake(
      room,
      tgId,
      safeName,
      { ...state, phaseAtMs: Date.now() },
      sharedStake
    );
    if (joined) return joined;
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

function pvpNormalizeTrapList(values, total, expectedCount) {
  const arr = Array.isArray(values) ? values : [];
  const max = Math.max(1, Number(total) || 1);
  const need = Math.max(1, Math.min(max, Number(expectedCount) || 1));
  const uniq = [];
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= max) continue;
    if (!uniq.includes(n)) uniq.push(n);
    if (uniq.length >= need) break;
  }
  if (uniq.length !== need) throw new Error("Invalid traps");
  return uniq;
}

function pvpResolveObstacleRound(state) {
  const s = { ...state };
  const step = s.overtime ? Number(s.overtimeRound || 0) : Number(s.currentStep || 0);
  const result = { p1: null, p2: null };
  for (const side of ["p1", "p2"]) {
    const opp = side === "p1" ? "p2" : "p1";
    const mv = asObj(asObj(s.pendingMoves)[side]);
    const action = mv.action;
    const useAbility = !!mv.useAbility;
    const trapSet = s.overtime ? asObj(s.overtimeTraps)[opp] : asObj(s.traps)[opp];
    const hasTrap = Array.isArray(trapSet) ? trapSet.includes(step) : false;
    let usedAbility = null;
    if (useAbility && !asObj(s.abilityUsed)[side] && !s.overtime) {
      const ab = asObj(s.abilities)[side];
      if (!(ab === "double" && step > 4)) {
        usedAbility = ab;
        s.abilityUsed = { ...asObj(s.abilityUsed), [side]: true };
      }
    }
    const success = (action === "run" && !hasTrap) || (action === "jump" && hasTrap);
    let points = success ? 1 : 0;
    if (usedAbility === "double") points = success ? 2 : -1;
    let reason = "";
    if (action === "run" && !hasTrap) reason = "clear_run";
    else if (action === "run" && hasTrap) reason = "hit_trap";
    else if (action === "jump" && hasTrap) reason = "dodged_trap";
    else reason = "wasted_jump";
    result[side] = {
      action,
      hasTrap,
      success,
      reason,
      points,
      usedAbility,
      sabotaged: false,
      sabotageHit: false,
      sabotageBackfire: false,
    };
  }
  const baseSuccess = { p1: !!result.p1.success, p2: !!result.p2.success };
  for (const side of ["p1", "p2"]) {
    const opp = side === "p1" ? "p2" : "p1";
    if (result[side].usedAbility === "sabotage") {
      if (baseSuccess[opp]) {
        result[opp].sabotaged = true;
        result[opp].points = 0;
        result[side].sabotageHit = true;
      } else {
        result[side].sabotageBackfire = true;
      }
    }
  }

  s.scores = { ...asObj(s.scores) };
  s.scores.p1 = Number(s.scores.p1 || 0) + Number(result.p1.points || 0);
  s.scores.p2 = Number(s.scores.p2 || 0) + Number(result.p2.points || 0);
  if (s.overtime) s.overtimeRound = Number(s.overtimeRound || 0) + 1;
  else s.currentStep = Number(s.currentStep || 0) + 1;

  const winScore = Number(s.winScore || 5);
  const mainRounds = Number(s.mainRounds || 7);
  const overtimeRounds = Number(s.overtimeRounds || 3);
  let winnerSide = null;
  let startOvertime = false;
  if (s.overtime) {
    if (Number(s.scores.p1 || 0) > Number(s.scores.p2 || 0)) winnerSide = "p1";
    else if (Number(s.scores.p2 || 0) > Number(s.scores.p1 || 0)) winnerSide = "p2";
    else if (Number(s.overtimeRound || 0) >= overtimeRounds) startOvertime = true;
  } else {
    const p1 = Number(s.scores.p1 || 0);
    const p2 = Number(s.scores.p2 || 0);
    if (p1 >= winScore && p2 >= winScore) {
      if (p1 > p2) winnerSide = "p1";
      else if (p2 > p1) winnerSide = "p2";
      else startOvertime = true;
    } else if (p1 >= winScore) winnerSide = "p1";
    else if (p2 >= winScore) winnerSide = "p2";
    else if (Number(s.currentStep || 0) >= mainRounds) {
      if (p1 > p2) winnerSide = "p1";
      else if (p2 > p1) winnerSide = "p2";
      else startOvertime = true;
    }
  }

  s.phase = "round_result";
  s.phaseAtMs = Date.now();
  s.pendingMoves = { p1: null, p2: null };
  s.lastRoundResult = {
    marker: Number(asObj(s.markers).round || 0) + 1,
    step,
    result,
    scores: { p1: Number(s.scores.p1 || 0), p2: Number(s.scores.p2 || 0) },
    overtime: !!s.overtime,
    round: s.overtime ? Number(s.overtimeRound || 0) : Number(s.currentStep || 0),
    startOvertime,
    winnerSide: winnerSide || null,
    gameOver: !!winnerSide,
  };
  s.markers = { ...asObj(s.markers), round: s.lastRoundResult.marker };
  s.updatedAt = new Date().toISOString();
  return s;
}

function pvpApplyObstacleMove(room, tgId, move) {
  const s = asObj(room?.state_json);
  const side = getPvpSide(room, tgId);
  if (!side) throw new Error("Invalid room side");
  const next = { ...s };
  const m = asObj(move);

  if (next.phase === "placing_traps" || next.phase === "overtime_placing") {
    const expected = next.phase === "placing_traps" ? Number(next.trapsPerMain || 3) : Number(next.trapsPerOvertime || 1);
    const total = next.phase === "placing_traps" ? Number(next.mainRounds || 7) : Number(next.overtimeRounds || 3);
    const traps = pvpNormalizeTrapList(m.traps, total, expected);
    if (next.phase === "placing_traps") next.traps = { ...asObj(next.traps), [side]: traps };
    else next.overtimeTraps = { ...asObj(next.overtimeTraps), [side]: traps };
    const bothReady = next.phase === "placing_traps"
      ? Array.isArray(asObj(next.traps).p1) && Array.isArray(asObj(next.traps).p2)
      : Array.isArray(asObj(next.overtimeTraps).p1) && Array.isArray(asObj(next.overtimeTraps).p2);
    if (bothReady) {
      next.phase = "running";
      next.phaseAtMs = Date.now();
      next.pendingMoves = { p1: null, p2: null };
    } else {
      next.updatedAt = new Date().toISOString();
    }
    return next;
  }

  if (next.phase !== "running") return next;
  if (m.type === "xray_scan" || Number.isInteger(Number(m.point))) {
    const point = Number(m.point);
    if (!Number.isInteger(point)) throw new Error("Invalid xray point");
    if (asObj(next.abilityUsed)[side]) return next;
    if (asObj(next.abilities)[side] !== "xray") return next;
    const current = next.overtime ? Number(next.overtimeRound || 0) : Number(next.currentStep || 0);
    const upper = next.overtime ? Number(next.overtimeRounds || 3) : Number(next.mainRounds || 7);
    if (point < current || point >= upper) throw new Error("Invalid xray point");
    const opp = side === "p1" ? "p2" : "p1";
    const trapSet = next.overtime ? asObj(next.overtimeTraps)[opp] : asObj(next.traps)[opp];
    const hasTrap = Array.isArray(trapSet) ? trapSet.includes(point) : false;
    next.abilityUsed = { ...asObj(next.abilityUsed), [side]: true };
    next.lastXray = {
      marker: Number(asObj(next.markers).xray || 0) + 1,
      bySide: side,
      point,
      hasTrap,
    };
    next.markers = { ...asObj(next.markers), xray: next.lastXray.marker };
    next.updatedAt = new Date().toISOString();
    return next;
  }

  const action = String(m.action || "");
  if (action !== "run" && action !== "jump") throw new Error("Invalid move action");
  const pending = { ...asObj(next.pendingMoves) };
  if (pending[side]) return next;
  pending[side] = { action, useAbility: !!m.useAbility };
  next.pendingMoves = pending;

  if (!pending.p1 || !pending.p2) {
    next.updatedAt = new Date().toISOString();
    return next;
  }
  return pvpResolveObstacleRound(next);
}

function pvpSuperPenaltyKickerSide(s) {
  if (s.suddenDeath && Number.isInteger(Number(s.kickerOverride))) {
    return Number(s.kickerOverride) === 0 ? "p1" : "p2";
  }
  return Number(s.round || 0) % 2 === 0 ? "p1" : "p2";
}

function pvpResolveSuperPenaltyRound(state) {
  const s = { ...state };
  const kickerSide = pvpSuperPenaltyKickerSide(s);
  const keeperSide = kickerSide === "p1" ? "p2" : "p1";
  const kickerZone = Number(asObj(s.choices)[kickerSide]);
  const keeperZone = Number(asObj(s.choices)[keeperSide]);
  const isGoal = kickerZone !== keeperZone;
  s.scores = { ...asObj(s.scores) };
  if (isGoal) s.scores[kickerSide] = Number(s.scores[kickerSide] || 0) + 1;
  const history = Array.isArray(s.history) ? s.history.slice() : [];
  history.push({
    kickerIndex: kickerSide === "p1" ? 0 : 1,
    kickerZone,
    keeperZone,
    isGoal,
  });
  s.history = history.slice(-40);
  s.round = Number(s.round || 0) + 1;

  let gameOver = false;
  let winnerSide = null;
  let startSuddenDeath = false;
  const p1 = Number(s.scores.p1 || 0);
  const p2 = Number(s.scores.p2 || 0);
  const roundsPlayed = Number(s.round || 0);
  if (s.suddenDeath) {
    const sdRounds = roundsPlayed - Number(s.sdStart || 0);
    if (sdRounds >= 2 && sdRounds % 2 === 0 && p1 !== p2) {
      gameOver = true;
      winnerSide = p1 > p2 ? "p1" : "p2";
    } else {
      const pairNum = Math.floor(sdRounds / 2);
      const withinPair = sdRounds % 2;
      s.kickerOverride = (pairNum + withinPair) % 2;
    }
  } else {
    if (roundsPlayed >= Number(s.maxRounds || 10)) {
      if (p1 === p2) {
        s.suddenDeath = true;
        s.sdStart = roundsPlayed;
        s.kickerOverride = 0;
        startSuddenDeath = true;
      } else {
        gameOver = true;
        winnerSide = p1 > p2 ? "p1" : "p2";
      }
    } else if (roundsPlayed % 2 === 0) {
      let p0Left = 0;
      let p1Left = 0;
      for (let r = roundsPlayed; r < Number(s.maxRounds || 10); r++) {
        if (r % 2 === 0) p0Left += 1;
        else p1Left += 1;
      }
      if (p1 > p2 + p1Left) {
        gameOver = true;
        winnerSide = "p1";
      } else if (p2 > p1 + p0Left) {
        gameOver = true;
        winnerSide = "p2";
      }
    }
  }

  s.phase = "round_result";
  s.phaseAtMs = Date.now();
  s.choices = { p1: null, p2: null };
  s.lastRoundResult = {
    marker: Number(asObj(s.markers).round || 0) + 1,
    kickerIndex: kickerSide === "p1" ? 0 : 1,
    kickerZone,
    keeperZone,
    isGoal,
    scores: { p1: Number(s.scores.p1 || 0), p2: Number(s.scores.p2 || 0) },
    round: roundsPlayed,
    maxRounds: Number(s.maxRounds || 10),
    suddenDeath: !!s.suddenDeath,
    history: s.history,
    startSuddenDeath,
    gameOver,
    winnerSide,
  };
  s.markers = { ...asObj(s.markers), round: s.lastRoundResult.marker };
  s.updatedAt = new Date().toISOString();
  return s;
}

function pvpApplySuperPenaltyMove(room, tgId, move) {
  const s = asObj(room?.state_json);
  if (s.phase !== "turn_input") return s;
  const side = getPvpSide(room, tgId);
  if (!side) throw new Error("Invalid room side");
  const zone = Number(asObj(move).zone);
  if (![0, 1, 2, 3].includes(zone)) throw new Error("Invalid zone");
  const next = { ...s, choices: { ...asObj(s.choices) } };
  if (next.choices[side] !== null && next.choices[side] !== undefined) return next;
  next.choices[side] = zone;
  if (next.choices.p1 === null || next.choices.p2 === null) {
    next.updatedAt = new Date().toISOString();
    return next;
  }
  return pvpResolveSuperPenaltyRound(next);
}

function pvpBasketballShot(distance) {
  const d = String(distance || "mid");
  if (d === "close") return { made: Math.random() < 0.85, pointsIfMade: 1 };
  if (d === "far") return { made: Math.random() < 0.35, pointsIfMade: 3 };
  return { made: Math.random() < 0.5, pointsIfMade: 2 };
}

function pvpResolveBasketballRound(state) {
  const s = { ...state };
  const c = asObj(s.choices);
  const d1 = String(c.p1 || "mid");
  const d2 = String(c.p2 || "mid");
  const r1 = pvpBasketballShot(d1);
  const r2 = pvpBasketballShot(d2);
  const p1Pts = r1.made ? r1.pointsIfMade : 0;
  const p2Pts = r2.made ? r2.pointsIfMade : 0;
  s.scores = { ...asObj(s.scores) };
  s.scores.p1 = Number(s.scores.p1 || 0) + p1Pts;
  s.scores.p2 = Number(s.scores.p2 || 0) + p2Pts;
  s.round = Number(s.round || 0) + 1;
  s.phase = "round_result";
  s.phaseAtMs = Date.now();
  s.choices = { p1: null, p2: null };
  s.lastRoundResult = {
    marker: Number(asObj(s.markers).round || 0) + 1,
    phaseNum: Number(s.phaseNum || 2),
    round: Number(s.round || 0),
    maxRounds: Number(s.maxRounds || 5),
    shots: [
      { playerIndex: 0, distance: d1, made: !!r1.made, points: p1Pts },
      { playerIndex: 1, distance: d2, made: !!r2.made, points: p2Pts },
    ],
    scores: { p1: Number(s.scores.p1 || 0), p2: Number(s.scores.p2 || 0) },
  };
  s.markers = { ...asObj(s.markers), round: s.lastRoundResult.marker };
  s.updatedAt = new Date().toISOString();
  return s;
}

function pvpApplyBasketballMove(room, tgId, move) {
  const s = asObj(room?.state_json);
  if (s.phase !== "turn_input") return s;
  const side = getPvpSide(room, tgId);
  if (!side) throw new Error("Invalid room side");
  const distance = String(asObj(move).distance || "");
  if (distance !== "close" && distance !== "mid" && distance !== "far") {
    throw new Error("Invalid basketball distance");
  }
  const next = { ...s, choices: { ...asObj(s.choices) } };
  if (next.choices[side]) return next;
  next.choices[side] = distance;
  if (!next.choices.p1 || !next.choices.p2) {
    next.updatedAt = new Date().toISOString();
    return next;
  }
  return pvpResolveBasketballRound(next);
}

function pvpAdvanceByTime(room) {
  const s = asObj(room?.state_json);
  if (String(room?.game_key || "") === "basketball" || s.engine === "basketball_v1") {
    const now = Date.now();
    const phaseAt = Number(s?.phaseAtMs || 0);
    if (!phaseAt) return { changed: false, state: s };
    const elapsed = now - phaseAt;
    const next = { ...s };
    const presence = asObj(s.presence);
    const p1Beat = Number(presence.p1 || 0);
    const p2Beat = Number(presence.p2 || 0);
    if (isPvpBotFallbackRoom(room) && s.phase === "turn_input") {
      const botPending = asObj(s.botPending);
      const c = asObj(s.choices);
      if (!c.p2) {
        if (botPending.kind !== "basketball_move") {
          const dists = ["close", "mid", "far"];
          next.botPending = {
            kind: "basketball_move",
            dueAtMs: now + pvpBotMoveDelayMs(),
            value: dists[Math.floor(Math.random() * dists.length)],
          };
          next.updatedAt = new Date().toISOString();
          return { changed: true, state: next };
        }
        const dueAt = Number(botPending.dueAtMs || 0);
        if (dueAt > 0 && now >= dueAt) {
          next.choices = { ...c, p2: String(botPending.value || "mid") };
          next.botPending = null;
          if (next.choices.p1 && next.choices.p2) {
            const resolved = pvpResolveBasketballRound(next);
            return { changed: true, state: resolved };
          }
          next.updatedAt = new Date().toISOString();
          return { changed: true, state: next };
        }
      }
    }

    if ((s.phase === "turn_input" || s.phase === "round_result") && p1Beat > 0 && p2Beat > 0) {
      const staleMs = 15000;
      const p1Stale = now - p1Beat > staleMs;
      const p2Stale = now - p2Beat > staleMs;
      if (p1Stale !== p2Stale && elapsed >= 3000) {
        const leftSide = p1Stale ? "p1" : "p2";
        const winnerSide = leftSide === "p1" ? "p2" : "p1";
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.leftBy = String(asObj(next.players)[leftSide] || "");
        next.leftAt = new Date().toISOString();
        next.endedByLeave = true;
        next.scores = { ...asObj(next.scores) };
        if (Number(next.scores.p1 || 0) === Number(next.scores.p2 || 0)) {
          next.scores[winnerSide] = Number(next.scores[winnerSide] || 0) + 1;
        }
        next.winnerSide = winnerSide;
        next.markers = { ...asObj(next.markers), match: Number(asObj(next.markers).match || 0) + 1 };
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
    }

    if (s.phase === "round_result" && elapsed >= 2400) {
      const phaseNum = Number(s.phaseNum || 2);
      const round = Number(s.round || 0);
      const p1 = Number(asObj(s.scores).p1 || 0);
      const p2 = Number(asObj(s.scores).p2 || 0);
      if (phaseNum === 2) {
        if (round >= 5) {
          if (p1 !== p2) {
            next.phase = "match_over";
            next.phaseAtMs = now;
            next.winnerSide = p1 > p2 ? "p1" : "p2";
            next.markers = { ...asObj(s.markers), match: Number(asObj(s.markers).match || 0) + 1 };
          } else {
            next.phaseNum = 3;
            next.round = 0;
            next.maxRounds = 999;
            next.phase = "turn_input";
            next.phaseAtMs = now;
            next.choices = { p1: null, p2: null };
            next.markers = { ...asObj(s.markers), phase: Number(asObj(s.markers).phase || 0) + 1 };
          }
        } else {
          next.phase = "turn_input";
          next.phaseAtMs = now;
          next.choices = { p1: null, p2: null };
        }
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
      // overtime
      if (p1 !== p2) {
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.winnerSide = p1 > p2 ? "p1" : "p2";
        next.markers = { ...asObj(s.markers), match: Number(asObj(s.markers).match || 0) + 1 };
      } else {
        next.phase = "turn_input";
        next.phaseAtMs = now;
        next.choices = { p1: null, p2: null };
      }
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
    return { changed: false, state: s };
  }
  if (String(room?.game_key || "") === "super_penalty" || s.engine === "super_penalty_v1") {
    const now = Date.now();
    const phaseAt = Number(s?.phaseAtMs || 0);
    if (!phaseAt) return { changed: false, state: s };
    const elapsed = now - phaseAt;
    const next = { ...s };
    const presence = asObj(s.presence);
    const p1Beat = Number(presence.p1 || 0);
    const p2Beat = Number(presence.p2 || 0);
    if (isPvpBotFallbackRoom(room) && s.phase === "turn_input") {
      const botPending = asObj(s.botPending);
      const c = asObj(s.choices);
      if (c.p2 === null || c.p2 === undefined) {
        if (botPending.kind !== "super_penalty_move") {
          next.botPending = {
            kind: "super_penalty_move",
            dueAtMs: now + pvpBotMoveDelayMs(),
            value: Math.floor(Math.random() * 4),
          };
          next.updatedAt = new Date().toISOString();
          return { changed: true, state: next };
        }
        const dueAt = Number(botPending.dueAtMs || 0);
        if (dueAt > 0 && now >= dueAt) {
          next.choices = { ...c, p2: Number.isInteger(Number(botPending.value)) ? Number(botPending.value) : 0 };
          next.botPending = null;
          if (next.choices.p1 !== null && next.choices.p1 !== undefined && next.choices.p2 !== null && next.choices.p2 !== undefined) {
            const resolved = pvpResolveSuperPenaltyRound(next);
            return { changed: true, state: resolved };
          }
          next.updatedAt = new Date().toISOString();
          return { changed: true, state: next };
        }
      }
    }
    if ((s.phase === "turn_input" || s.phase === "round_result") && p1Beat > 0 && p2Beat > 0) {
      const staleMs = 15000;
      const p1Stale = now - p1Beat > staleMs;
      const p2Stale = now - p2Beat > staleMs;
      if (p1Stale !== p2Stale && elapsed >= 3000) {
        const leftSide = p1Stale ? "p1" : "p2";
        const winnerSide = leftSide === "p1" ? "p2" : "p1";
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.leftBy = String(asObj(next.players)[leftSide] || "");
        next.leftAt = new Date().toISOString();
        next.endedByLeave = true;
        next.scores = { ...asObj(next.scores) };
        if (Number(next.scores.p1 || 0) === Number(next.scores.p2 || 0)) {
          next.scores[winnerSide] = Number(next.scores[winnerSide] || 0) + 1;
        }
        next.winnerSide = winnerSide;
        next.markers = { ...asObj(next.markers), match: Number(asObj(next.markers).match || 0) + 1 };
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
    }
    if (s.phase === "turn_input" && elapsed >= 12000) {
      // No random auto-moves until both humans have polled at least once (real PvP only).
      if (p1Beat <= 0 || p2Beat <= 0) return { changed: false, state: s };
      const choices = { ...asObj(s.choices) };
      if (!Number.isInteger(Number(choices.p1))) choices.p1 = Math.floor(Math.random() * 4);
      if (!Number.isInteger(Number(choices.p2))) choices.p2 = Math.floor(Math.random() * 4);
      next.choices = choices;
      const resolved = pvpResolveSuperPenaltyRound(next);
      resolved.updatedAt = new Date().toISOString();
      return { changed: true, state: resolved };
    }
    if (s.phase === "round_result" && elapsed >= 2400) {
      const rr = asObj(s.lastRoundResult);
      if (rr.gameOver) {
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.winnerSide = rr.winnerSide || null;
        next.markers = { ...asObj(s.markers), match: Number(asObj(s.markers).match || 0) + 1 };
      } else {
        next.phase = "turn_input";
        next.phaseAtMs = now;
        next.choices = { p1: null, p2: null };
      }
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
    return { changed: false, state: s };
  }
  if (String(room?.game_key || "") === "obstacle_race" || s.engine === "obstacle_race_v1") {
    const now = Date.now();
    const phaseAt = Number(s?.phaseAtMs || 0);
    if (!phaseAt) return { changed: false, state: s };
    const elapsed = now - phaseAt;
    const next = { ...s };
    const presence = asObj(s.presence);
    const p1Beat = Number(presence.p1 || 0);
    const p2Beat = Number(presence.p2 || 0);
    if (isPvpBotFallbackRoom(room)) {
      const botPending = asObj(s.botPending);
      if (s.phase === "placing_traps") {
        const traps = asObj(s.traps);
        if (!Array.isArray(traps.p2)) {
          if (botPending.kind !== "obstacle_traps_main") {
            next.botPending = {
              kind: "obstacle_traps_main",
              dueAtMs: now + pvpBotMoveDelayMs(),
              value: pvpRandomTraps(Number(s.mainRounds || 7), Number(s.trapsPerMain || 3)),
            };
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
          if (now >= Number(botPending.dueAtMs || 0)) {
            next.traps = { ...traps, p2: Array.isArray(botPending.value) ? botPending.value : pvpRandomTraps(Number(s.mainRounds || 7), Number(s.trapsPerMain || 3)) };
            next.botPending = null;
            if (Array.isArray(asObj(next.traps).p1) && Array.isArray(asObj(next.traps).p2)) {
              next.phase = "running";
              next.phaseAtMs = Date.now();
              next.pendingMoves = { p1: null, p2: null };
            }
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
        }
      }
      if (s.phase === "overtime_placing") {
        const traps = asObj(s.overtimeTraps);
        if (!Array.isArray(traps.p2)) {
          if (botPending.kind !== "obstacle_traps_ot") {
            next.botPending = {
              kind: "obstacle_traps_ot",
              dueAtMs: now + pvpBotMoveDelayMs(),
              value: pvpRandomTraps(Number(s.overtimeRounds || 3), Number(s.trapsPerOvertime || 1)),
            };
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
          if (now >= Number(botPending.dueAtMs || 0)) {
            next.overtimeTraps = { ...traps, p2: Array.isArray(botPending.value) ? botPending.value : pvpRandomTraps(Number(s.overtimeRounds || 3), Number(s.trapsPerOvertime || 1)) };
            next.botPending = null;
            if (Array.isArray(asObj(next.overtimeTraps).p1) && Array.isArray(asObj(next.overtimeTraps).p2)) {
              next.phase = "running";
              next.phaseAtMs = Date.now();
              next.pendingMoves = { p1: null, p2: null };
            }
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
        }
      }
      if (s.phase === "running") {
        const pm = asObj(s.pendingMoves);
        if (!pm.p2) {
          if (botPending.kind !== "obstacle_move") {
            next.botPending = {
              kind: "obstacle_move",
              dueAtMs: now + pvpBotMoveDelayMs(),
              value: { action: Math.random() < 0.5 ? "run" : "jump", useAbility: false },
            };
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
          if (now >= Number(botPending.dueAtMs || 0)) {
            next.pendingMoves = { ...pm, p2: asObj(botPending.value) };
            next.botPending = null;
            if (next.pendingMoves.p1 && next.pendingMoves.p2) {
              const resolved = pvpResolveObstacleRound(next);
              return { changed: true, state: resolved };
            }
            next.updatedAt = new Date().toISOString();
            return { changed: true, state: next };
          }
        }
      }
    }
    if ((s.phase === "placing_traps" || s.phase === "overtime_placing" || s.phase === "running" || s.phase === "round_result") && p1Beat > 0 && p2Beat > 0) {
      const staleMs = 15000;
      const p1Stale = now - p1Beat > staleMs;
      const p2Stale = now - p2Beat > staleMs;
      if (p1Stale !== p2Stale && elapsed >= 3000) {
        const leftSide = p1Stale ? "p1" : "p2";
        const winnerSide = leftSide === "p1" ? "p2" : "p1";
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.leftBy = String(asObj(next.players)[leftSide] || "");
        next.leftAt = new Date().toISOString();
        next.endedByLeave = true;
        next.scores = { ...asObj(next.scores) };
        if (Number(next.scores.p1 || 0) === Number(next.scores.p2 || 0)) {
          next.scores[winnerSide] = Number(next.scores[winnerSide] || 0) + 1;
        }
        next.winnerSide = winnerSide;
        next.markers = { ...asObj(next.markers), match: Number(asObj(next.markers).match || 0) + 1 };
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
    }

    if (s.phase === "placing_traps" && elapsed >= 20000) {
      const p1 = Array.isArray(asObj(s.traps).p1) ? asObj(s.traps).p1 : pvpRandomTraps(Number(s.mainRounds || 7), Number(s.trapsPerMain || 3));
      const p2 = Array.isArray(asObj(s.traps).p2) ? asObj(s.traps).p2 : pvpRandomTraps(Number(s.mainRounds || 7), Number(s.trapsPerMain || 3));
      next.traps = { p1, p2 };
      next.phase = "running";
      next.phaseAtMs = now;
      next.pendingMoves = { p1: null, p2: null };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }

    if (s.phase === "overtime_placing" && elapsed >= 12000) {
      const p1 = Array.isArray(asObj(s.overtimeTraps).p1) ? asObj(s.overtimeTraps).p1 : pvpRandomTraps(Number(s.overtimeRounds || 3), Number(s.trapsPerOvertime || 1));
      const p2 = Array.isArray(asObj(s.overtimeTraps).p2) ? asObj(s.overtimeTraps).p2 : pvpRandomTraps(Number(s.overtimeRounds || 3), Number(s.trapsPerOvertime || 1));
      next.overtimeTraps = { p1, p2 };
      next.phase = "running";
      next.phaseAtMs = now;
      next.pendingMoves = { p1: null, p2: null };
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }

    if (s.phase === "running" && elapsed >= 12000) {
      const pending = { ...asObj(s.pendingMoves) };
      if (!pending.p1) pending.p1 = { action: "run", useAbility: false };
      if (!pending.p2) pending.p2 = { action: "run", useAbility: false };
      next.pendingMoves = pending;
      const resolved = pvpResolveObstacleRound(next);
      resolved.updatedAt = new Date().toISOString();
      return { changed: true, state: resolved };
    }

    if (s.phase === "round_result" && elapsed >= 1800) {
      const rr = asObj(s.lastRoundResult);
      if (rr.gameOver) {
        next.phase = "match_over";
        next.phaseAtMs = now;
        next.winnerSide = rr.winnerSide || null;
        next.markers = { ...asObj(s.markers), match: Number(asObj(s.markers).match || 0) + 1 };
      } else if (rr.startOvertime) {
        next.overtime = true;
        next.overtimeRound = 0;
        next.overtimeTraps = { p1: null, p2: null };
        next.abilityUsed = { p1: true, p2: true };
        next.phase = "overtime_placing";
        next.phaseAtMs = now;
        next.markers = { ...asObj(s.markers), overtime: Number(asObj(s.markers).overtime || 0) + 1 };
      } else {
        next.phase = "running";
        next.phaseAtMs = now;
        next.pendingMoves = { p1: null, p2: null };
      }
      next.updatedAt = new Date().toISOString();
      return { changed: true, state: next };
    }
    return { changed: false, state: s };
  }
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
  if (isPvpBotFallbackRoom(room) && s.phase === "turn_input") {
    const botPending = asObj(s.botPending);
    const roles = asObj(s.roles);
    const botRole = roles.p2;
    const pending = asObj(s.pending);
    const hunterShots = Number(s.hunterShots || 1);
    const totalCells = Number(s.totalCells || 8);
    const needsFrog = botRole === "frog" && (pending.frogCell === null || pending.frogCell === undefined);
    const needsHunter = botRole === "hunter" && (!Array.isArray(pending.hunterCells) || pending.hunterCells.length !== hunterShots);
    if (needsFrog || needsHunter) {
      if (botPending.kind !== "frog_move") {
        let value;
        if (needsFrog) {
          value = { frogCell: Math.floor(Math.random() * totalCells) };
        } else {
          const pick = [];
          while (pick.length < hunterShots) {
            const n = Math.floor(Math.random() * totalCells);
            if (!pick.includes(n)) pick.push(n);
          }
          value = { hunterCells: pick };
        }
        next.botPending = { kind: "frog_move", dueAtMs: now + pvpBotMoveDelayMs(), value };
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
      if (now >= Number(botPending.dueAtMs || 0)) {
        next.pending = { ...pending };
        if (needsFrog) next.pending.frogCell = Number(asObj(botPending.value).frogCell);
        if (needsHunter) next.pending.hunterCells = Array.isArray(asObj(botPending.value).hunterCells) ? asObj(botPending.value).hunterCells : [];
        next.botPending = null;
        const hasFrog = next?.pending?.frogCell !== null && next?.pending?.frogCell !== undefined && Number.isInteger(Number(next.pending.frogCell));
        const hasHunter = Array.isArray(next?.pending?.hunterCells) && next.pending.hunterCells.length === hunterShots;
        if (hasFrog && hasHunter) {
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
          return { changed: true, state: next };
        }
        next.updatedAt = new Date().toISOString();
        return { changed: true, state: next };
      }
    }
  }

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
  if (String(room?.game_key || "") === "basketball" || asObj(room?.state_json).engine === "basketball_v1") {
    return pvpApplyBasketballMove(room, tgId, move);
  }
  if (String(room?.game_key || "") === "obstacle_race" || asObj(room?.state_json).engine === "obstacle_race_v1") {
    return pvpApplyObstacleMove(room, tgId, move);
  }
  if (String(room?.game_key || "") === "super_penalty" || asObj(room?.state_json).engine === "super_penalty_v1") {
    return pvpApplySuperPenaltyMove(room, tgId, move);
  }
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

async function pvpFindMatch(initData, gameKey, playerName, stakeOptions) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const safeName = displayNameFromTg(verified.user).slice(0, 64);
  const key = normalizeGameKey(gameKey);
  const wantedStakes = normalizeStakeOptions(stakeOptions);
  if (key !== "frog_hunt" && key !== "obstacle_race" && key !== "super_penalty" && key !== "basketball") {
    throw new Error("PvP is enabled only for frog_hunt, obstacle_race, super_penalty and basketball");
  }
  await assertUserCanQueueStake(tgId, wantedStakes);
  await pvpPruneUserNonActiveRooms(tgId, key);
  await pvpEnforceSingleActiveRoom(key, tgId, safeName, 0);

  const existing = await pvpCleanupUserRooms(tgId, key);
  if (existing) return existing;

  const joinedBeforeCreate = await pvpTryJoinWaiting(key, tgId, safeName, wantedStakes);
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
      stake_options_ton: wantedStakes,
      stake_ton: null,
      stake_locked_at: null,
      stake_settled_at: null,
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
  const joinedAfterCreate = await pvpTryJoinWaiting(key, tgId, safeName, wantedStakes);
  if (joinedAfterCreate && Number(joinedAfterCreate.id) !== Number(ownRoom.id)) {
    await pvpCancelRooms([ownRoom.id]);
    await pvpEnforceSingleActiveRoom(key, tgId, safeName, joinedAfterCreate.id);
    await pvpDedupPairRooms(key, joinedAfterCreate.player1_tg_user_id, joinedAfterCreate.player2_tg_user_id, joinedAfterCreate.id);
    return joinedAfterCreate;
  }

  await pvpEnforceSingleActiveRoom(key, tgId, safeName, ownRoom.id);
  return ownRoom;
}

async function pvpMaybeFallbackToBot(room, tgId) {
  if (!room || room.status !== "waiting") return room;
  if (String(room.player1_tg_user_id || "") !== String(tgId || "")) return room;
  if (room.player2_tg_user_id) return room;
  const createdAtMs = asMs(room.created_at);
  if (!createdAtMs) return room;
  const waitMs = Date.now() - createdAtMs;
  if (waitMs < pvpBotFallbackDelayMs(room.id)) return room;
  const stake = Number(normalizeStakeOptions(stakeOptionsFromRoom(room))[0] || 0);
  if (!Number.isFinite(stake) || stake <= 0) return room;
  const botId = pvpBotTgId(room.id);
  const state = {
    ...pvpDefaultStateForGame(room.game_key, room.player1_tg_user_id, botId),
    botMatch: true,
    botSide: "p2",
    botPending: null,
    players: { p1: String(room.player1_tg_user_id), p2: botId },
    phaseAtMs: Date.now(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const started = await pvpStartBotMatchWithStake(room, pvpPickBotName(), stake, state);
    return started || room;
  } catch (e) {
    console.error("pvp bot fallback start:", e?.message || e);
    return room;
  }
}

async function pvpGetRoomState(initData, roomId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
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

  const roomForTick = await pvpMaybeFallbackToBot(room, tgId);
  const advanced = pvpAdvanceByTime(roomForTick);
  let nextRoom = roomForTick;
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
  touchPresenceTgId(tgId);
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

  const gameKey = normalizeGameKey(room?.game_key || "frog_hunt");
  const scores = (gameKey === "obstacle_race" || gameKey === "super_penalty" || gameKey === "basketball") ? asObj(s?.scores) : asObj(s?.matchScores);
  const p1 = Number(scores?.p1 || 0);
  const p2 = Number(scores?.p2 || 0);
  let winner = null;
  if ((gameKey === "obstacle_race" || gameKey === "super_penalty" || gameKey === "basketball") && (s.winnerSide === "p1" || s.winnerSide === "p2")) {
    winner = s.winnerSide === "p1" ? String(room.player1_tg_user_id) : String(room.player2_tg_user_id || "");
  } else {
    winner = p1 === p2 ? null : (p1 > p2 ? String(room.player1_tg_user_id) : String(room.player2_tg_user_id));
  }
  const nextState = { ...s, matchSavedAt: new Date().toISOString() };
  const isBotFallback = isPvpBotFallbackRoom(room);

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
  if (isBotFallback) {
    const userWon = String(winner || "") === String(room.player1_tg_user_id || "");
    await pvpFinalizeBotStakeForRoom(finalized.id, room.player1_tg_user_id, userWon, "match_finished");
  } else {
    await pvpFinalizeStakeForRoom(finalized.id, winner || null, "match_finished");
  }

  await persistMatchFromPayload({
    gameKey,
    mode: "pvp",
    winnerTgUserId: winner,
    score: { left: p1, right: p2 },
    details: {
      roomId: room.id,
      endedByLeave: !!s.endedByLeave,
      engine: s.engine || null,
      stakeTon: finalized.stake_ton != null ? Number(finalized.stake_ton) : null,
    },
    players: [
      {
        tgUserId: room.player1_tg_user_id,
        name: room.player1_name || "Игрок 1",
        score: p1,
        isWinner: winner && String(winner) === String(room.player1_tg_user_id),
        isBot: false,
      },
      {
        tgUserId: isBotFallback ? null : room.player2_tg_user_id,
        name: room.player2_name || "Игрок 2",
        score: p2,
        isWinner: winner && String(winner) === String(room.player2_tg_user_id),
        isBot: !!isBotFallback,
      },
    ],
  });
  await pvpDeleteRoomAfterDone(room.id, "finished");

  return finalized;
}

async function pvpLeaveRoom(initData, roomId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
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
    const isBotFallback = isPvpBotFallbackRoom(room);
    const s = asObj(room.state_json);
    const gameKey = normalizeGameKey(room?.game_key || "frog_hunt");
    const scoreSource = (gameKey === "obstacle_race" || gameKey === "super_penalty" || gameKey === "basketball") ? asObj(s?.scores) : asObj(s?.matchScores);
    let p1 = Number(scoreSource?.p1 || 0);
    let p2 = Number(scoreSource?.p2 || 0);
    const winner = String(room.player1_tg_user_id) === tgId
      ? String(room.player2_tg_user_id || "")
      : String(room.player1_tg_user_id || "");
    if ((gameKey === "obstacle_race" || gameKey === "super_penalty" || gameKey === "basketball") && p1 === p2) {
      if (String(winner) === String(room.player1_tg_user_id)) p1 += 1;
      else p2 += 1;
    }
    const nextState = {
      ...s,
      phase: "match_over",
      leftBy: tgId,
      leftAt: new Date().toISOString(),
      endedByLeave: true,
      winnerSide: String(winner) === String(room.player1_tg_user_id) ? "p1" : "p2",
      scores: (gameKey === "obstacle_race" || gameKey === "super_penalty" || gameKey === "basketball") ? { p1, p2 } : s.scores,
      matchScores: gameKey === "frog_hunt" ? { ...(asObj(s.matchScores)), p1, p2 } : s.matchScores,
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
    if (patched?.length) {
      if (isBotFallback) {
        // Player left a bot fallback TON match: treat as loss.
        await pvpFinalizeBotStakeForRoom(room.id, room.player1_tg_user_id, false, "leave_or_forfeit");
      } else {
        await pvpFinalizeStakeForRoom(room.id, winner || null, "leave_or_forfeit");
      }
    }
    if (patched?.length && winner) {
      await persistMatchFromPayload({
        gameKey,
        mode: "pvp",
        winnerTgUserId: winner,
        score: { left: p1, right: p2 },
        details: {
          roomId: id,
          endedByLeave: true,
          leftBy: tgId,
          engine: s.engine || null,
          stakeTon: room.stake_ton != null ? Number(room.stake_ton) : null,
        },
        players: [
          {
            tgUserId: room.player1_tg_user_id,
            name: room.player1_name || "Игрок 1",
            score: p1,
            isWinner: String(winner) === String(room.player1_tg_user_id),
            isBot: false,
          },
          {
            tgUserId: isBotFallback ? null : room.player2_tg_user_id,
            name: room.player2_name || "Игрок 2",
            score: p2,
            isWinner: String(winner) === String(room.player2_tg_user_id),
            isBot: !!isBotFallback,
          },
        ],
      });
    }
    if (patched?.length) {
      await pvpDeleteRoomAfterDone(id, "finished");
    }
    return { left: true };
  }
  return { left: false };
}

async function pvpCancelQueue(initData, roomId) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) return { cancelled: false };
  const rows = await sb(`pvp_rooms?id=eq.${id}&select=*`);
  const room = rows?.[0];
  if (!room) return { cancelled: false };
  if (!isPvpRoomParticipant(room, tgId)) throw new Error("Forbidden");
  // Queue cancel must never forfeit a live match.
  if (room.status !== "waiting") return { cancelled: false, status: room.status };
  await sb(`pvp_rooms?id=eq.${id}&status=eq.waiting`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  return { cancelled: true };
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
  const isBotMode = mode.trim().toLowerCase() === "bot";
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

  const nonBotPlayers = isBotMode ? [] : players.filter((p) => !p.isBot && p.tgUserId);
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

/** Max numeric score per player for client-recorded bot matches (anti-abuse). */
const RECORD_MATCH_BOT_MAX_SCORE = Math.max(
  10,
  Math.min(100000, Number(process.env.RECORD_MATCH_BOT_MAX_SCORE) || 500)
);

/** Max bot-match rows per user per hour via public recordMatch (rate limit). */
const RECORD_MATCH_BOT_MAX_PER_HOUR = Math.max(
  1,
  Math.min(500, Number(process.env.RECORD_MATCH_BOT_MAX_PER_HOUR) || 80)
);

async function countRecentBotMatchesForUser(tgId) {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const rows = await sb(
    `game_matches?or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&mode=eq.bot&finished_at=gte.${encodeURIComponent(since)}&select=id`
  );
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Public recordMatch: only bot games against a single local bot opponent.
 * PvP must be written by the server (finalizePvpRoomIfNeeded / pvpLeaveRoom).
 */
async function recordMatchClient(initData, payload) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  const safePayload = asObj(payload);

  const mode = String(safePayload.mode || "").trim().toLowerCase();
  if (mode !== "bot") {
    throw new Error("Client may only record bot matches; PvP is recorded by the server");
  }

  const playersRaw = Array.isArray(safePayload.players) ? safePayload.players : [];
  if (playersRaw.length !== 2) {
    throw new Error("Bot match must have exactly 2 players");
  }

  const players = playersRaw.map((p) => ({
    tgUserId: p?.tgUserId ? String(p.tgUserId) : null,
    name: String(p?.name || "Player").slice(0, 64),
    score: Number(p?.score || 0),
    isWinner: !!p?.isWinner,
    isBot: !!p?.isBot,
  }));

  for (const p of players) {
    if (!Number.isFinite(p.score) || p.score < 0 || p.score > RECORD_MATCH_BOT_MAX_SCORE) {
      throw new Error("Invalid score");
    }
  }

  const humans = players.filter((p) => !p.isBot);
  const bots = players.filter((p) => p.isBot);
  if (humans.length !== 1 || bots.length !== 1) {
    throw new Error("Bot match must include exactly one human and one bot");
  }

  const human = humans[0];
  const bot = bots[0];
  if (human.tgUserId !== tgId) {
    throw new Error("Current user must be the human player");
  }
  if (bot.tgUserId != null && String(bot.tgUserId).trim() !== "") {
    throw new Error("Bot player must not have a Telegram user id");
  }

  const winnerRaw = safePayload.winnerTgUserId;
  const winnerTgUserId = winnerRaw != null && winnerRaw !== "" ? String(winnerRaw) : null;
  if (winnerTgUserId !== null && winnerTgUserId !== tgId) {
    throw new Error("Invalid winner for bot match");
  }
  if ((winnerTgUserId === tgId) !== human.isWinner) {
    throw new Error("Winner does not match player flags");
  }
  if (bot.isWinner === human.isWinner) {
    throw new Error("Human and bot winner flags must differ");
  }

  const recent = await countRecentBotMatchesForUser(tgId);
  if (recent >= RECORD_MATCH_BOT_MAX_PER_HOUR) {
    throw new Error("Too many bot match records; try again later");
  }

  normalizeGameKey(safePayload.gameKey);

  safePayload.mode = "bot";
  safePayload.players = players;
  safePayload.winnerTgUserId = winnerTgUserId;
  delete safePayload.finishedAt;
  safePayload.serverMatchId = `cli_bot_${tgId}_${Date.now()}_${crypto.randomBytes(10).toString("hex")}`;

  touchPresenceTgId(tgId);
  return persistMatchFromPayload(safePayload);
}

async function getGameStats(initData) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const rows = await sb(
    `game_player_stats?tg_user_id=eq.${encodeURIComponent(tgId)}&select=game_key,games_played,wins,losses,points_for,points_against,last_result,last_match_at`
  );
  const byGame = {};
  for (const r of rows || []) {
    const g = Number(r.games_played || 0);
    const w = Number(r.wins || 0);
    const win_rate_pct = g > 0 ? Math.round((w / g) * 1000) / 10 : null;
    byGame[r.game_key] = { ...r, win_rate_pct };
  }
  return byGame;
}

async function getMatchHistory(initData, limit = 50) {
  const verified = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  touchPresenceTgId(tgId);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await sb(
    `game_matches?or=(player1_tg_user_id.eq.${encodeURIComponent(tgId)},player2_tg_user_id.eq.${encodeURIComponent(tgId)})&select=id,game_key,mode,player1_tg_user_id,player1_name,player2_tg_user_id,player2_name,winner_tg_user_id,score_json,details_json,finished_at&order=finished_at.desc&limit=${safeLimit}`
  );
  return rows || [];
}

/**
 * Rows older than this are removed when counting online (crash / killed WebView without presenceLeave).
 * Active clients heartbeat more often, so they are never pruned.
 */
const PRESENCE_STALE_PRUNE_SEC = Math.max(
  120,
  Math.min(7200, Number(process.env.PRESENCE_STALE_PRUNE_SEC) || 300)
);

async function presenceHeartbeat(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  await upsertPresenceTgId(String(verified.user.id));
  return true;
}

/** User left the app: drop their solo matchmaking row (waiting, no opponent yet). */
async function pvpDeleteSoloWaitingRoomsForUser(tgId) {
  const rows = await sb(
    `pvp_rooms?status=eq.waiting&player1_tg_user_id=eq.${encodeURIComponent(tgId)}&player2_tg_user_id=is.null&select=id`
  );
  const ids = (rows || []).map((r) => Number(r.id)).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return;
  await sb(`pvp_rooms?id=in.(${ids.join(",")})&status=eq.waiting`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
}

async function presenceLeave(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  const tgId = String(verified.user.id);
  await sb(`app_online_presence?tg_user_id=eq.${encodeURIComponent(tgId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
  try {
    await pvpDeleteSoloWaitingRoomsForUser(tgId);
  } catch {
    /* non-fatal: client may also send pvpCancelQueue */
  }
  return true;
}

async function pruneStalePresenceRows() {
  const cutoff = new Date(Date.now() - PRESENCE_STALE_PRUNE_SEC * 1000).toISOString();
  await sb(`app_online_presence?last_seen_at=lt.${encodeURIComponent(cutoff)}`, {
    method: "DELETE",
    prefer: "return=minimal",
  });
}

async function getOnlineCount(initData) {
  const verified = verifyTelegramInitData(initData || "", BOT_TOKEN);
  if (!verified.ok) throw new Error(verified.error);
  assertSupabaseEnv();
  try {
    await pruneStalePresenceRows();
  } catch {
    /* ignore prune errors; count still useful */
  }
  const url = `${SUPABASE_URL}/rest/v1/app_online_presence?select=tg_user_id`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  const cr = res.headers.get("content-range") || "";
  let count = 0;
  const slash = cr.lastIndexOf("/");
  if (slash >= 0) count = Number(cr.slice(slash + 1)) || 0;
  return { count, stalePruneSec: PRESENCE_STALE_PRUNE_SEC };
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
    if (action === "presenceHeartbeat") {
      await presenceHeartbeat(req.body?.initData || "");
      return res.status(200).json({ ok: true });
    }
    if (action === "presenceLeave") {
      await presenceLeave(req.body?.initData || "");
      return res.status(200).json({ ok: true });
    }
    if (action === "getOnlineCount") {
      const { count, stalePruneSec } = await getOnlineCount(req.body?.initData || "");
      return res.status(200).json({ ok: true, count, stalePruneSec });
    }
    if (action === "pvpFindMatch") {
      const room = await pvpFindMatch(
        req.body?.initData || "",
        req.body?.gameKey || "frog_hunt",
        req.body?.playerName || "",
        req.body?.stakeOptions || req.body?.stake_ton_options || []
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
    if (action === "pvpCancelQueue") {
      const result = await pvpCancelQueue(req.body?.initData || "", req.body?.roomId || 0);
      return res.status(200).json({ ok: true, result });
    }
    if (action === "getWalletInfo") {
      const data = await getWalletInfo(req.body?.initData || "");
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "getUsdtWalletTerms") {
      const data = await getUsdtWalletTerms(req.body?.initData || "");
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "createUsdtDepositInvoice") {
      const data = await createUsdtDepositInvoice(
        req.body?.initData || "",
        req.body?.amountTon ?? req.body?.amount ?? req.body?.amountUsdt ?? ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "checkUsdtDepositStatus") {
      const data = await checkUsdtDepositStatus(
        req.body?.initData || "",
        req.body?.usdtOperationId || req.body?.operationId || ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "cancelUsdtDeposit") {
      const data = await cancelUsdtDeposit(
        req.body?.initData || "",
        req.body?.usdtOperationId || req.body?.operationId || ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "requestWithdrawal") {
      const result = await requestWithdrawal(
        req.body?.initData || "",
        req.body?.toAddress || "",
        req.body?.amount ?? req.body?.amountTon
      );
      return res.status(200).json({ ok: true, ...result });
    }
    if (action === "requestUsdtWithdrawal") {
      const result = await requestUsdtWithdrawal(
        req.body?.initData || "",
        req.body?.amountTon ?? req.body?.amount ?? "",
        req.body?.cryptoBotUserId || ""
      );
      return res.status(200).json({ ok: true, ...result });
    }
    if (action === "getWalletHistory") {
      const operations = await getWalletHistory(req.body?.initData || "", req.body?.limit || 50);
      return res.status(200).json({ ok: true, operations });
    }
    if (action === "createDepositIntent") {
      const data = await createDepositIntent(
        req.body?.initData || "",
        req.body?.amount ?? req.body?.amountTon ?? ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "submitDepositIntent") {
      const data = await submitDepositIntent(
        req.body?.initData || "",
        req.body?.intentId || req.body?.id || "",
        req.body?.boc || ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "cancelDepositIntent") {
      const data = await cancelDepositIntent(
        req.body?.initData || "",
        req.body?.intentId || req.body?.id || ""
      );
      return res.status(200).json({ ok: true, ...data });
    }
    if (action === "syncMyDeposits") {
      const result = await syncMyDeposits(req.body?.initData || "");
      return res.status(200).json({ ok: true, ...result });
    }
    if (action === "walletCreditDepositInternal") {
      const result = await walletCreditDepositInternal(req);
      return res.status(200).json({ ok: true, result });
    }
    if (action === "walletCompleteWithdrawalInternal") {
      const result = await walletCompleteWithdrawalInternal(req);
      return res.status(200).json({ ok: true, result });
    }
    if (action === "walletFailWithdrawalInternal") {
      const result = await walletFailWithdrawalInternal(req);
      return res.status(200).json({ ok: true, result });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    const msg = e.message || "Internal error";
    let code = 500;
    if (msg.includes("Invalid Telegram") || msg.includes("Expired Telegram") || msg.includes("No hash") || msg.includes("No Telegram user")) {
      code = 401;
    } else if (msg === "User not found" || msg === "Room not found") {
      code = 404;
    } else if (msg.includes("Rules must be accepted")) {
      code = 400;
    } else if (msg.includes("Too many bot match records")) {
      code = 429;
    } else if (msg.includes("Too many withdrawal requests")) {
      code = 429;
    } else if (
      msg.includes("Client may only record bot matches") ||
      msg.includes("Bot match must") ||
      msg.includes("Current user must be the human") ||
      msg.includes("Bot player must not") ||
      msg.includes("Invalid winner for bot match") ||
      msg.includes("Winner does not match") ||
      msg.includes("Human and bot winner") ||
      msg === "Invalid score" ||
      msg.includes("Insufficient balance") ||
      msg.includes("Invalid amount") ||
      msg.includes("Invalid withdrawal amount after fee") ||
      msg.includes("Invalid address") ||
      msg.includes("Invalid TON address") ||
      msg.includes("CRYPTO_BOT_TOKEN is not configured") ||
      msg.includes("USDT rate source is not supported") ||
      msg.includes("Failed to resolve dynamic USDT->TON rate") ||
      msg.includes("Minimum USDT deposit") ||
      msg.includes("USDT amount too small") ||
      msg.includes("Crypto Bot user id") ||
      msg.includes("USDT payout failed") ||
      msg.includes("USDT operation not found") ||
      msg.includes("Minimum withdrawal") ||
      msg.includes("После комиссии") ||
      msg.includes("Complete registration first") ||
      msg.includes("Deposit address is not configured") ||
      msg.includes("Operation not updated") ||
      msg.includes("Missing operationId") ||
      msg.includes("Missing usdtOperationId") ||
      msg.includes("Missing intentId") ||
      msg.includes("Missing tgUserId") ||
      msg.includes("Invalid txHash") ||
      msg.includes("Choose at least one stake amount") ||
      msg.includes("Insufficient balance for selected stakes") ||
      msg.includes("No common stake") ||
      msg.includes("Invalid stake")
    ) {
      code = 400;
    } else if (msg === "Forbidden") {
      code = 403;
    } else if (msg === "Room update conflict") {
      code = 409;
    }
    return res.status(code).json({ ok: false, error: msg });
  }
};
