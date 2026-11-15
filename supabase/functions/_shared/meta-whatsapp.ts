// Shared helpers for the WhatsApp (Meta Cloud API) edge functions.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

export const GRAPH_VERSION = "v21.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const META_APP_ID = Deno.env.get("META_APP_ID") || "";
export const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
export const META_CONFIG_ID = Deno.env.get("META_CONFIG_ID") || "";
export const META_WEBHOOK_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") || "";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};
export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export const serviceClient = (): SupabaseClient =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
export type Any = any;
export interface GraphResult { ok: boolean; status: number; data: Any }

/** Call the Graph API. `token` is a business token (per customer) or an app token (`id|secret`). */
export async function graph(method: string, path: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<GraphResult> {
  const r = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !(body instanceof FormData) && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : body instanceof FormData || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
  const text = await r.text();
  let data: Any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

/** Human-readable Graph error. */
export const graphError = (res: GraphResult): string => {
  const e = res.data?.error;
  if (!e) return `Meta HTTP ${res.status}`;
  const details = e.error_data?.details ? ` ${e.error_data.details}` : "";
  const user = e.error_user_msg ? ` ${e.error_user_msg}` : "";
  return `${e.message || "Meta error"}${details}${user}${e.code ? ` (code ${e.code})` : ""}`;
};

/** Meta's token-invalid family (190 / 102) → the customer must reconnect. */
export const isAuthError = (res: GraphResult) => {
  const c = res.data?.error?.code;
  return res.status === 401 || c === 190 || c === 102;
};

/** Phone numbers from Meta arrive as digits without "+"; normalise to E.164. */
export const toE164 = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s;
  return /^\+\d{7,15}$/.test(s) ? s : null;
};
export const digitsOnly = (s: string | null | undefined) => (s || "").replace(/\D/g, "");

export interface AccountRow {
  user_id: string;
  enabled: boolean;
  phone_number: string | null;
  status: string;
  waba_id: string | null;
  phone_number_id: string | null;
  business_id: string | null;
  connected_phone_number: string | null;
  display_name: string | null;
  [k: string]: unknown;
}

export async function loadSecrets(admin: SupabaseClient, userId: string): Promise<{ access_token: string | null; pin: string | null }> {
  const { data } = await admin.from("whatsapp_secrets").select("access_token, pin").eq("user_id", userId).maybeSingle();
  return { access_token: data?.access_token ?? null, pin: data?.pin ?? null };
}

/** Map Meta's business profile object onto our whatsapp_accounts columns. */
export const profileToRow = (p: Any) => ({
  profile_photo_url: p?.profile_picture_url ?? null,
  about: p?.about ?? null,
  description: p?.description ?? null,
  category: p?.vertical ?? null,
  email: p?.email ?? null,
  website: Array.isArray(p?.websites) && p.websites.length ? String(p.websites[0]) : null,
  address: p?.address ?? null,
});

export const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";
export const PHONE_FIELDS = "verified_name,display_phone_number,quality_rating,code_verification_status,name_status,new_display_name,new_name_status,status";

/**
 * Download a Meta media id into the private storage bucket. Returns the storage path or null.
 * Meta's media URLs expire after 5 minutes, so we copy the bytes while the webhook is fresh.
 */
export async function copyMediaToStorage(
  admin: SupabaseClient, token: string, userId: string, mediaId: string, phoneNumberId: string, mime: string | null, fileHint: string,
): Promise<string | null> {
  try {
    const meta = await graph("GET", `/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`, token);
    const url: string | undefined = meta.ok ? meta.data?.url : undefined;
    if (!url) { console.warn("media url lookup failed", graphError(meta)); return null; }
    const bin = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!bin.ok) { console.warn("media download failed", bin.status); return null; }
    const bytes = new Uint8Array(await bin.arrayBuffer());
    const contentType = mime || bin.headers.get("content-type") || "application/octet-stream";
    const ext = extFromMime(contentType) || "bin";
    const path = `${userId}/${fileHint.replace(/[^A-Za-z0-9_.-]/g, "_")}.${ext}`;
    const { error } = await admin.storage.from("whatsapp-media").upload(path, bytes, { contentType, upsert: true });
    if (error) { console.warn("storage upload failed", error.message); return null; }
    return path;
  } catch (e) {
    console.warn("copyMediaToStorage error", e);
    return null;
  }
}

export const extFromMime = (mime: string): string | null => {
  const m = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/3gpp": "3gp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
    "application/pdf": "pdf", "text/plain": "txt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/msword": "doc", "application/vnd.ms-excel": "xls",
  };
  return map[m] || null;
};
