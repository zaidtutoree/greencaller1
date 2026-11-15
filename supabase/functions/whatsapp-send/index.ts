// Send a WhatsApp message from the signed-in user's connected number (JWT authed).
//
// Body: { to, text }                                       free-form text (24-hour window only)
//       { to, template: { name, language, params: [] } }   approved template (opens a window)
//       { to, media_url, caption?, media_type? }           image/document/video by public URL
// Stores the outbound row + conversation so the UI shows it immediately; status webhooks
// (message.sent / finalized / read) update it later via telnyx-whatsapp-webhook.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TELNYX_KEY = Deno.env.get("TELNYX_API_KEY") || "";

/** Loose → E.164. Accepts "+44 7700 900123", "0044...", "447700900123". Leading 0 is left to the caller's UI. */
const toE164 = (raw: string): string | null => {
  let s = (raw || "").replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s;
  return /^\+\d{7,15}$/.test(s) ? s : null;
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
    if (!TELNYX_KEY) return json({ error: "TELNYX_API_KEY is not configured." }, 500);

    const admin = createClient(url, service);
    const { data: account } = await admin.from("whatsapp_accounts").select("*").eq("user_id", user.id).maybeSingle();
    if (!account?.enabled) return json({ error: "WhatsApp is not enabled for this account." }, 403);
    if (account.status !== "connected" || !account.connected_phone_number) return json({ error: "WhatsApp is not connected yet." }, 400);

    const body = await req.json();
    const to = toE164(body.to || "");
    if (!to) return json({ error: "Enter the recipient in international format, e.g. +447700900123." }, 400);
    if (to === account.connected_phone_number) return json({ error: "You cannot message your own WhatsApp number." }, 400);

    // Build the Telnyx whatsapp_message object.
    let whatsapp_message: Record<string, unknown>;
    let preview: string;
    let message_type = "text";
    let media_url: string | null = null;
    let media_mime: string | null = null;

    if (body.template?.name) {
      const t = body.template as { name: string; language?: string; params?: string[] };
      const params = Array.isArray(t.params) ? t.params.map((p) => String(p ?? "")) : [];
      whatsapp_message = {
        type: "template",
        template: {
          name: t.name,
          language: { policy: "deterministic", code: t.language || "en" },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] }
            : {}),
        },
      };
      message_type = "template";
      preview = typeof body.preview === "string" && body.preview.trim()
        ? body.preview.trim()
        : `Template: ${t.name}`;
    } else if (typeof body.media_url === "string" && body.media_url.trim()) {
      media_url = body.media_url.trim();
      const kind = (body.media_type as string) || "image";
      if (!["image", "document", "video", "audio"].includes(kind)) return json({ error: "media_type must be image, document, video or audio" }, 400);
      message_type = kind;
      media_mime = typeof body.media_mime === "string" ? body.media_mime : null;
      const caption = typeof body.caption === "string" && body.caption.trim() ? body.caption.trim().slice(0, 1024) : undefined;
      whatsapp_message = {
        type: kind,
        [kind]: { link: media_url, ...(caption && kind !== "audio" ? { caption } : {}) },
      };
      preview = caption || `[${kind}]`;
    } else {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "Message text is required." }, 400);
      if (new TextEncoder().encode(text).byteLength > 4096) return json({ error: "Message is too long (4096 byte limit)." }, 400);
      whatsapp_message = { type: "text", text: { body: text, preview_url: /https?:\/\//i.test(text) } };
      preview = text;
    }

    const r = await fetch("https://api.telnyx.com/v2/messages/whatsapp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        from: account.connected_phone_number,
        to,
        whatsapp_message,
        webhook_url: `${url}/functions/v1/telnyx-whatsapp-webhook`,
      }),
    });
    const text = await r.text();
    // deno-lint-ignore no-explicit-any
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!r.ok) {
      const detail: string = data?.errors?.map((e: { title?: string; detail?: string; code?: string }) =>
        `${e.detail || e.title || "Error"}${e.code ? ` (${e.code})` : ""}`).join("; ") || `Telnyx HTTP ${r.status}`;
      const windowHint = /24|window|template|re-?engage|not (?:allowed|permitted)/i.test(detail)
        ? " Free-form messages are only allowed within 24 hours of the customer's last message; send an approved template instead."
        : "";
      return json({ error: detail + windowHint }, 502);
    }

    const sent = data?.data || {};

    // Upsert conversation, then insert the message.
    const now = new Date().toISOString();
    const { data: conv, error: convErr } = await admin
      .from("whatsapp_conversations")
      .upsert(
        { user_id: user.id, contact_number: to, last_message_at: now, last_message_preview: preview.slice(0, 160) },
        { onConflict: "user_id,contact_number" },
      )
      .select("*")
      .single();
    if (convErr || !conv) return json({ error: convErr?.message || "Could not store conversation" }, 500);

    const { data: msg, error: msgErr } = await admin
      .from("whatsapp_messages")
      .insert({
        user_id: user.id,
        conversation_id: conv.id,
        direction: "outbound",
        telnyx_message_id: sent.id || null,
        message_type,
        body: preview,
        media_url,
        media_mime,
        status: "queued",
        raw: sent,
      })
      .select("*")
      .single();
    if (msgErr) return json({ error: msgErr.message }, 500);

    return json({ message: msg, conversation: conv });
  } catch (e) {
    console.error("whatsapp-send error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
