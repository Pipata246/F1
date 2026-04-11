/**
 * Зачисление пополнений через TonConnect BOC (TEP-467 + поиск tx на кошельке пользователя).
 * Не использует список входящих на TON_DEPOSIT_ADDRESS (TonAPI/TonCenter getTransactions по депозиту).
 */
"use strict";

const crypto = require("crypto");
const {
  Cell,
  beginCell,
  loadMessage,
  storeMessage,
  TonClient,
  Address,
} = require("@ton/ton");
const { notifyDepositCredited } = require("./telegram-notify");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tonClientFromEnv() {
  const testnet = process.env.TON_TESTNET === "1";
  const endpoint =
    String(process.env.TON_JSON_RPC_URL || "").trim() ||
    (testnet ? "https://testnet.toncenter.com/api/v2/jsonRPC" : "https://toncenter.com/api/v2/jsonRPC");
  const apiKey = String(process.env.TONCENTER_API_KEY || "").trim() || undefined;
  return new TonClient({ endpoint, apiKey });
}

function getNormalizedExtMessageHash(message) {
  if (message.info.type !== "external-in") {
    throw new Error(`Ожидалось external-in, получено ${message.info.type}`);
  }
  const normalizedMessage = {
    ...message,
    init: null,
    info: {
      ...message.info,
      src: undefined,
      importFee: 0n,
    },
  };
  return beginCell()
    .store(storeMessage(normalizedMessage, { forceRef: true }))
    .endCell()
    .hash();
}

function normalizeMemoForLookup(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function userMemoMatchesDeposit(wantNorm, memoRaw) {
  if (!wantNorm || wantNorm.length < 4 || !memoRaw) return false;
  const full = normalizeMemoForLookup(memoRaw);
  if (full === wantNorm) return true;
  if (full.includes(wantNorm)) return true;
  if (wantNorm.includes(full) && full.length >= 4) return true;
  return false;
}

function deepExtractTextCommentFromCell(cell) {
  if (!cell) return null;
  function walk(c, depth) {
    if (depth > 36 || !c) return null;
    try {
      const s = c.beginParse();
      if (s.remainingBits >= 32) {
        const op = s.preloadUint(32);
        if (op === 0) {
          s.loadUint(32);
          const t = s.loadStringTail();
          if (t && String(t).trim()) return String(t).trim();
        }
      }
    } catch {
      /* refs */
    }
    const refs = c.refs || [];
    for (let i = 0; i < refs.length; i++) {
      const x = walk(refs[i], depth + 1);
      if (x) return x;
    }
    return null;
  }
  return walk(cell, 0);
}

function commentFromOutMessage(outMsg) {
  const body = outMsg?.body;
  // @ton/core Cell uses numeric type (-1), not the string "Cell"
  if (!body || !(body instanceof Cell)) return null;
  return deepExtractTextCommentFromCell(body);
}

function nanoToTonNumber(nanoBig) {
  try {
    const n = BigInt(String(nanoBig ?? "0"));
    return Number(n) / 1e9;
  } catch {
    return NaN;
  }
}

function withinDeclaredTol(declaredTon, actualTon) {
  const d = Number(declaredTon);
  if (!Number.isFinite(d) || !Number.isFinite(actualTon)) return false;
  const tol = Math.max(d * 0.35, 0.12);
  return Math.abs(d - actualTon) <= tol;
}

/**
 * Ищем на кошельке пользователя транзакцию с тем же нормализованным external-in, что и в BOC от TonConnect.
 */
async function waitForWalletTxByExternalBoc(client, bocBase64, opts) {
  const maxAttempts = Math.min(25, Math.max(1, Number(opts?.maxAttempts) || 14));
  const delayMs = Math.min(5000, Math.max(400, Number(opts?.delayMs) || 1200));
  const log = opts?.log;

  let inMessage;
  try {
    inMessage = loadMessage(Cell.fromBase64(String(bocBase64 || "").trim()).beginParse());
  } catch (e) {
    throw new Error(`Некорректный BOC: ${String(e?.message || e)}`);
  }
  if (inMessage.info.type !== "external-in") {
    throw new Error("TonConnect должен вернуть external-in сообщение");
  }
  const walletAddress = inMessage.info.dest;
  const targetHash = getNormalizedExtMessageHash(inMessage);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let txs = [];
    try {
      txs = await client.getTransactions(walletAddress, { limit: 20, archival: true });
    } catch (e) {
      if (log) log.push(`ton: getTransactions ${String(e.message || e).slice(0, 120)}`);
      if (attempt < maxAttempts - 1) await sleep(delayMs);
      continue;
    }
    for (const tx of txs) {
      const im = tx.inMessage;
      if (!im || im.info.type !== "external-in") continue;
      try {
        const h = getNormalizedExtMessageHash(im);
        if (Buffer.from(h).equals(Buffer.from(targetHash))) return tx;
      } catch {
        /* */
      }
    }
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return null;
}

function internalNano(info) {
  if (!info || info.type !== "internal") return 0n;
  const v = info.value;
  if (typeof v === "bigint") return v;
  if (v && typeof v.coins === "bigint") return v.coins;
  if (v && typeof v.coins === "number") return BigInt(Math.trunc(v.coins));
  return 0n;
}

function pickOutgoingToDeposit(tx, depositAddrParsed, memoPlain) {
  if (!tx.outMessages) return null;
  const wantMemoNorm = normalizeMemoForLookup(memoPlain);
  let best = null;
  for (const outMsg of tx.outMessages.values()) {
    if (outMsg.info.type !== "internal") continue;
    const dest = outMsg.info.dest;
    if (!(dest instanceof Address) || !depositAddrParsed.equals(dest)) continue;
    const coins = internalNano(outMsg.info);
    const ton = nanoToTonNumber(coins);
    const comment = commentFromOutMessage(outMsg);
    if (!userMemoMatchesDeposit(wantMemoNorm, comment || "")) continue;
    if (!best || ton > best.ton) best = { ton, comment, coins };
  }
  return best;
}

function txHashHex(tx) {
  try {
    return Buffer.from(tx.hash()).toString("hex");
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function rpcScalar(data) {
  if (data == null) return null;
  if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0] !== null) {
    const k = Object.keys(data[0])[0];
    return k !== undefined ? data[0][k] : null;
  }
  if (typeof data === "object" && data !== null && typeof data.wallet_credit_deposit === "string") {
    return data.wallet_credit_deposit;
  }
  return typeof data === "string" ? data : null;
}

/**
 * Просроченные заявки без зачисления — для cron.
 */
async function runExpireDepositIntents(sb, log) {
  const nowIso = new Date().toISOString();
  try {
    await sb(
      `deposit_intents?status=in.(pending,submitted)&wallet_operation_id=is.null&expires_at=lt.${encodeURIComponent(nowIso)}`,
      {
        method: "PATCH",
        body: { status: "expired", updated_at: nowIso },
        prefer: "return=minimal",
      }
    );
  } catch (e) {
    const m = String(e.message || "").toLowerCase();
    if (!m.includes("deposit_intent") && !m.includes("schema cache")) log.push(`intents: expire ${e.message}`);
  }
}

/**
 * Pending без оплаты и без BOC: если пользователь ушёл с экрана оплаты — не держим «ожидает» бесконечно.
 */
async function abandonStalePendingDepositIntents(sb, log) {
  const min = Math.min(120, Math.max(5, Number(process.env.DEPOSIT_PENDING_ABANDON_MIN) || 10));
  const cutIso = new Date(Date.now() - min * 60_000).toISOString();
  const nowIso = new Date().toISOString();
  try {
    await sb(
      `deposit_intents?status=eq.pending&wallet_operation_id=is.null&created_at=lt.${encodeURIComponent(cutIso)}`,
      {
        method: "PATCH",
        body: { status: "expired", updated_at: nowIso },
        prefer: "return=minimal",
      }
    );
  } catch (e) {
    const m = String(e.message || "").toLowerCase();
    if (!m.includes("deposit_intent") && !m.includes("schema cache")) log.push(`intents: abandon-pending ${e.message}`);
  }
}

async function cleanupDepositIntents(sb, log) {
  await runExpireDepositIntents(sb, log);
  await abandonStalePendingDepositIntents(sb, log);
}

/**
 * Одна попытка: BOC → tx на кошельке → исходящее на депозит с memo → wallet_credit_deposit → PATCH intent.
 */
async function tryFinalizeDepositFromBoc(api, params) {
  const { sb, sbRpc } = api;
  const {
    tgId,
    intentId,
    bocBase64,
    depositAddress,
    memoPlain,
    declaredTon,
    waitOpts,
  } = params;
  const log = params.log || [];
  const depositAddrParsed = Address.parse(String(depositAddress).trim());
  const client = tonClientFromEnv();

  const tx = await waitForWalletTxByExternalBoc(client, bocBase64, { ...waitOpts, log });
  if (!tx) {
    return { ok: true, credited: false, reason: "tx_not_on_chain_yet", log };
  }

  const out = pickOutgoingToDeposit(tx, depositAddrParsed, memoPlain);
  if (!out) {
    log.push("deposit: в tx нет исходящего на депозит с вашим комментарием (memo)");
    return { ok: false, credited: false, reason: "no_matching_out_msg", log };
  }
  if (!withinDeclaredTol(declaredTon, out.ton)) {
    log.push(
      `deposit: сумма в сети ${out.ton} не близка к заявленной ${declaredTon}`
    );
    return { ok: false, credited: false, reason: "amount_mismatch", log };
  }

  const hashHex = txHashHex(tx);
  if (hashHex.length < 8) {
    return { ok: false, credited: false, reason: "bad_tx_hash", log };
  }

  let opId = null;
  try {
    const dup = await sb(
      `wallet_operations?ton_tx_hash=eq.${encodeURIComponent(hashHex)}&select=id,tg_user_id&limit=1`
    );
    if (dup?.length) {
      if (String(dup[0].tg_user_id || "") === String(tgId)) {
        opId = dup[0].id;
      } else {
        log.push("deposit: tx hash уже привязан к другому пользователю");
        return { ok: false, credited: false, reason: "hash_conflict", log };
      }
    }
  } catch (e) {
    log.push(`deposit: dup-check ${String(e.message || e).slice(0, 80)}`);
  }

  if (!opId) {
    try {
      const rpcRaw = await sbRpc("wallet_credit_deposit", {
        p_tg_user_id: String(tgId),
        p_amount: out.ton,
        p_tx_hash: hashHex,
      });
      opId = rpcScalar(rpcRaw);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("duplicate") || msg.includes("unique")) {
        const dup2 = await sb(
          `wallet_operations?ton_tx_hash=eq.${encodeURIComponent(hashHex)}&select=id,tg_user_id&limit=1`
        );
        if (dup2?.length && String(dup2[0].tg_user_id || "") === String(tgId)) {
          opId = dup2[0].id;
        } else {
          log.push("deposit: duplicate tx без строки ledger — проверьте БД");
          return { ok: false, credited: false, reason: "duplicate_no_row", log };
        }
      } else {
        throw e;
      }
    }
  }

  if (!opId) {
    log.push("deposit: wallet_credit_deposit не вернул id");
    return { ok: false, credited: false, reason: "no_op_id", log };
  }

  await sb(`deposit_intents?id=eq.${encodeURIComponent(intentId)}&tg_user_id=eq.${encodeURIComponent(tgId)}`, {
    method: "PATCH",
    body: {
      status: "completed",
      wallet_operation_id: String(opId),
      ton_tx_hash: hashHex,
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });

  await notifyDepositCredited(tgId, out.ton).catch(() => {});
  log.push(`deposit: зачислено ${out.ton} TON tx=${hashHex.slice(0, 16)}…`);
  return { ok: true, credited: true, amountTon: out.ton, txHash: hashHex, operationId: opId, log };
}

/**
 * Обработать висящие submitted с сохранённым connect_boc (для syncMyDeposits).
 */
async function processSubmittedIntentsForUser(api, tgId, opts) {
  const { sb } = api;
  const log = opts?.log || [];
  const depositAddress = String(process.env.TON_DEPOSIT_ADDRESS || "").trim();
  if (!depositAddress) {
    log.push("deposit: TON_DEPOSIT_ADDRESS не задан");
    return { credited: 0, log };
  }

  const rows = await sb(
    `deposit_intents?tg_user_id=eq.${encodeURIComponent(tgId)}&status=eq.submitted&wallet_operation_id=is.null&select=id,declared_amount_ton,meta,created_at&order=created_at.desc&limit=1`
  );
  let credited = 0;
  const waitOpts = {
    maxAttempts: Math.min(10, Math.max(3, Number(process.env.DEPOSIT_SYNC_TX_ATTEMPTS) || 6)),
    delayMs: Math.min(4000, Math.max(500, Number(process.env.DEPOSIT_SYNC_TX_DELAY_MS) || 1200)),
  };

  const row = rows?.[0];
  if (row) {
    const boc = row.meta && typeof row.meta === "object" ? row.meta.connect_boc : null;
    if (boc && String(boc).length >= 24) {
      const memoRows = await sb(
        `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=deposit_memo&limit=1`
      );
      const memoPlain = String(memoRows?.[0]?.deposit_memo || "");
      if (memoPlain) {
        try {
          const r = await tryFinalizeDepositFromBoc(api, {
            tgId,
            intentId: row.id,
            bocBase64: String(boc),
            depositAddress,
            memoPlain,
            declaredTon: row.declared_amount_ton,
            waitOpts,
            log,
          });
          if (r.credited) credited = 1;
        } catch (e) {
          log.push(`deposit: intent ${String(row.id).slice(0, 8)} ${String(e.message || e).slice(0, 100)}`);
        }
      }
    }
  }
  return { credited, log };
}

module.exports = {
  runExpireDepositIntents,
  abandonStalePendingDepositIntents,
  cleanupDepositIntents,
  tryFinalizeDepositFromBoc,
  processSubmittedIntentsForUser,
  waitForWalletTxByExternalBoc,
  getNormalizedExtMessageHash,
};
