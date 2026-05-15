const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REFERRAL_COMMISSION_RATE = 0.05;
const REFERRAL_WELCOME_TON = 0.5;
const REFERRAL_MIN_CLAIM_TON = 50;

function assertSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  assertSupabaseEnv();
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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
  if (typeof data === "number" || typeof data === "string") return data;
  if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0] !== null) {
    const k = Object.keys(data[0])[0];
    return data[0][k];
  }
  return data;
}

function normalizeRefCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function depositCommissionSourceKey(depositorTgId, txKey) {
  const raw = `depcomm:${depositorTgId}:${String(txKey || "").trim()}`;
  return raw.slice(0, 200);
}

/**
 * 5% of deposit to referrer's referral_balance (idempotent per source key).
 */
async function processDepositReferralCommission(depositorTgId, amountTon, sourceKey) {
  const tgId = String(depositorTgId || "").trim();
  const amount = Number(amountTon);
  const key = depositCommissionSourceKey(tgId, sourceKey);
  if (!tgId || !Number.isFinite(amount) || amount <= 0 || key.length < 8) {
    return { credited: 0, skipped: true };
  }
  try {
    const res = await sbRpc("referral_credit_commission", {
      p_depositor_tg_id: tgId,
      p_deposit_amount: amount,
      p_source_key: key,
    });
    const credited = Number(rpcScalar(res) || 0);
    return { credited, skipped: credited <= 0 };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("referral_credit_commission") || msg.includes("does not exist")) {
      console.warn("referral_credit_commission RPC missing — apply db migration 20260515");
    } else {
      console.error("processDepositReferralCommission:", msg);
    }
    return { credited: 0, skipped: true, error: msg };
  }
}

/** 0.5 TON welcome on main balance when referred user binds a valid code (once). */
async function tryGrantReferralWelcome(referredTgId) {
  const tgId = String(referredTgId || "").trim();
  if (!tgId) return { granted: false };
  try {
    const res = await sbRpc("referral_grant_welcome", { p_referred_tg_id: tgId });
    return { granted: !!res };
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes("referral_grant_welcome") && !msg.includes("does not exist")) {
      console.error("tryGrantReferralWelcome:", msg);
    }
    return { granted: false, error: msg };
  }
}

async function claimReferralEarnings(tgUserId) {
  const tgId = String(tgUserId || "").trim();
  if (!tgId) throw new Error("Missing user id");
  const res = await sbRpc("referral_claim_earnings", { p_tg_user_id: tgId });
  const amount = Number(rpcScalar(res) || 0);
  if (!(amount > 0)) throw new Error("Nothing to claim");
  return { claimedTon: amount };
}

async function getReferralStats(tgUserId) {
  const tgId = String(tgUserId || "").trim();
  if (!tgId) throw new Error("Missing user id");

  const rows = await sb(
    `users?tg_user_id=eq.${encodeURIComponent(tgId)}&select=tg_user_id,referral_code,referral_balance,referred_by&limit=1`
  );
  const me = rows?.[0];
  if (!me) throw new Error("User not found");

  const myCode = me.referral_code || "";
  let referralsCount = 0;
  let referrals = [];
  if (myCode) {
    const refRows = await sb(
      `users?referred_by=eq.${encodeURIComponent(myCode)}&select=tg_user_id,first_name,last_name,username,created_at&order=created_at.desc&limit=50`
    );
    referrals = (refRows || []).map((r) => ({
      tg_user_id: r.tg_user_id,
      display_name:
        [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
        (r.username ? `@${r.username}` : `ID ${r.tg_user_id}`),
      joined_at: r.created_at,
    }));
    referralsCount = referrals.length;
  }

  let totalEarned = 0;
  try {
    const ledger = await sb(
      `referral_ledger?tg_user_id=eq.${encodeURIComponent(tgId)}&event_type=eq.deposit_commission&select=amount`
    );
    for (const row of ledger || []) {
      totalEarned += Number(row.amount || 0);
    }
  } catch {
    /* ledger may not exist yet */
  }

  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "Fffasdq_bot").replace(/^@/, "");
  const shareLink = myCode
    ? `https://t.me/${botUsername}?start=${encodeURIComponent(myCode)}`
    : "";

  return {
    referralCode: myCode,
    referralBalance: Number(me.referral_balance || 0),
    referralsCount,
    referrals,
    totalEarnedFromDeposits: roundTon(totalEarned),
    minClaimTon: REFERRAL_MIN_CLAIM_TON,
    commissionPercent: Math.round(REFERRAL_COMMISSION_RATE * 100),
    welcomeBonusTon: REFERRAL_WELCOME_TON,
    shareLink,
    canClaim: Number(me.referral_balance || 0) + 1e-12 >= REFERRAL_MIN_CLAIM_TON,
  };
}

function roundTon(n) {
  return Math.round(Number(n || 0) * 1e9) / 1e9;
}

function buildReferralShareText(code) {
  return (
    `✨ Тебя пригласили в F1 Duel!\n\n` +
    `🔥 Открой приложение: @${String(process.env.TELEGRAM_BOT_USERNAME || "Fffasdq_bot").replace(/^@/, "")}\n\n` +
    `🔐 Код приглашения: ${code || "—"}\n` +
    `🎁 При первом входе с кодом — <b>0.5 TON</b> на баланс.`
  );
}

module.exports = {
  REFERRAL_COMMISSION_RATE,
  REFERRAL_WELCOME_TON,
  REFERRAL_MIN_CLAIM_TON,
  normalizeRefCode,
  processDepositReferralCommission,
  tryGrantReferralWelcome,
  claimReferralEarnings,
  getReferralStats,
  buildReferralShareText,
  depositCommissionSourceKey,
};
