/**
 * Сканирование входящих TON на TON_DEPOSIT_ADDRESS и вызов wallet_credit_deposit.
 * Используется wallet-cron и action syncMyDeposits в user.js.
 */
"use strict";

const { Address, Cell } = require("@ton/ton");

function parseJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function assertSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const payload = parseJwtPayload(key);
  if ((payload?.role || "") !== "service_role") {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be service_role");
  }
}

async function sb(path, opts = {}) {
  assertSupabaseEnv();
  const { method = "GET", body, prefer } = opts;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message || data?.hint || `Supabase ${res.status}`);
  }
  return data;
}

async function sbRpc(name, payload) {
  assertSupabaseEnv();
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message || data?.hint || data?.error || `RPC error: ${res.status}`);
  }
  return data;
}

function rpcScalar(data) {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0] !== null) {
    const k = Object.keys(data[0])[0];
    return k !== undefined ? data[0][k] : null;
  }
  if (typeof data === "object" && data !== null && typeof data.wallet_credit_deposit === "string") {
    return data.wallet_credit_deposit;
  }
  return data;
}

function tonapiBase() {
  return process.env.TON_TESTNET === "1" ? "https://testnet.tonapi.io" : "https://tonapi.io";
}

/** Ton Console отдаёт токен без префикса; в .env часто копируют `Bearer …` или кавычки — иначе TonAPI 401 / illegal base32. */
function normalizeTonapiKey(raw) {
  let key = String(raw ?? "").trim();
  if (!key) return "";
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice(7).trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

async function tonapiGet(path) {
  const url = `${tonapiBase()}/v2${path}`;
  const headers = { Accept: "application/json" };
  const key = normalizeTonapiKey(process.env.TONAPI_KEY);
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TonAPI ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

function normalizeTonCenterKey(raw) {
  let key = String(raw ?? "").trim();
  if (!key) return "";
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice(7).trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function tonCenterApiBase() {
  return process.env.TON_TESTNET === "1" ? "https://testnet.toncenter.com/api/v2" : "https://toncenter.com/api/v2";
}

async function toncenterGetTransactions(addressRaw, limit, apiKey) {
  const base = tonCenterApiBase();
  const q = apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : "";
  const res = await fetch(`${base}/jsonRPC${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactions",
      params: { address: String(addressRaw || "").trim(), limit, archival: true },
    }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(String(j.error || `HTTP ${res.status}`));
  const r = j.result;
  return Array.isArray(r) ? r : [];
}

/** Приводит ответ Ton Center к полям, которые ждёт extractDepositMemo / цикл runDeposits. */
function tonCenterTxToCommon(tx) {
  if (!tx || typeof tx !== "object") return null;
  const tid = tx.transaction_id;
  if (!tid || tid.hash == null) return null;
  const hashKey = String(tid.hash).replace(/\s/g, "");
  if (!hashKey) return null;
  const inMsgRaw = tx.in_msg;
  if (!inMsgRaw || typeof inMsgRaw !== "object") return null;
  const inMsg = { ...inMsgRaw };
  const md = inMsg.msg_data;
  if (md && typeof md === "object") {
    const typ = md["@type"] || md.type;
    if (typ === "msg.dataText" && md.text != null) {
      inMsg.decoded_body = { type: "text_comment", text: String(md.text) };
    }
    if ((typ === "msg.dataRaw" || typ === "msg.dataBody") && md.body) {
      try {
        inMsg.raw_body = Buffer.from(String(md.body), "base64").toString("hex");
      } catch {
        /* */
      }
    }
  }
  if (inMsg.value == null && inMsg.value_raw != null) inMsg.value = inMsg.value_raw;
  return { hash: hashKey, event_id: hashKey, success: true, in_msg: inMsg };
}

/**
 * Сначала Ton Center (если задан TONCENTER_API_KEY), иначе сразу TonAPI.
 */
async function fetchDepositTransactions(depositAddr, limit, log, onlyTgUserId) {
  let rawAddr = "";
  try {
    rawAddr = Address.parse(String(depositAddr).trim()).toRawString();
  } catch {
    rawAddr = String(depositAddr).trim();
  }

  const tcKey = normalizeTonCenterKey(process.env.TONCENTER_API_KEY);
  if (tcKey) {
    try {
      const arr = await toncenterGetTransactions(rawAddr, limit, tcKey);
      const mapped = arr.map(tonCenterTxToCommon).filter(Boolean);
      if (mapped.length) {
        if (onlyTgUserId) log.push(`deposits: TonCenter txs=${mapped.length}`);
        return { transactions: mapped, source: "TonCenter" };
      }
      if (onlyTgUserId) log.push("deposits: TonCenter 0 txs — пробуем TonAPI");
    } catch (e) {
      if (onlyTgUserId) log.push(`deposits: TonCenter ${String(e.message || e).slice(0, 160)}`);
    }
  }

  let data = { transactions: [] };
  let lastErr = null;
  let usedAddr = "";
  for (const addrVariant of tonapiAccountPathVariants(depositAddr)) {
    try {
      const enc = encodeURIComponent(addrVariant);
      const attempt = await tonapiGet(
        `/blockchain/accounts/${enc}/transactions?limit=${limit}&sort_order=desc`
      );
      const tlist = Array.isArray(attempt.transactions) ? attempt.transactions : [];
      if (tlist.length > 0) {
        data = attempt;
        usedAddr = addrVariant;
        lastErr = null;
        break;
      }
      data = attempt;
      usedAddr = addrVariant;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr && (!data.transactions || !data.transactions.length)) {
    throw lastErr;
  }
  const txs = Array.isArray(data.transactions) ? data.transactions : [];
  if (onlyTgUserId) {
    log.push(`deposits: TonAPI txs=${txs.length} addr=${String(usedAddr || depositAddr).slice(0, 12)}…`);
  }
  return { transactions: txs, source: "TonAPI" };
}

function nanoToTonString(nano) {
  try {
    const n = BigInt(String(nano ?? "0"));
    const whole = n / 1000000000n;
    const frac = n % 1000000000n;
    return `${whole}.${frac.toString().padStart(9, "0")}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return "0";
  }
}

function normalizeMemoForLookup(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Разбор text_comment из hex BoC тела сообщения (TonAPI raw_body). */
function extractMemoFromRawBodyHex(hexStr) {
  const hex = String(hexStr || "").replace(/\s+/g, "").trim();
  if (hex.length < 16) return null;
  try {
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 4) return null;
    const roots = Cell.fromBoc(buf);
    for (const root of roots) {
      try {
        const s = root.beginParse();
        const op = s.loadUint(32);
        if (op === 0) {
          const t = s.loadStringTail();
          if (t && String(t).trim()) return String(t).trim();
        }
      } catch {
        /* next root */
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Обход дерева ячеек: комментарий op=0 часто лежит во вложенном ref (кошельки v4/v5). */
function deepExtractTextCommentFromBocBuffer(buf) {
  if (!buf || buf.length < 4) return null;
  let roots;
  try {
    roots = Cell.fromBoc(buf);
  } catch {
    return null;
  }
  function walk(cell, depth) {
    if (depth > 28 || !cell) return null;
    try {
      const s = cell.beginParse();
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
    const refs = cell.refs || [];
    for (let i = 0; i < refs.length; i++) {
      const x = walk(refs[i], depth + 1);
      if (x) return x;
    }
    return null;
  }
  for (const root of roots) {
    const x = walk(root, 0);
    if (x) return x;
  }
  return null;
}

function deepFindMemoInObject(obj, depth) {
  if (depth > 10 || obj == null) return null;
  if (typeof obj === "string") {
    const t = obj.trim();
    if (t.length >= 4 && t.length <= 256) return t;
    return null;
  }
  if (typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const r = deepFindMemoInObject(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const typ = obj.type;
  if (typ === "text_comment" && typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
  if ((typ === "text" || typ === "comment") && typeof obj.comment === "string" && obj.comment.trim()) {
    return obj.comment.trim();
  }
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
  if (typeof obj.comment === "string" && obj.comment.trim()) return obj.comment.trim();
  for (const v of Object.values(obj)) {
    const r = deepFindMemoInObject(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Текст комментария из входящего сообщения (TonAPI / TonConnect text_comment). */
function extractDepositMemo(inMsg) {
  if (!inMsg || typeof inMsg !== "object") return null;
  const b = inMsg.decoded_body;
  if (b && typeof b === "object") {
    if (b.type === "text_comment" && typeof b.text === "string" && b.text.trim()) return b.text.trim();
    if (typeof b.text === "string" && b.text.trim()) return b.text.trim();
    if (typeof b.comment === "string" && b.comment.trim()) return b.comment.trim();
    const deep = deepFindMemoInObject(b, 0);
    if (deep) return deep;
  }
  const mc = inMsg.message_content;
  if (mc && typeof mc === "object") {
    if (typeof mc.comment === "string" && mc.comment.trim()) return mc.comment.trim();
    const dec = mc.decoded;
    if (dec && typeof dec === "object") {
      if (dec.type === "text_comment" && typeof dec.text === "string" && dec.text.trim()) return dec.text.trim();
      if (dec.type === "text" && typeof dec.comment === "string" && dec.comment.trim()) return dec.comment.trim();
      if (typeof dec.text === "string" && dec.text.trim()) return dec.text.trim();
      if (typeof dec.comment === "string" && dec.comment.trim()) return dec.comment.trim();
      const d2 = deepFindMemoInObject(dec, 0);
      if (d2) return d2;
    }
    const d3 = deepFindMemoInObject(mc, 0);
    if (d3) return d3;
  }
  if (typeof inMsg.comment === "string" && inMsg.comment.trim()) return inMsg.comment.trim();
  if (inMsg.msg_data && typeof inMsg.msg_data.text === "string") return inMsg.msg_data.text.trim();
  if (typeof inMsg.raw_body === "string" && inMsg.raw_body.length > 10) {
    const fromBoc = extractMemoFromRawBodyHex(inMsg.raw_body);
    if (fromBoc) return fromBoc;
    try {
      const buf = Buffer.from(String(inMsg.raw_body).replace(/\s+/g, ""), "hex");
      const deep = deepExtractTextCommentFromBocBuffer(buf);
      if (deep) return deep;
    } catch {
      /* */
    }
  }
  const mdBody = inMsg.msg_data && typeof inMsg.msg_data.body === "string" ? inMsg.msg_data.body : "";
  if (mdBody) {
    try {
      const buf = Buffer.from(String(mdBody), "base64");
      const deep = deepExtractTextCommentFromBocBuffer(buf);
      if (deep) return deep;
    } catch {
      /* */
    }
  }
  return null;
}

function addMemoCandidatesFromRaw(memoRaw, memoCandidates) {
  const full = normalizeMemoForLookup(memoRaw);
  if (full.length >= 6) memoCandidates.add(full);
  for (const part of String(memoRaw).split(/\s+/)) {
    const n = normalizeMemoForLookup(part);
    if (n.length >= 6) memoCandidates.add(n);
  }
}

/** Совпадение memo пользователя с текстом из сети (подстрока, разный регистр). */
function userMemoMatchesDeposit(wantMemoNorm, memoRaw) {
  if (!wantMemoNorm || wantMemoNorm.length < 6 || !memoRaw) return false;
  const full = normalizeMemoForLookup(memoRaw);
  if (full === wantMemoNorm) return true;
  if (full.includes(wantMemoNorm)) return true;
  if (wantMemoNorm.includes(full) && full.length >= 6) return true;
  const cand = new Set();
  addMemoCandidatesFromRaw(memoRaw, cand);
  return cand.has(wantMemoNorm);
}

/** Входящее сообщение действительно на наш адрес приёма (если поле есть в ответе API). */
function incomingDestMatchesOurWallet(inMsg, depositAddrRaw) {
  const raw = String(depositAddrRaw || "").trim();
  if (!raw || !inMsg || typeof inMsg !== "object") return true;
  const dest = inMsg.destination;
  const destStr =
    dest == null
      ? ""
      : typeof dest === "string"
        ? dest
        : typeof dest === "object"
          ? String(dest.account_address || dest.address || "")
          : "";
  if (!destStr) return true;
  try {
    return Address.parse(raw).equals(Address.parse(destStr));
  } catch {
    return true;
  }
}

/** Нормализует адрес для запроса к TonAPI (все распространённые форматы). */
function tonapiAccountPathVariants(depositAddrRaw) {
  const raw = String(depositAddrRaw || "").trim();
  const out = [];
  const seen = new Set();
  function add(x) {
    const s = String(x || "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  add(raw);
  try {
    const a = Address.parse(raw);
    add(a.toString({ bounceable: true, urlSafe: true }));
    add(a.toString({ bounceable: false, urlSafe: true }));
    add(a.toRawString());
  } catch {
    /* как в env */
  }
  return out;
}

async function runExpireDepositIntents(log) {
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

async function linkDepositIntentAfterCredit(tgUserId, tonNum, txHash, walletOpId, log) {
  const rows = await sb(
    `deposit_intents?tg_user_id=eq.${encodeURIComponent(tgUserId)}&status=in.(pending,submitted)&wallet_operation_id=is.null&select=id,declared_amount_ton,status,created_at&order=created_at.desc&limit=15`
  );
  if (!rows?.length) return;
  const withinTol = (declared, actual) => {
    const d = Number(declared);
    if (!Number.isFinite(d)) return false;
    const tol = Math.max(d * 0.35, 0.12);
    return Math.abs(d - actual) <= tol;
  };
  const submitted = rows.filter((r) => r.status === "submitted");
  const pool = submitted.length ? submitted : rows;
  const best = pool.find((r) => withinTol(r.declared_amount_ton, tonNum)) || pool[0];
  if (!best) return;
  await sb(`deposit_intents?id=eq.${encodeURIComponent(best.id)}`, {
    method: "PATCH",
    body: {
      status: "completed",
      wallet_operation_id: String(walletOpId),
      ton_tx_hash: String(txHash),
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
  log.push(`deposits: intent ${String(best.id).slice(0, 8)}… → op ${String(walletOpId).slice(0, 8)}…`);
}

/**
 * @param {string[]} log
 * @param {{ onlyTgUserId?: string }} [opts]
 */
async function runDeposits(log, opts = {}) {
  if (String(process.env.WALLET_CRON_DISABLE_DEPOSITS || "").trim() === "1") {
    log.push("deposits: disabled (WALLET_CRON_DISABLE_DEPOSITS=1)");
    return 0;
  }
  let depositAddr = String(process.env.TON_DEPOSIT_ADDRESS || "").trim();
  if (
    (depositAddr.startsWith('"') && depositAddr.endsWith('"')) ||
    (depositAddr.startsWith("'") && depositAddr.endsWith("'"))
  ) {
    depositAddr = depositAddr.slice(1, -1).trim();
  }
  if (!depositAddr) {
    log.push("deposits: skip (TON_DEPOSIT_ADDRESS empty)");
    return 0;
  }

  const onlyTgUserId = opts.onlyTgUserId ? String(opts.onlyTgUserId) : "";
  let wantMemoNorm = "";
  if (onlyTgUserId) {
    const ur = await sb(
      `users?tg_user_id=eq.${encodeURIComponent(onlyTgUserId)}&select=deposit_memo&limit=1`
    );
    wantMemoNorm = normalizeMemoForLookup(ur?.[0]?.deposit_memo || "");
    if (!wantMemoNorm || wantMemoNorm.length < 6) {
      log.push("deposits: sync skipped (no deposit_memo for user)");
      return 0;
    }
  }

  const minTon = Number(process.env.MIN_AUTO_DEPOSIT_TON);
  const min = Number.isFinite(minTon) && minTon > 0 ? minTon : 0.001;
  const defLimit = onlyTgUserId ? 100 : 30;
  const limit = Math.min(100, Math.max(5, Number(process.env.WALLET_CRON_DEPOSIT_TX_LIMIT) || defLimit));

  let txs = [];
  try {
    const pack = await fetchDepositTransactions(depositAddr, limit, log, !!onlyTgUserId);
    txs = pack.transactions || [];
  } catch (lastErr) {
    log.push(`deposits: ошибка загрузки транзакций ${String(lastErr.message || lastErr)}`);
    return 0;
  }

  if (onlyTgUserId && txs.length === 0) {
    log.push(
      "deposits: 0 транзакций — проверьте TON_DEPOSIT_ADDRESS и TONCENTER_API_KEY; подождите появления tx в индексе"
    );
  }

  let credited = 0;
  let noCommentLogged = 0;
  let memoMismatchLogged = 0;

  for (const tx of txs) {
    if (tx.success === false) continue;
    const h = tx.hash || tx.event_id;
    if (!h) continue;
    const hashKey = String(h);

    const inMsg = tx.in_msg || tx.inMessage;
    if (!inMsg) continue;

    if (onlyTgUserId && !incomingDestMatchesOurWallet(inMsg, depositAddr)) continue;

    const nano = inMsg.value != null ? inMsg.value : inMsg.value_raw;
    if (nano == null) continue;
    const tonStr = nanoToTonString(nano);
    const tonNum = Number(tonStr);
    if (!Number.isFinite(tonNum) || tonNum < min) continue;

    const memoRaw = extractDepositMemo(inMsg);
    if (!memoRaw) {
      if (onlyTgUserId && noCommentLogged < 5) {
        log.push(`deposits: tx ${hashKey.slice(0, 12)}… — в теле входящего сообщения нет текстового комментария (нужна оплата через кнопку в приложении)`);
        noCommentLogged += 1;
      }
      continue;
    }

    const memoCandidates = new Set();
    addMemoCandidatesFromRaw(memoRaw, memoCandidates);

    let tgUserId = "";
    if (onlyTgUserId) {
      if (!userMemoMatchesDeposit(wantMemoNorm, memoRaw)) {
        if (memoMismatchLogged < 4) {
          log.push(
            "deposits: в транзакции другой комментарий — зачисление только при оплате кнопкой «Отправить через TON» с автоподстановкой тега"
          );
          memoMismatchLogged += 1;
        }
        continue;
      }
      tgUserId = onlyTgUserId;
    } else {
      for (const memo of memoCandidates) {
        try {
          let users = await sb(
            `users?deposit_memo=eq.${encodeURIComponent(memo)}&select=tg_user_id&limit=1`
          );
          if (!users?.length) {
            users = await sb(
              `users?deposit_memo=ilike.${encodeURIComponent(memo)}&select=tg_user_id&limit=1`
            );
          }
          if (users?.length) {
            tgUserId = String(users[0].tg_user_id);
            break;
          }
        } catch {
          /* next */
        }
      }
    }

    if (!tgUserId) {
      if (!onlyTgUserId) {
        log.push(`deposits: skip tx ${hashKey.slice(0, 12)}… (memo not matched to user)`);
      }
      continue;
    }

    try {
      const rpcRaw = await sbRpc("wallet_credit_deposit", {
        p_tg_user_id: tgUserId,
        p_amount: tonNum,
        p_tx_hash: hashKey,
      });
      const opId = rpcScalar(rpcRaw);
      if (!opId) {
        log.push(`deposits: wallet_credit_deposit returned no id tx=${hashKey.slice(0, 12)}…`);
        continue;
      }
      try {
        await linkDepositIntentAfterCredit(tgUserId, tonNum, hashKey, opId, log);
      } catch (e2) {
        log.push(`deposits: link intent ${e2.message}`);
      }
      credited += 1;
      log.push(`deposits: credited ${tonStr} TON user=${tgUserId} hash=${hashKey.slice(0, 16)}…`);
    } catch (e) {
      if (String(e.message || "").includes("duplicate") || String(e.message || "").includes("unique")) {
        continue;
      }
      log.push(`deposits: credit failed ${hashKey.slice(0, 12)} ${e.message}`);
    }
  }

  return credited;
}

module.exports = {
  runDeposits,
  runExpireDepositIntents,
  extractDepositMemo,
  normalizeMemoForLookup,
  userMemoMatchesDeposit,
};
