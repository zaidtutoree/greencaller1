// Send a WhatsApp message from the signed-in user's connected number (JWT authed).
// Backend: Meta WhatsApp Cloud API, POST /{phone_number_id}/messages with the customer's token.
//
// Body: { to, text }                                       free-form text (24-hour window only)
//       { to, template: { name, language, params: [] } }   approved template (opens a window)
//       { to, media_url, caption?, media_type? }           image/document/video/audio by public URL
// Stores the outbound row + conversation so the UI shows it immediately; status webhooks
// (sent / delivered / read / failed) update it later via meta-whatsapp-webhook.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";
import { corsHeaders, json, serviceClient, graph, graphError, isAuthError, loadSecrets, toE164, Any } from "../_shared/meta-whatsapp.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = serviceClient();
    const { data: account } = await admin.from("whatsapp_accounts").select("*").eq("user_id", user.id).maybeSingle();
    if (!account?.enabled) return json({ error: "WhatsApp is not enabled for this account." }, 403);
    if (account.status !== "connected" || !account.phone_number_id) return json({ error: "WhatsApp is not connected yet." }, 400);
    const { access_token: token } = await loadSecrets(admin, user.id);
    if (!token) return json({ error: "WhatsApp connection is missing its access token. Reconnect from the WhatsApp tab." }, 400);

    const body = await req.json();
    const to = toE164(body.to || "");
    if (!to) return json({ error: "Enter the recipient in international format, e.g. +447700900123." }, 400);
    if (to === account.connected_phone_number) return json({ error: "You cannot message your own WhatsApp number." }, 400);

    let payload: Record<string, unknown>;
    let preview: string;
    let message_type = "text";
    let media_url: string | null = null;
    let media_mime: string | null = null;

    if (body.template?.name) {
      const t = body.template as { name: string; language?: string; params?: string[] };
      const params = Array.isArray(t.params) ? t.params.map((p) => String(p ?? "")) : [];
      payload = {
        type: "template",
        template: {
          name: t.name,
          language: { code: t.language || "en" },
          ...(params.length ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] } : {}),
        },
      };
      message_type = "template";
      preview = typeof body.preview === "string" && body.preview.trim() ? body.preview.trim() : `Template: ${t.name}`;
    } else if (typeof body.media_url === "string" && body.media_url.trim()) {
      media_url = body.media_url.trim();
      const kind = (body.media_type as string) || "image";
      if (!["image", "document", "video", "audio"].includes(kind)) return json({ error: "media_type must be image, document, video or audio" }, 400);
      message_type = kind;
      media_mime = typeof body.media_mime === "string" ? body.media_mime : null;
      const caption = typeof body.caption === "string" && body.caption.trim() ? body.caption.trim().slice(0, 1024) : undefined;
      payload = { type: kind, [kind]: { link: media_url, ...(caption && kind !== "audio" ? { caption } : {}) } };
      preview = caption || `[${kind}]`;
    } else {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "Message text is required." }, 400);
      if (text.length > 4096) return json({ error: "Message is too long (4096 character limit)." }, 400);
      payload = { type: "text", text: { body: text, preview_url: /https?:\/\//i.test(text) } };
      preview = text;
    }

    const r = await graph("POST", `/${account.phone_number_id}/messages`, token, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/^\+/, ""),
      ...payload,
    });
    if (!r.ok) {
      if (isAuthError(r)) {
        await admin.from("whatsapp_accounts").update({ status: "failed", last_error: "Meta revoked Greencaller's access. Reset and connect again." }).eq("user_id", user.id);
        return json({ error: "WhatsApp access was revoked. Reconnect from the WhatsApp tab." }, 401);
      }
      const code: number | undefined = r.data?.error?.code;
      const detail = graphError(r);
      // 131047 = re-engagement (outside 24 h window); 131026 = recipient not on WhatsApp / can't receive.
      const hint = code === 131047
        ? " More than 24 hours have passed since this person last messaged you, so WhatsApp only allows an approved template now."
        : code === 131026
          ? " This number may not be on WhatsApp, or the person hasn't accepted WhatsApp's latest terms."
          : code === 131030
            ? " Your WhatsApp account is still in test mode: add a payment method in WhatsApp Manager, or add this number to the allowed test recipients."
            : "";
      return json({ error: detail + hint }, 502);
    }

    const wamid: string | null = r.data?.messages?.[0]?.id || null;
    const now = new Date().toISOString();
    const { data: conv, error: convErr } = await admin
      .from("whatsapp_conversations")
      .upsert({ user_id: user.id, contact_number: to, last_message_at: now, last_message_preview: preview.slice(0, 160) }, { onConflict: "user_id,contact_number" })
      .select("*")
      .single();
    if (convErr || !conv) return json({ error: convErr?.message || "Could not store conversation" }, 500);

    const { data: msg, error: msgErr } = await admin
      .from("whatsapp_messages")
      .insert({
        user_id: user.id, conversation_id: conv.id, direction: "outbound", foreign_id: wamid,
        message_type, body: preview, media_url, media_mime, status: "queued", raw: r.data as Any,
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
