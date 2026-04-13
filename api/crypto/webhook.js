const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = String(process.env.CRYPTO_BOT_WEBHOOK_SECRET || "").trim();

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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const payload = parseJwtPayload(SUPABASE_SERVICE_ROLE_KEY);
  if (payload?.role !== "service_role") {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is invalid");
  }
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  assertSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || `Supabase REST error: ${res.status}`);
  return data;
}

async function sbRpc(name, payload) {
  assertSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(name)}`, {
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
  if (!res.ok) throw new Error(data?.message || `RPC error: ${res.status}`);
  return data;
}

function validSecret(req) {
  if (!WEBHOOK_SECRET) return true;
  const byHeader =
    String(req.headers["x-webhook-secret"] || "") === WEBHOOK_SECRET ||
    String(req.headers["x-crypto-bot-secret"] || "") === WEBHOOK_SECRET;
  const byQuery = String(req.query?.secret || "") === WEBHOOK_SECRET;
  return byHeader || byQuery;
}

function pickInvoicePayload(body) {
  const b = body || {};
  const payload = b.payload || b.data || b.update || {};
  const updateType = String(b.update_type || b.type || payload?.update_type || "");
  if (updateType === "invoice_paid" && payload) return payload;
  if (b.invoice_id && b.status) return b;
  if (payload?.invoice_id && payload?.status) return payload;
  return null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
    if (!validSecret(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
    const invoice = pickInvoicePayload(req.body);
    if (!invoice) return res.status(200).json({ ok: true, ignored: true });

    const invoiceId = String(invoice.invoice_id || "").trim();
    const status = String(invoice.status || "").toLowerCase();
    if (!invoiceId) return res.status(200).json({ ok: true, ignored: true });

    const rows = await sb(
      `usdt_operations?crypto_invoice_id=eq.${encodeURIComponent(invoiceId)}&direction=eq.deposit&select=id,tg_user_id,status,net_ton,wallet_operation_id&limit=1`
    );
    const row = rows?.[0];
    if (!row) return res.status(200).json({ ok: true, ignored: true });
    if (row.status === "completed" || row.wallet_operation_id) {
      return res.status(200).json({ ok: true, dedup: true });
    }

    if (status === "paid" || status === "confirmed") {
      const tonAmount = Number(row.net_ton || 0);
      if (!(tonAmount > 0)) throw new Error("Invalid TON amount");
      const txHash = `usdtdep:${invoiceId}`;
      const opRes = await sbRpc("wallet_credit_deposit", {
        p_tg_user_id: String(row.tg_user_id),
        p_amount: tonAmount,
        p_tx_hash: txHash,
      });
      const opId = Array.isArray(opRes) ? Object.values(opRes[0] || {})[0] : opRes;
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
      return res.status(200).json({ ok: true, credited: true });
    }

    if (status === "expired" || status === "failed") {
      await sb(`usdt_operations?id=eq.${encodeURIComponent(String(row.id))}`, {
        method: "PATCH",
        body: { status: "failed", updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      return res.status(200).json({ ok: true, failed: true });
    }

    return res.status(200).json({ ok: true, ignoredStatus: status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
