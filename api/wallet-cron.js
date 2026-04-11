/**
 * Vercel Cron: авто-зачисление входящих TON (TonAPI) + авто-отправка выводов (@ton/ton).
 * Защита: заголовок Authorization: Bearer CRON_SECRET (задай в Vercel + env CRON_SECRET).
 */
const crypto = require("crypto");
const { mnemonicToPrivateKey } = require("@ton/crypto");
const {
  TonClient,
  WalletContractV4,
  WalletContractV5R1,
  internal,
  Address,
  toNano,
  SendMode,
} = require("@ton/ton");

function safeSecretEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y || x.length !== y.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"));
  } catch {
    return false;
  }
}

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
    throw new Error(data?.message || data?.hint || data?.error || `RPC ${res.status}`);
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

function assertCronAuth(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const auth = req.headers?.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const alt = req.headers["x-wallet-cron-secret"];
  return safeSecretEqual(bearer, expected) || safeSecretEqual(alt, expected);
}

function tonapiBase() {
  return process.env.TON_TESTNET === "1" ? "https://testnet.tonapi.io" : "https://tonapi.io";
}

async function tonapiGet(path) {
  const url = `${tonapiBase()}/v2${path}`;
  const headers = { Accept: "application/json" };
  const key = String(process.env.TONAPI_KEY || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TonAPI ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
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

/** Достаёт текст комментария из входящего сообщения TonAPI. */
function extractDepositMemo(inMsg) {
  if (!inMsg || typeof inMsg !== "object") return null;
  const b = inMsg.decoded_body;
  if (b && typeof b === "object") {
    if (typeof b.text === "string" && b.text.trim()) return b.text.trim();
    if (typeof b.comment === "string" && b.comment.trim()) return b.comment.trim();
  }
  if (typeof inMsg.comment === "string" && inMsg.comment.trim()) return inMsg.comment.trim();
  if (inMsg.msg_data && typeof inMsg.msg_data.text === "string") return inMsg.msg_data.text.trim();
  return null;
}

function normalizeMemoForLookup(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function runDeposits(log) {
  if (String(process.env.WALLET_CRON_DISABLE_DEPOSITS || "").trim() === "1") {
    log.push("deposits: disabled (WALLET_CRON_DISABLE_DEPOSITS=1)");
    return 0;
  }
  const depositAddr = String(process.env.TON_DEPOSIT_ADDRESS || "").trim();
  if (!depositAddr) {
    log.push("deposits: skip (TON_DEPOSIT_ADDRESS empty)");
    return 0;
  }

  const minTon = Number(process.env.MIN_AUTO_DEPOSIT_TON);
  const min = Number.isFinite(minTon) && minTon > 0 ? minTon : 0.001;
  const limit = Math.min(50, Math.max(5, Number(process.env.WALLET_CRON_DEPOSIT_TX_LIMIT) || 30));

  let data;
  try {
    const enc = encodeURIComponent(depositAddr);
    data = await tonapiGet(`/blockchain/accounts/${enc}/transactions?limit=${limit}`);
  } catch (e) {
    log.push(`deposits: TonAPI error ${e.message}`);
    return 0;
  }

  const txs = Array.isArray(data.transactions) ? data.transactions : [];
  let credited = 0;

  for (const tx of txs) {
    if (tx.success === false) continue;
    const h = tx.hash || tx.event_id;
    if (!h) continue;
    const hashKey = String(h);

    const inMsg = tx.in_msg || tx.inMessage;
    if (!inMsg) continue;

    const nano = inMsg.value != null ? inMsg.value : inMsg.value_raw;
    if (nano == null) continue;
    const tonStr = nanoToTonString(nano);
    const tonNum = Number(tonStr);
    if (!Number.isFinite(tonNum) || tonNum < min) continue;

    const memoRaw = extractDepositMemo(inMsg);
    if (!memoRaw) continue;

    const memoCandidates = new Set();
    const full = normalizeMemoForLookup(memoRaw);
    if (full.length >= 6) memoCandidates.add(full);
    for (const part of memoRaw.split(/\s+/)) {
      const n = normalizeMemoForLookup(part);
      if (n.length >= 6) memoCandidates.add(n);
    }

    let tgUserId = "";
    for (const memo of memoCandidates) {
      try {
        const users = await sb(
          `users?deposit_memo=eq.${encodeURIComponent(memo)}&select=tg_user_id&limit=1`
        );
        if (users?.length) {
          tgUserId = String(users[0].tg_user_id);
          break;
        }
      } catch {
        /* next candidate */
      }
    }
    if (!tgUserId) continue;

    try {
      await sbRpc("wallet_credit_deposit", {
        p_tg_user_id: tgUserId,
        p_amount: tonNum,
        p_tx_hash: hashKey,
      });
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

async function createHotWalletFromMnemonicAsync() {
  const raw = String(process.env.TON_HOT_WALLET_MNEMONIC || "").trim();
  if (!raw) return null;
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 12) return null;

  const keyPair = await mnemonicToPrivateKey(words);
  const ver = String(process.env.TON_WALLET_VERSION || "v4").toLowerCase();
  if (ver === "v5" || ver === "v5r1") {
    const w = WalletContractV5R1.create({ publicKey: keyPair.publicKey });
    return { wallet: w, secretKey: keyPair.secretKey, kind: "v5r1" };
  }
  const w = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return { wallet: w, secretKey: keyPair.secretKey, kind: "v4" };
}

function tonClient() {
  const testnet = process.env.TON_TESTNET === "1";
  const endpoint =
    String(process.env.TON_JSON_RPC_URL || "").trim() ||
    (testnet ? "https://testnet.toncenter.com/api/v2/jsonRPC" : "https://toncenter.com/api/v2/jsonRPC");
  const apiKey = String(process.env.TONCENTER_API_KEY || "").trim() || undefined;
  return new TonClient({ endpoint, apiKey });
}

async function patchOpMeta(opId, partial) {
  const id = encodeURIComponent(opId);
  const rows = await sb(`wallet_operations?id=eq.${id}&select=meta&limit=1`);
  const prev = rows?.[0]?.meta && typeof rows[0].meta === "object" && !Array.isArray(rows[0].meta) ? rows[0].meta : {};
  await sb(`wallet_operations?id=eq.${id}`, {
    method: "PATCH",
    body: {
      meta: { ...prev, ...partial },
      updated_at: new Date().toISOString(),
    },
    prefer: "return=minimal",
  });
}

async function failWithdrawalRpc(opId) {
  await sbRpc("wallet_fail_withdrawal", { p_op_id: opId });
}

async function completeWithdrawalRpc(opId, txHash) {
  const ok = rpcScalar(
    await sbRpc("wallet_complete_withdrawal", {
      p_op_id: opId,
      p_tx_hash: txHash,
    })
  );
  if (!ok) throw new Error("complete_withdrawal returned false");
}

function findOutgoingTxHash(transactions, destFriendly, amountTon) {
  let dest;
  try {
    dest = Address.parse(String(destFriendly).trim());
  } catch {
    return null;
  }
  let want;
  try {
    want = toNano(Number(amountTon).toFixed(9));
  } catch {
    return null;
  }

  for (const tx of transactions) {
    const hash = tx.hash || tx.event_id;
    if (!hash) continue;
    const outs = tx.out_msgs || tx.outMessages || [];
    for (const om of outs) {
      const addrRaw =
        om.destination?.address ||
        om.recipient?.address ||
        om.to?.address ||
        (typeof om.destination === "string" ? om.destination : null) ||
        (typeof om.recipient === "string" ? om.recipient : null);
      if (!addrRaw) continue;
      let toAddr;
      try {
        toAddr = Address.parse(addrRaw);
      } catch {
        continue;
      }
      if (!toAddr.equals(dest)) continue;
      const nano = om.value != null ? BigInt(String(om.value)) : 0n;
      const low = want - (want * 2n) / 100n - 50000000n;
      const high = want + (want * 2n) / 100n + 50000000n;
      if (nano >= low && nano <= high) return String(hash);
    }
  }
  return null;
}

async function recoverOrSendWithdrawal(op, client, hot, log) {
  const opId = op.id;
  const toAddr = String(op.to_address || "").trim();
  const amountTon = Number(op.amount);
  const meta = op.meta && typeof op.meta === "object" ? op.meta : {};

  const depositConfigured = String(process.env.TON_DEPOSIT_ADDRESS || "").trim();
  try {
    if (!Address.parse(depositConfigured).equals(hot.wallet.address)) {
      log.push("withdraw: TON_DEPOSIT_ADDRESS ≠ адрес из мнемоники — проверь TON_WALLET_VERSION / кошелёк");
      return;
    }
  } catch {
    log.push("withdraw: invalid TON_DEPOSIT_ADDRESS");
    return;
  }

  if (meta.auto_withdraw_tx_hash) {
    try {
      await completeWithdrawalRpc(opId, String(meta.auto_withdraw_tx_hash));
      await patchOpMeta(opId, { auto_withdraw_cleared: true });
      log.push(`withdraw: completed op=${opId}`);
    } catch (e) {
      log.push(`withdraw: complete retry failed op=${opId} ${e.message}`);
    }
    return;
  }

  const staleMs = Number(process.env.AUTO_WITHDRAW_STALE_MS) || 3600000;
  const sentAt = meta.auto_withdraw_sent_at ? new Date(meta.auto_withdraw_sent_at).getTime() : 0;
  if (meta.auto_withdraw_sent_at && !meta.auto_withdraw_tx_hash) {
    const enc = encodeURIComponent(depositConfigured);
    const data = await tonapiGet(`/blockchain/accounts/${enc}/transactions?limit=25`);
    const txs = Array.isArray(data.transactions) ? data.transactions : [];
    const found = findOutgoingTxHash(txs, toAddr, amountTon);
    if (found) {
      await patchOpMeta(opId, { auto_withdraw_tx_hash: found });
      await completeWithdrawalRpc(opId, found);
      log.push(`withdraw: recovered + completed op=${opId}`);
      return;
    }
    if (Date.now() - sentAt < staleMs) {
      log.push(`withdraw: wait confirm op=${opId}`);
      return;
    }
    log.push(`withdraw: stale send op=${opId} — ручная проверка; возврат средств пользователю`);
    try {
      await failWithdrawalRpc(opId);
      await patchOpMeta(opId, { auto_withdraw_failed_stale: new Date().toISOString() });
    } catch (e) {
      log.push(`withdraw: fail stale error ${e.message}`);
    }
    return;
  }

  const contract = client.open(hot.wallet);
  let seqno;
  try {
    seqno = await contract.getSeqno();
  } catch (e) {
    log.push(`withdraw: seqno error ${e.message}`);
    return;
  }

  await patchOpMeta(opId, { auto_withdraw_sent_at: new Date().toISOString() });

  try {
    const dest = Address.parse(toAddr);
    const value = toNano(Number(amountTon).toFixed(9));
    const messages = [
      internal({
        to: dest,
        value,
        bounce: false,
      }),
    ];
    if (hot.kind === "v5r1") {
      await contract.sendTransfer({
        seqno,
        secretKey: hot.secretKey,
        messages,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
      });
    } else {
      await contract.sendTransfer({
        seqno,
        secretKey: hot.secretKey,
        messages,
      });
    }
  } catch (e) {
    log.push(`withdraw: send failed op=${opId} ${e.message}`);
    try {
      await failWithdrawalRpc(opId);
      await patchOpMeta(opId, {
        auto_withdraw_send_error: String(e.message || e).slice(0, 500),
        auto_withdraw_sent_at: null,
      });
    } catch (e2) {
      log.push(`withdraw: refund fail ${e2.message}`);
    }
    return;
  }

  await new Promise((r) => setTimeout(r, Number(process.env.AUTO_WITHDRAW_POLL_MS) || 4000));

  const enc = encodeURIComponent(depositConfigured);
  const data = await tonapiGet(`/blockchain/accounts/${enc}/transactions?limit=25`);
  const txs = Array.isArray(data.transactions) ? data.transactions : [];
  const found = findOutgoingTxHash(txs, toAddr, amountTon);

  if (found) {
    await patchOpMeta(opId, { auto_withdraw_tx_hash: found });
    await completeWithdrawalRpc(opId, found);
    log.push(`withdraw: sent + completed op=${opId}`);
  } else {
    log.push(`withdraw: sent, hash not found yet op=${opId} (следующий cron)`);
  }
}

async function runWithdrawals(log) {
  if (String(process.env.WALLET_CRON_DISABLE_WITHDRAW || "").trim() === "1") {
    log.push("withdraw: disabled (WALLET_CRON_DISABLE_WITHDRAW=1)");
    return 0;
  }
  const hot = await createHotWalletFromMnemonicAsync();
  if (!hot) {
    log.push("withdraw: skip (TON_HOT_WALLET_MNEMONIC not set)");
    return 0;
  }

  const max = Math.min(5, Math.max(1, Number(process.env.WALLET_CRON_MAX_WITHDRAWALS) || 1));
  const rows = await sb(
    `wallet_operations?kind=eq.withdrawal&status=eq.pending&select=id,to_address,amount,meta,created_at&order=created_at.asc&limit=${max}`
  );
  if (!rows?.length) return 0;

  const client = tonClient();
  for (const op of rows) {
    try {
      await recoverOrSendWithdrawal(op, client, hot, log);
    } catch (e) {
      log.push(`withdraw: op ${op.id} ${e.message}`);
    }
  }
  return rows.length;
}

module.exports = async (req, res) => {
  const log = [];
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }
    if (!assertCronAuth(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    let deposits = 0;
    let withdrawTouched = 0;
    try {
      deposits = await runDeposits(log);
    } catch (e) {
      log.push(`deposits fatal: ${e.message}`);
    }
    try {
      withdrawTouched = await runWithdrawals(log);
    } catch (e) {
      log.push(`withdraw fatal: ${e.message}`);
    }

    return res.status(200).json({
      ok: true,
      depositsCredited: deposits,
      withdrawalsSeen: withdrawTouched,
      log,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error", log });
  }
};
