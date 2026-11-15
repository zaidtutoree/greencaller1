// Telnyx messaging webhook for the WhatsApp feature (public; deploy with --no-verify-jwt).
//
// Receives, on the shared "Greencaller WhatsApp" messaging profile:
//   message.received   type WHATSAPP → store inbound message + bump conversation
//                      type SMS      → capture Meta's phone verification code while a user is connecting
//   message.sent / message.finalized / message.read → update outbound delivery status
//   message.echo       (coexistence) ignored
//   whatsapp.waba_added → signup session finished; mark state so whatsapp-connect finalises
//
// Signature: if TELNYX_PUBLIC_KEY is set, telnyx-signature-ed25519 / telnyx-timestamp are verified
// (Ed25519 over `${timestamp}|${rawBody}`) and bad signatures are rejected. Without the secret the
// webhook is accepted unverified, matching the other Telnyx webhook functions in this project.
// Always answers 200 quickly; Telnyx retries non-2xx up to 3 times.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC_KEY_B64 = Deno.env.get("TELNYX_PUBLIC_KEY") || "";

const ok = (b: unknown = { received: true }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!PUBLIC_KEY_B64) return true;
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;
  try {
    const keyBytes = Uint8Array.from(atob(PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
    const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, new TextEncoder().encode(`${ts}|${raw}`));
  } catch (e) {
    console.error("signature verification error:", e);
    return false;
  }
}

// deno-lint-ignore no-explicit-any
type Any = any;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const e164 = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
};

/** Pull the business (our) number out of payload.to (string, object or array). */
const toNumber = (payload: Any): string | null => {
  const t = payload?.to;
  if (Array.isArray(t)) return e164(t[0]?.phone_number ?? t[0]);
  if (t && typeof t === "object") return e164(t.phone_number);
  return e164(t);
};
const fromNumber = (payload: Any): string | null =>
  e164(payload?.from?.phone_number ?? payload?.from ?? payload?.body?.from);

/** Normalise the many shapes a WhatsApp inbound body can take into one row. */
const extractContent = (payload: Any) => {
  const b: Any = payload?.body && typeof payload.body === "object" ? payload.body : {};
  const wm: Any = payload?.whatsapp_message && typeof payload.whatsapp_message === "object" ? payload.whatsapp_message : b;
  const type: string = str(wm.type) || str(b.type) || (str(payload?.text) ? "text" : "unknown");
  let text: string | null = null;
  let media_url: string | null = null;
  let media_mime: string | null = null;
  let media_id: string | null = null;

  switch (type) {
    case "text":
      text = str(wm.text?.body) ?? str(payload?.text) ?? str(b.text);
      break;
    case "image": case "video": case "audio": case "document": case "sticker": {
      const m: Any = wm[type] || {};
      media_url = str(m.url) ?? str(m.link);
      media_mime = str(m.mime_type);
      media_id = str(m.id);
      text = str(m.caption) ?? str(m.filename) ?? null;
      break;
    }
    case "location": {
      const l: Any = wm.location || {};
      text = [l.name, l.address, l.latitude != null ? `${l.latitude},${l.longitude}` : null].filter(Boolean).join(" · ") || "Location";
      break;
    }
    case "contacts": {
      const c: Any[] = Array.isArray(wm.contacts) ? wm.contacts : [];
      text = c.map((x) => x?.name?.formatted_name || x?.phones?.[0]?.phone).filter(Boolean).join(", ") || "Contact card";
      break;
    }
    case "interactive": {
      const i: Any = wm.interactive || {};
      text = str(i.button_reply?.title) ?? str(i.list_reply?.title) ?? str(i.nfm_reply?.body) ?? "Interactive reply";
      break;
    }
    case "button":
      text = str(wm.button?.text) ?? "Button reply";
      break;
    case "reaction":
      text = str(wm.reaction?.emoji) ? `Reacted ${wm.reaction.emoji}` : "Reaction";
      break;
    default:
      text = str(wm.text?.body) ?? str(payload?.text) ?? null;
  }
  // Media not pre-fetched by Telnyx: expose a stable download path the app can proxy later.
  if (!media_url && media_id) media_url = `telnyx-media:${media_id}`;

  const contact_name = str(wm.profile?.name) ?? str(b.profile?.name) ?? str(payload?.from?.name) ?? str(b.contacts?.[0]?.profile?.name);
  const foreign_id = str(wm.foreign_id) ?? str(b.foreign_id) ?? str(wm.id && String(wm.id).startsWith("wamid") ? wm.id : null);
  return { type, text, media_url, media_mime, contact_name, foreign_id };
};

serve(async (req) => {
  if (req.method !== "POST") return ok({ status: "ok" });
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    console.warn("telnyx-whatsapp-webhook: bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  let event: Any;
  try { event = JSON.parse(raw); } catch { return ok({ ignored: "not json" }); }
  const data: Any = event?.data || event;
  const eventType: string = data?.event_type || data?.record_type || "";
  const payload: Any = data?.payload || data;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // ── Signup finished ───────────────────────────────────────────────────
    if (eventType === "whatsapp.waba_added" || payload?.record_type === "waba_account_added") {
      const sessionId = str(payload?.event_id) ?? str(payload?.session_id);
      const status = str(payload?.status);
      if (sessionId) {
        const patch: Record<string, unknown> = { waba_id: str(payload?.waba_id), signup_state: status === "SUCCESS" ? "COMPLETE" : str(payload?.state) };
        if (status && status !== "SUCCESS") {
          patch.status = "failed";
          patch.last_error = Array.isArray(payload?.errors) && payload.errors.length ? payload.errors.join(" ") : `Signup ended with status ${status}.`;
        }
        const nums: Any[] = Array.isArray(payload?.phone_numbers) ? payload.phone_numbers : [];
        const first = nums[0];
        if (first) patch.phone_number_id = str(first.phone_number_id ?? first.id);
        await admin.from("whatsapp_accounts").update(patch).eq("signup_session_id", sessionId);
      }
      return ok();
    }

    // ── Delivery status for our outbound messages ─────────────────────────
    if (eventType === "message.sent" || eventType === "message.finalized" || eventType === "message.read") {
      const id = str(payload?.id);
      if (!id) return ok();
      let status: string | null = null;
      let error: string | null = null;
      if (eventType === "message.read") status = "read";
      else if (eventType === "message.sent") status = "sent";
      else {
        const s = str(payload?.to?.[0]?.status) || "";
        if (s === "delivered") status = "delivered";
        else if (/fail|undeliverable/.test(s)) {
          status = "failed";
          error = Array.isArray(payload?.errors) && payload.errors.length
            ? payload.errors.map((e: Any) => e.detail || e.title || e.code).join("; ")
            : s;
        } else if (s === "sent") status = "sent";
      }
      if (status) {
        // Never regress read → delivered → sent if webhooks arrive out of order.
        const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
        const { data: existing } = await admin.from("whatsapp_messages").select("id, status").eq("telnyx_message_id", id).maybeSingle();
        if (existing && (rank[status] >= (rank[existing.status] ?? 0) || status === "failed")) {
          await admin.from("whatsapp_messages").update({ status, error }).eq("id", existing.id);
        }
      }
      return ok();
    }

    if (eventType === "message.echo") return ok();

    // ── Inbound ───────────────────────────────────────────────────────────
    if (eventType === "message.received") {
      const business = toNumber(payload);
      const sender = fromNumber(payload);
      const kind = String(payload?.type || "").toUpperCase();
      if (!business || !sender) return ok({ ignored: "no numbers" });

      if (kind === "WHATSAPP") {
        const { data: account } = await admin
          .from("whatsapp_accounts")
          .select("user_id, enabled")
          .or(`connected_phone_number.eq.${business},phone_number.eq.${business}`)
          .eq("status", "connected")
          .maybeSingle();
        if (!account) return ok({ ignored: "no account for number" });

        const c = extractContent(payload);
        const telnyxId = str(payload?.id);
        const now = str(payload?.received_at) || new Date().toISOString();
        const preview = (c.text || (c.type !== "unknown" ? `[${c.type}]` : "Message")).slice(0, 160);

        // Conversation: create or bump. Keep an existing user-set name unless we have none.
        const { data: conv } = await admin.from("whatsapp_conversations")
          .select("id, contact_name, unread_count").eq("user_id", account.user_id).eq("contact_number", sender).maybeSingle();
        let convId: string;
        if (conv) {
          convId = conv.id;
          await admin.from("whatsapp_conversations").update({
            last_message_at: now, last_inbound_at: now, last_message_preview: preview,
            unread_count: (conv.unread_count || 0) + 1,
            ...(conv.contact_name ? {} : { contact_name: c.contact_name }),
          }).eq("id", convId);
        } else {
          const { data: created, error } = await admin.from("whatsapp_conversations").insert({
            user_id: account.user_id, contact_number: sender, contact_name: c.contact_name,
            last_message_at: now, last_inbound_at: now, last_message_preview: preview, unread_count: 1,
          }).select("id").single();
          if (error || !created) { console.error("conversation insert failed", error); return ok(); }
          convId = created.id;
        }

        const { error: insErr } = await admin.from("whatsapp_messages").insert({
          user_id: account.user_id,
          conversation_id: convId,
          direction: "inbound",
          telnyx_message_id: telnyxId,
          foreign_id: c.foreign_id,
          message_type: c.type,
          body: c.text,
          media_url: c.media_url,
          media_mime: c.media_mime,
          status: "received",
          raw: payload,
          created_at: now,
        });
        // 23505 = duplicate (Telnyx retried); that's fine.
        if (insErr && insErr.code !== "23505") console.error("message insert failed", insErr);
        return ok();
      }

      // SMS on a number that is mid-signup → almost certainly Meta's verification code.
      if (kind === "SMS" || kind === "MMS") {
        const text = str(payload?.text) || "";
        const m = text.match(/\b(\d{3})[-\s]?(\d{3})\b/);
        if (m) {
          await admin.from("whatsapp_accounts")
            .update({ last_otp_code: `${m[1]}-${m[2]}`, last_otp_at: new Date().toISOString() })
            .eq("phone_number", business)
            .eq("status", "connecting");
        }
        return ok();
      }
      return ok({ ignored: kind });
    }

    return ok({ ignored: eventType });
  } catch (e) {
    console.error("telnyx-whatsapp-webhook error:", e);
    return ok({ error: "logged" });
  }
});
