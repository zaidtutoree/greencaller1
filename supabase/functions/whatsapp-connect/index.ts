// WhatsApp connection + business profile management for the signed-in user (JWT authed).
//
// Actions:
//   status          → the user's whatsapp_accounts row; while "connecting" it polls Telnyx's signup
//                     session and finalises the connection when Meta/Telnyx report SUCCESS
//   start           → create a Telnyx hosted-signup link (Meta Embedded Signup) and return its URL
//   reset           → abandon a failed/stale signup attempt (local state only)
//   profile         → fetch the WhatsApp business profile from Telnyx (and cache it)
//   update-profile  → PATCH about / description / category / email / website / address / display_name
//   upload-photo    → { data_base64, content_type } → multipart upload to Telnyx
//   delete-photo
//   templates       → approved message templates (needed to message outside the 24-hour window)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TELNYX_KEY = Deno.env.get("TELNYX_API_KEY") || "";
const META_APP_ID = Deno.env.get("TELNYX_WHATSAPP_APP_ID") || "";

// deno-lint-ignore no-explicit-any
async function telnyx(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`https://api.telnyx.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${TELNYX_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}
// deno-lint-ignore no-explicit-any
const telnyxError = (res: { data: any; status: number }) =>
  res.data?.errors?.map((e: { title?: string; detail?: string }) => e.detail || e.title).join("; ") || `Telnyx HTTP ${res.status}`;

const PROFILE_FIELDS = ["display_name", "about", "description", "category", "email", "website", "address"] as const;

// deno-lint-ignore no-explicit-any
const profileToRow = (p: any) => ({
  display_name: p?.display_name ?? null,
  profile_photo_url: p?.profile_photo_url ?? null,
  about: p?.about ?? null,
  description: p?.description ?? null,
  category: p?.category ?? null,
  email: p?.email ?? null,
  website: p?.website ?? null,
  address: p?.address ?? null,
});

// Strip server-only fields before handing the row to the browser.
// deno-lint-ignore no-explicit-any
const publicAccount = (a: any) => {
  if (!a) return null;
  const { signup_session_id: _s, ...rest } = a;
  return rest;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(url, service);
    const body = await req.json();
    const action: string = body.action;

    const { data: account } = await admin.from("whatsapp_accounts").select("*").eq("user_id", user.id).maybeSingle();
    if (!account || !account.enabled) return json({ error: "WhatsApp is not enabled for this account." }, 403);
    if (!TELNYX_KEY) return json({ error: "TELNYX_API_KEY is not configured." }, 500);

    const save = async (patch: Record<string, unknown>) => {
      const { data } = await admin.from("whatsapp_accounts").update(patch).eq("user_id", user.id).select("*").maybeSingle();
      return data || { ...account, ...patch };
    };

    // Called once Telnyx says the signup session succeeded: confirm the assigned number is now a
    // WhatsApp number, point its inbound traffic at our messaging profile, cache the profile.
    const finalize = async (wabaId: string | null) => {
      const num = account.phone_number as string;
      const pn = await telnyx("GET", `/whatsapp/phone_numbers/${encodeURIComponent(num)}`);
      if (!pn.ok) {
        return save({
          status: "failed",
          waba_id: wabaId,
          signup_state: "COMPLETE",
          last_error:
            `Signup finished but ${num} is not registered on the WhatsApp account. ` +
            `Make sure you entered exactly this number in the Meta signup window, then reset and try again.`,
        });
      }
      const d = pn.data?.data || {};
      if (account.messaging_profile_id) {
        const pr = await telnyx("PATCH", `/whatsapp/phone_numbers/${encodeURIComponent(num)}/profile`, { profile_id: account.messaging_profile_id });
        if (!pr.ok) console.warn("profile_id assignment failed:", telnyxError(pr));
      }
      const prof = await telnyx("GET", `/whatsapp/phone_numbers/${encodeURIComponent(num)}/profile`);
      return save({
        status: "connected",
        connected_at: new Date().toISOString(),
        waba_id: wabaId || d.waba_id || account.waba_id,
        phone_number_id: d.phone_number_id || d.id || account.phone_number_id,
        connected_phone_number: num,
        signup_state: "COMPLETE",
        last_error: null,
        last_otp_code: null,
        ...(prof.ok ? profileToRow(prof.data?.data) : {}),
      });
    };

    // ── status ────────────────────────────────────────────────────────────
    if (action === "status") {
      let current = account;
      if (account.status === "connecting" && account.signup_session_id) {
        const st = await telnyx("GET", `/whatsapp/signup/${encodeURIComponent(account.signup_session_id)}/status`);
        if (st.ok) {
          const s = st.data?.data || {};
          if (s.status === "SUCCESS") {
            current = await finalize(s.waba_id || null);
          } else if (s.status === "FAILURE") {
            current = await save({
              status: "failed",
              signup_state: s.state || null,
              waba_id: s.waba_id || account.waba_id,
              last_error: (Array.isArray(s.errors) && s.errors.length ? s.errors.join(" ") : `Signup failed at step ${s.state || "unknown"}.`),
            });
          } else if (s.state && s.state !== account.signup_state) {
            current = await save({ signup_state: s.state, waba_id: s.waba_id || account.waba_id });
          }
        } else if (account.signup_expires_at && new Date(account.signup_expires_at) < new Date()) {
          current = await save({ status: "failed", last_error: "The signup link expired before the connection finished. Start again." });
        }
      }
      return json({ account: publicAccount(current) });
    }

    // ── start ─────────────────────────────────────────────────────────────
    if (action === "start") {
      if (account.status === "connected") return json({ error: "Already connected." }, 400);
      if (!account.phone_number) return json({ error: "No Telnyx number has been assigned for WhatsApp yet. Ask your administrator." }, 400);
      if (!META_APP_ID) return json({ error: "WhatsApp signup is not configured yet (missing Meta app). Ask your administrator." }, 500);

      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const hs = await telnyx("POST", "/whatsapp/hosted_signups", {
        app_id: META_APP_ID,
        expires_at: expires.toISOString(),
        signup_type: "standard",
      });
      if (!hs.ok) return json({ error: `Could not create signup link: ${telnyxError(hs)}` }, 502);
      const d = hs.data?.data || {};
      const current = await save({
        status: "connecting",
        signup_session_id: d.id,
        signup_url: d.url,
        signup_expires_at: d.expires_at || expires.toISOString(),
        signup_state: null,
        last_error: null,
        last_otp_code: null,
        last_otp_at: null,
      });
      return json({ url: d.url, account: publicAccount(current) });
    }

    if (action === "reset") {
      if (account.status === "connected") return json({ error: "Connected accounts can only be removed by an administrator." }, 400);
      const current = await save({
        status: "not_connected", signup_session_id: null, signup_url: null, signup_expires_at: null,
        signup_state: null, last_error: null, last_otp_code: null, last_otp_at: null,
      });
      return json({ account: publicAccount(current) });
    }

    // ── everything below needs a connected number ─────────────────────────
    if (account.status !== "connected" || !account.connected_phone_number) {
      return json({ error: "WhatsApp is not connected yet." }, 400);
    }
    const num = encodeURIComponent(account.connected_phone_number);

    if (action === "profile") {
      const prof = await telnyx("GET", `/whatsapp/phone_numbers/${num}/profile`);
      if (!prof.ok) return json({ error: telnyxError(prof) }, 502);
      const current = await save(profileToRow(prof.data?.data));
      return json({ account: publicAccount(current) });
    }

    if (action === "update-profile") {
      const patch: Record<string, string> = {};
      for (const f of PROFILE_FIELDS) {
        if (typeof body[f] === "string") patch[f] = body[f].trim();
      }
      if (patch.about && patch.about.length > 139) return json({ error: "About must be 139 characters or fewer." }, 400);
      if (patch.description && patch.description.length > 512) return json({ error: "Description must be 512 characters or fewer." }, 400);
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update." }, 400);
      const r = await telnyx("PATCH", `/whatsapp/phone_numbers/${num}/profile`, patch);
      if (!r.ok) return json({ error: telnyxError(r) }, 502);
      const current = await save(profileToRow({ ...account, ...patch, ...(r.data?.data || {}) }));
      return json({ account: publicAccount(current) });
    }

    if (action === "upload-photo") {
      const { data_base64, content_type } = body as { data_base64?: string; content_type?: string };
      if (!data_base64) return json({ error: "data_base64 is required" }, 400);
      const bytes = Uint8Array.from(atob(data_base64), (c) => c.charCodeAt(0));
      if (bytes.byteLength > 10 * 1024 * 1024) return json({ error: "Photo must be under 10 MB." }, 400);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: content_type || "image/jpeg" }), "profile.jpg");
      const r = await fetch(`https://api.telnyx.com/v2/whatsapp/phone_numbers/${num}/profile/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_KEY}`, Accept: "application/json" },
        body: form,
      });
      const text = await r.text();
      // deno-lint-ignore no-explicit-any
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!r.ok) return json({ error: telnyxError({ data, status: r.status }) }, 502);
      // Re-read so profile_photo_url is fresh even if the upload response omits it.
      const prof = await telnyx("GET", `/whatsapp/phone_numbers/${num}/profile`);
      const current = await save(profileToRow(prof.ok ? prof.data?.data : data?.data));
      return json({ account: publicAccount(current) });
    }

    if (action === "delete-photo") {
      const r = await telnyx("DELETE", `/whatsapp/phone_numbers/${num}/profile/photo`);
      if (!r.ok && r.status !== 404) return json({ error: telnyxError(r) }, 502);
      const current = await save({ profile_photo_url: null });
      return json({ account: publicAccount(current) });
    }

    if (action === "templates") {
      const r = await telnyx("GET", "/whatsapp/message_templates?filter[status]=APPROVED&page[size]=100");
      if (!r.ok) return json({ error: telnyxError(r) }, 502);
      const all: Array<Record<string, unknown>> = r.data?.data || [];
      // Keep only templates that belong to this user's WABA when the API tells us which.
      const mine = all.filter((t) => !t.waba_id || !account.waba_id || String(t.waba_id) === String(account.waba_id));
      const templates = mine.map((t) => {
        const comps = (t.components as Array<{ type?: string; text?: string; format?: string }>) || [];
        const bodyComp = comps.find((c) => (c.type || "").toUpperCase() === "BODY");
        const paramCount = (bodyComp?.text?.match(/\{\{\d+\}\}/g) || []).length;
        return {
          id: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          body: bodyComp?.text || "",
          param_count: paramCount,
        };
      });
      return json({ templates });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("whatsapp-connect error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
