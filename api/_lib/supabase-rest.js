const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

module.exports = { sb };
