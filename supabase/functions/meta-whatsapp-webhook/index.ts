// Meta WhatsApp Cloud API webhook (public; deploy with --no-verify-jwt).
//
// GET  → subscription handshake: echoes hub.challenge when hub.verify_token matches.
// POST → entry[].changes[] for object "whatsapp_business_account":
//          field "messages"                  inbound messages + outbound status updates
//          field "phone_number_name_update"  display-name review result (re-registers on approval)
//          field "account_update"            logged only
// Signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). Rejected when
// META_APP_SECRET is set and the signature is missing/wrong. Always answers 200 otherwise; Meta
// retries non-2xx for up to 36 hours and may deliver duplicates (wamid unique index dedupes).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  serviceClient, graph, graphError, loadSecrets, copyMediaToStorage, toE164, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, Any,
} from "../_shared/meta-whatsapp.ts";

const ok = (b: unknown = { received: true }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!META_APP_SECRET) return true;
  const header = req.headers.get("x-hub-signature-256") || "";
  const expected = header.startsWith("sha256=") ? header.slice(7) : "";
  if (!expected) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Normalise an inbound Meta message object into our row shape. */
const extractContent = (m: Any) => {
  const type: string = str(m?.type) || "unknown";
  let text: string | null = null;
  let media_id: string | null = null;
  let media_mime: string | null = null;
  switch (type) {
    case "text": text = str(m.text?.body); break;
    case "image": case "video": case "audio": case "document": case "sticker": {
      const md: Any = m[type] || {};
      media_id = str(md.id); media_mime = str(md.mime_type);
      text = str(md.caption) ?? str(md.filename) ?? null;
      break;
    }
    case "location": {
      const l: Any = m.location || {};
      text = [l.name, l.address, l.latitude != null ? `${l.latitude},${l.longitude}` : null].filter(Boolean).join(" · ") || "Location";
      break;
    }
    case "contacts": {
      const c: Any[] = Array.isArray(m.contacts) ? m.contacts : [];
      text = c.map((x) => x?.name?.formatted_name || x?.phones?.[0]?.phone).filter(Boolean).join(", ") || "Contact card";
      break;
    }
    case "interactive": {
      const i: Any = m.interactive || {};
      text = str(i.button_reply?.title) ?? str(i.list_reply?.title) ?? str(i.nfm_reply?.body) ?? "Interactive reply";
      break;
    }
    case "button": text = str(m.button?.text) ?? "Button reply"; break;
    case "reaction": text = str(m.reaction?.emoji) ? `Reacted ${m.reaction.emoji}` : "Reaction"; break;
    case "order": text = "Order"; break;
    case "unsupported": text = str(m.errors?.[0]?.title) ?? "Unsupported message type"; break;
    default: text = str(m.text?.body) ?? null;
  }
  return { type, text, media_id, media_mime };
};

serve(async (req) => {
  const u = new URL(req.url);

  // ── Verification handshake ────────────────────────────────────────────
  if (req.method === "GET") {
    const mode = u.searchParams.get("hub.mode");
    const token = u.searchParams.get("hub.verify_token");
    const challenge = u.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && META_WEBHOOK_VERIFY_TOKEN && token === META_WEBHOOK_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return ok({ status: "ok" });

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    console.warn("meta-whatsapp-webhook: bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  let event: Any;
  try { event = JSON.parse(raw); } catch { return ok({ ignored: "not json" }); }
  if (event?.object !== "whatsapp_business_account") return ok({ ignored: event?.object });
  const admin = serviceClient();

  try {
    for (const entry of event.entry || []) {
      for (const change of entry.changes || []) {
        const field: string = change.field;
        const value: Any = change.value || {};

        if (field === "messages") {
          const phoneNumberId = str(value.metadata?.phone_number_id);
          if (!phoneNumberId) continue;
          const { data: account } = await admin
            .from("whatsapp_accounts").select("user_id, enabled, status").eq("phone_number_id", phoneNumberId).maybeSingle();
          if (!account) { console.warn("no account for phone_number_id", phoneNumberId); continue; }

          // ── Status updates for our outbound messages ──────────────────
          for (const s of value.statuses || []) {
            const wamid = str(s.id);
            const st = str(s.status);
            if (!wamid || !st) continue;
            const status = st === "failed" ? "failed" : ["sent", "delivered", "read"].includes(st) ? st : null;
            if (!status) continue;
            const error = status === "failed"
              ? (s.errors || []).map((e: Any) => [e.title, e.message, e.error_data?.details].filter(Boolean).join(": ") || `code ${e.code}`).join("; ") || "Delivery failed"
              : null;
            const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
            const { data: existing } = await admin.from("whatsapp_messages").select("id, status").eq("foreign_id", wamid).maybeSingle();
            if (existing && (status === "failed" || rank[status] >= (rank[existing.status] ?? 0))) {
              await admin.from("whatsapp_messages").update({ status, error }).eq("id", existing.id);
            }
          }

          // ── Inbound messages ──────────────────────────────────────────
          const contacts: Any[] = value.contacts || [];
          for (const m of value.messages || []) {
            const wamid = str(m.id);
            const sender = toE164(str(m.from));
            if (!sender) continue;
            const c = extractContent(m);
            const contactName = str(contacts.find((x) => x.wa_id === m.from)?.profile?.name) ?? str(contacts[0]?.profile?.name);
            const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
            const preview = (c.text || (c.type !== "unknown" ? `[${c.type}]` : "Message")).slice(0, 160);

            // Skip duplicates before doing any media work.
            if (wamid) {
              const { data: dup } = await admin.from("whatsapp_messages").select("id").eq("foreign_id", wamid).maybeSingle();
              if (dup) continue;
            }

            // Conversation: create or bump.
            const { data: conv } = await admin.from("whatsapp_conversations")
              .select("id, contact_name, unread_count").eq("user_id", account.user_id).eq("contact_number", sender).maybeSingle();
            let convId: string;
            if (conv) {
              convId = conv.id;
              await admin.from("whatsapp_conversations").update({
                last_message_at: at, last_inbound_at: at, last_message_preview: preview,
                unread_count: (conv.unread_count || 0) + 1,
                ...(conv.contact_name ? {} : { contact_name: contactName }),
              }).eq("id", convId);
            } else {
              const { data: created, error } = await admin.from("whatsapp_conversations").insert({
                user_id: account.user_id, contact_number: sender, contact_name: contactName,
                last_message_at: at, last_inbound_at: at, last_message_preview: preview, unread_count: 1,
              }).select("id").single();
              if (error || !created) { console.error("conversation insert failed", error); continue; }
              convId = created.id;
            }

            // Media: copy into our bucket now (Meta URLs expire in 5 minutes).
            let media_url: string | null = null;
            if (c.media_id) {
              const { access_token } = await loadSecrets(admin, account.user_id);
              const path = access_token
                ? await copyMediaToStorage(admin, access_token, account.user_id, c.media_id, phoneNumberId, c.media_mime, wamid || c.media_id)
                : null;
              media_url = path ? `storage:${path}` : `meta-media:${c.media_id}`;
            }

            const { error: insErr } = await admin.from("whatsapp_messages").insert({
              user_id: account.user_id, conversation_id: convId, direction: "inbound",
              foreign_id: wamid, message_type: c.type, body: c.text, media_url, media_mime: c.media_mime,
              status: "received", raw: m, created_at: at,
            });
            if (insErr && insErr.code !== "23505") console.error("message insert failed", insErr);
          }
          continue;
        }

        if (field === "phone_number_name_update") {
          // { display_phone_number, decision: APPROVED|REJECTED, requested_verified_name, rejection_reason }
          const digits = (str(value.display_phone_number) || "").replace(/\D/g, "");
          if (!digits) continue;
          const { data: accounts } = await admin.from("whatsapp_accounts").select("user_id, phone_number_id, connected_phone_number")
            .eq("status", "connected");
          const account = (accounts || []).find((a: Any) => (a.connected_phone_number || "").replace(/\D/g, "").endsWith(digits.slice(-9)));
          if (!account) continue;
          if (value.decision === "APPROVED") {
            await admin.from("whatsapp_accounts").update({ display_name: str(value.requested_verified_name), name_status: "APPROVED" }).eq("user_id", account.user_id);
            // Meta requires re-registering the number within 14 days of an approved name change.
            const { access_token, pin } = await loadSecrets(admin, account.user_id);
            if (access_token && pin && account.phone_number_id) {
              const reg = await graph("POST", `/${account.phone_number_id}/register`, access_token, { messaging_product: "whatsapp", pin });
              if (!reg.ok) console.warn("re-register after name approval failed", graphError(reg));
            }
          } else {
            await admin.from("whatsapp_accounts").update({
              name_status: str(value.decision) || "REJECTED",
              last_error: `Display name "${str(value.requested_verified_name) || ""}" was ${(value.decision || "rejected").toLowerCase()}${value.rejection_reason ? `: ${value.rejection_reason}` : ""}.`,
            }).eq("user_id", account.user_id);
          }
          continue;
        }

        if (field === "account_update") {
          console.log("account_update", JSON.stringify(value).slice(0, 500));
          continue;
        }
      }
    }
    return ok();
  } catch (e) {
    console.error("meta-whatsapp-webhook error:", e);
    return ok({ error: "logged" });
  }
});
