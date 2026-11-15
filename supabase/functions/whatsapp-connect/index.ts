// WhatsApp connection + business profile management for the signed-in user (JWT authed).
// Backend: Meta WhatsApp Cloud API. The customer's own Meta business owns the WABA; we hold
// the business token Embedded Signup gave us (whatsapp_secrets, service role only).
//
// Actions:
//   config          → public ids the browser needs to launch Embedded Signup (app id, config id)
//   status          → the user's whatsapp_accounts row (never includes tokens)
//   complete        → { code, waba_id, phone_number_id, business_id } from the popup →
//                     exchange code, subscribe webhooks, register number, verify it matches the
//                     assigned number, cache business profile → status connected
//   reset           → abandon a failed attempt (local state only)
//   profile         → fetch + cache the business profile from Meta
//   update-profile  → about / description / category / email / website / address, display_name
//   upload-photo    → { data_base64, content_type } → Resumable Upload → profile_picture_handle
//   templates       → approved message templates on the customer's WABA
//   media           → { message_id } → copy a not-yet-fetched inbound media into storage
//   mark-read       → { message_id (wamid) } → blue ticks for the customer
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";
import {
  corsHeaders, json, serviceClient, graph, graphError, isAuthError, loadSecrets, profileToRow, copyMediaToStorage,
  digitsOnly, GRAPH_VERSION, META_APP_ID, META_APP_SECRET, META_CONFIG_ID, PROFILE_FIELDS, PHONE_FIELDS, Any,
} from "../_shared/meta-whatsapp.ts";

const VERTICALS = new Set([
  "ALCOHOL", "APPAREL", "AUTO", "BEAUTY", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GOVT", "GROCERY", "HEALTH", "HOTEL",
  "NONPROFIT", "ONLINE_GAMBLING", "OTC_DRUGS", "OTHER", "PHYSICAL_GAMBLING", "PROF_SERVICES", "RESTAURANT", "RETAIL", "TRAVEL", "",
]);

// Strip server-only fields before handing the row to the browser.
const publicAccount = (a: Any) => {
  if (!a) return null;
  const { signup_session_id: _s, signup_url: _u, last_otp_code: _o, ...rest } = a;
  return rest;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = serviceClient();
    const body = await req.json();
    const action: string = body.action;

    if (action === "config") {
      return json({ app_id: META_APP_ID || null, config_id: META_CONFIG_ID || null, graph_version: GRAPH_VERSION, ready: !!(META_APP_ID && META_APP_SECRET && META_CONFIG_ID) });
    }

    const { data: account } = await admin.from("whatsapp_accounts").select("*").eq("user_id", user.id).maybeSingle();
    if (!account || !account.enabled) return json({ error: "WhatsApp is not enabled for this account." }, 403);

    const save = async (patch: Record<string, unknown>) => {
      const { data } = await admin.from("whatsapp_accounts").update(patch).eq("user_id", user.id).select("*").maybeSingle();
      return data || { ...account, ...patch };
    };

    if (action === "status") return json({ account: publicAccount(account) });

    if (action === "reset") {
      if (account.status === "connected") return json({ error: "Connected accounts can only be removed by an administrator." }, 400);
      await admin.from("whatsapp_secrets").delete().eq("user_id", user.id);
      const current = await save({ status: "not_connected", waba_id: null, phone_number_id: null, business_id: null, signup_state: null, last_error: null });
      return json({ account: publicAccount(current) });
    }

    // ── complete (Embedded Signup finished in the browser) ────────────────
    if (action === "complete") {
      if (!META_APP_ID || !META_APP_SECRET) return json({ error: "WhatsApp signup is not configured yet. Ask your administrator." }, 500);
      const { code, waba_id, phone_number_id, business_id } = body as { code?: string; waba_id?: string; phone_number_id?: string; business_id?: string };
      if (!code) return json({ error: "Missing signup code." }, 400);
      if (!waba_id || !phone_number_id) return json({ error: "Meta did not return your WhatsApp account ids. Please try connecting again." }, 400);
      if (!account.phone_number) return json({ error: "No number has been assigned for WhatsApp yet. Ask your administrator." }, 400);

      await save({ status: "connecting", signup_state: "EXCHANGE_TOKEN", last_error: null });

      // 1. Code → business token (code lives 30 s).
      const tok = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(META_APP_SECRET)}&code=${encodeURIComponent(code)}`,
      );
      const tokData: Any = await tok.json().catch(() => null);
      const token: string | undefined = tokData?.access_token;
      if (!tok.ok || !token) {
        const current = await save({ status: "failed", last_error: `Could not get access from Meta: ${tokData?.error?.message || `HTTP ${tok.status}`}. Please try again.` });
        return json({ account: publicAccount(current) });
      }
      await admin.from("whatsapp_secrets").upsert({ user_id: user.id, access_token: token, updated_at: new Date().toISOString() });

      // 2. Subscribe our app to the customer's WABA webhooks.
      await save({ signup_state: "SUBSCRIBE_WEBHOOKS", waba_id, phone_number_id, business_id: business_id || null });
      const sub = await graph("POST", `/${waba_id}/subscribed_apps`, token);
      if (!sub.ok) {
        const current = await save({ status: "failed", last_error: `Could not subscribe to your WhatsApp account: ${graphError(sub)}` });
        return json({ account: publicAccount(current) });
      }

      // 3. Check the registered number is the one we assigned.
      await save({ signup_state: "VERIFY_NUMBER" });
      const pn = await graph("GET", `/${phone_number_id}?fields=${PHONE_FIELDS}`, token);
      if (!pn.ok) {
        const current = await save({ status: "failed", last_error: `Could not read your phone number from Meta: ${graphError(pn)}` });
        return json({ account: publicAccount(current) });
      }
      const metaDigits = digitsOnly(pn.data?.display_phone_number);
      const wantDigits = digitsOnly(account.phone_number);
      if (metaDigits && wantDigits && !metaDigits.endsWith(wantDigits.slice(-9))) {
        const current = await save({
          status: "failed",
          last_error: `You registered +${metaDigits} but your Greencaller WhatsApp number is ${account.phone_number}. Reset and connect again using exactly that number.`,
        });
        return json({ account: publicAccount(current) });
      }

      // 4. Register the number for Cloud API with a two-step PIN we keep (needed to re-register later).
      await save({ signup_state: "REGISTER_PHONE_NUMBER" });
      const existing = await loadSecrets(admin, user.id);
      const pin = existing.pin && /^\d{6}$/.test(existing.pin) ? existing.pin : String(Math.floor(100000 + Math.random() * 900000));
      await admin.from("whatsapp_secrets").update({ pin }).eq("user_id", user.id);
      const reg = await graph("POST", `/${phone_number_id}/register`, token, { messaging_product: "whatsapp", pin });
      if (!reg.ok) {
        const msg = graphError(reg);
        // 133005 = two-step PIN mismatch (number previously registered with a different PIN).
        const hint = /133005|two.?step|pin/i.test(msg)
          ? " This number already has a two-step verification PIN. Turn off two-step verification for it in WhatsApp Manager, then reset and connect again."
          : "";
        const current = await save({ status: "failed", last_error: `Could not register the number with WhatsApp: ${msg}.${hint}` });
        return json({ account: publicAccount(current) });
      }

      // 5. Cache profile + finish.
      const prof = await graph("GET", `/${phone_number_id}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, token);
      const profile = prof.ok ? prof.data?.data?.[0] : null;
      const current = await save({
        status: "connected",
        connected_at: new Date().toISOString(),
        connected_phone_number: account.phone_number,
        display_name: pn.data?.verified_name || null,
        name_status: pn.data?.name_status || null,
        signup_state: "COMPLETE",
        last_error: null,
        ...(profile ? profileToRow(profile) : {}),
      });
      return json({ account: publicAccount(current) });
    }

    // ── everything below needs a connected number ─────────────────────────
    if (account.status !== "connected" || !account.phone_number_id) return json({ error: "WhatsApp is not connected yet." }, 400);
    const { access_token: token } = await loadSecrets(admin, user.id);
    if (!token) return json({ error: "Your WhatsApp connection has no access token. Ask your administrator to remove and re-enable WhatsApp, then connect again." }, 400);
    const pnid = account.phone_number_id as string;

    const authFail = async (res: Any) => {
      if (isAuthError(res)) {
        await save({ status: "failed", last_error: "Meta revoked Greencaller's access to your WhatsApp account. Reset and connect again." });
        return json({ error: "WhatsApp access was revoked. Reconnect from the WhatsApp tab." }, 401);
      }
      return json({ error: graphError(res) }, 502);
    };

    if (action === "profile") {
      const [prof, pn] = await Promise.all([
        graph("GET", `/${pnid}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, token),
        graph("GET", `/${pnid}?fields=${PHONE_FIELDS}`, token),
      ]);
      if (!prof.ok) return authFail(prof);
      const current = await save({
        ...profileToRow(prof.data?.data?.[0]),
        ...(pn.ok ? { display_name: pn.data?.verified_name || account.display_name, name_status: pn.data?.new_name_status || pn.data?.name_status || null } : {}),
      });
      return json({ account: publicAccount(current), pending_display_name: pn.ok ? pn.data?.new_display_name || null : null });
    }

    if (action === "update-profile") {
      const patch: Record<string, unknown> = { messaging_product: "whatsapp" };
      const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : undefined);
      const about = s("about"), description = s("description"), category = s("category"), email = s("email"), website = s("website"), address = s("address");
      if (about !== undefined) { if (about.length > 139) return json({ error: "About must be 139 characters or fewer." }, 400); if (about) patch.about = about; }
      if (description !== undefined) { if (description.length > 512) return json({ error: "Description must be 512 characters or fewer." }, 400); patch.description = description; }
      if (address !== undefined) { if (address.length > 256) return json({ error: "Address must be 256 characters or fewer." }, 400); patch.address = address; }
      if (email !== undefined) { if (email.length > 128) return json({ error: "Email must be 128 characters or fewer." }, 400); patch.email = email; }
      if (category !== undefined) { if (!VERTICALS.has(category)) return json({ error: "Unknown category." }, 400); patch.vertical = category; }
      if (website !== undefined) patch.websites = website ? [website.length > 256 ? website.slice(0, 256) : website] : [];

      const notes: string[] = [];
      if (Object.keys(patch).length > 1) {
        const r = await graph("POST", `/${pnid}/whatsapp_business_profile`, token, patch);
        if (!r.ok) return authFail(r);
      }

      // Display name changes go through Meta review; we submit and report the state.
      const displayName = s("display_name");
      if (displayName && displayName !== account.display_name) {
        const r = await graph("POST", `/${pnid}?new_display_name=${encodeURIComponent(displayName)}`, token, {});
        if (!r.ok) notes.push(`Display name not changed: ${graphError(r)}`);
        else notes.push(`Display name "${displayName}" submitted to Meta for review (${r.data?.new_name_status || "pending"}).`);
      }

      const prof = await graph("GET", `/${pnid}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, token);
      const current = await save(prof.ok ? profileToRow(prof.data?.data?.[0]) : {});
      return json({ account: publicAccount(current), notes });
    }

    if (action === "upload-photo") {
      const { data_base64, content_type } = body as { data_base64?: string; content_type?: string };
      if (!data_base64) return json({ error: "data_base64 is required" }, 400);
      const bytes = Uint8Array.from(atob(data_base64), (c) => c.charCodeAt(0));
      if (bytes.byteLength > 5 * 1024 * 1024) return json({ error: "Photo must be under 5 MB." }, 400);
      const mime = content_type === "image/png" ? "image/png" : "image/jpeg";

      // Resumable Upload API: open a session, push the bytes, get a handle, attach it to the profile.
      const open = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${META_APP_ID}/uploads?file_name=profile.${mime === "image/png" ? "png" : "jpg"}` +
        `&file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const openData: Any = await open.json().catch(() => null);
      const sessionId: string | undefined = openData?.id;
      if (!open.ok || !sessionId) return json({ error: `Could not start upload: ${openData?.error?.message || `HTTP ${open.status}`}` }, 502);

      const up = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      const upData: Any = await up.json().catch(() => null);
      const handle: string | undefined = upData?.h;
      if (!up.ok || !handle) return json({ error: `Could not upload photo: ${upData?.error?.message || `HTTP ${up.status}`}` }, 502);

      const set = await graph("POST", `/${pnid}/whatsapp_business_profile`, token, { messaging_product: "whatsapp", profile_picture_handle: handle });
      if (!set.ok) return authFail(set);
      const prof = await graph("GET", `/${pnid}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, token);
      const current = await save(prof.ok ? profileToRow(prof.data?.data?.[0]) : {});
      return json({ account: publicAccount(current) });
    }

    if (action === "templates") {
      const r = await graph("GET", `/${account.waba_id}/message_templates?fields=id,name,language,status,category,components&status=APPROVED&limit=100`, token);
      if (!r.ok) return authFail(r);
      const templates = (r.data?.data || []).map((t: Any) => {
        const comps: Any[] = t.components || [];
        const bodyComp = comps.find((c) => (c.type || "").toUpperCase() === "BODY");
        const paramCount = (bodyComp?.text?.match(/\{\{\d+\}\}/g) || []).length;
        return { id: t.id, name: t.name, language: t.language, category: t.category, status: t.status, body: bodyComp?.text || "", param_count: paramCount };
      });
      return json({ templates });
    }

    if (action === "media") {
      const { message_id } = body as { message_id?: string };
      if (!message_id) return json({ error: "message_id is required" }, 400);
      const { data: msg } = await admin.from("whatsapp_messages").select("id, media_url, media_mime, foreign_id").eq("id", message_id).eq("user_id", user.id).maybeSingle();
      if (!msg) return json({ error: "Message not found" }, 404);
      if (msg.media_url?.startsWith("storage:")) return json({ path: msg.media_url.slice("storage:".length) });
      const mediaId = msg.media_url?.startsWith("meta-media:") ? msg.media_url.slice("meta-media:".length) : null;
      if (!mediaId) return json({ error: "No media on this message" }, 400);
      const path = await copyMediaToStorage(admin, token, user.id, mediaId, pnid, msg.media_mime, msg.foreign_id || msg.id);
      if (!path) return json({ error: "Media is no longer available from WhatsApp." }, 410);
      await admin.from("whatsapp_messages").update({ media_url: `storage:${path}` }).eq("id", msg.id);
      return json({ path });
    }

    if (action === "mark-read") {
      const { message_id } = body as { message_id?: string };
      if (!message_id) return json({ error: "message_id is required" }, 400);
      const r = await graph("POST", `/${pnid}/messages`, token, { messaging_product: "whatsapp", status: "read", message_id });
      return json({ ok: r.ok });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("whatsapp-connect error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
