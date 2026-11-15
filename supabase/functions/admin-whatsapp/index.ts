// Admin management of the WhatsApp Business feature (admin-token authed, like admin-user).
// Backend: Meta WhatsApp Cloud API directly (no Telnyx involvement).
//
// Actions:
//   readiness            → are the Meta app secrets set, is the app reachable, is our webhook
//                          subscribed to whatsapp_business_account events?
//   setup                → subscribe the Meta app's webhook (callback = meta-whatsapp-webhook)
//   list                 → every whatsapp_accounts row + all users with their assigned numbers
//   enable  {userId, phoneNumber} → grant WhatsApp to a user on one of their numbers
//   disable {userId}     → hide the tab (keeps connection data)
//   remove  {userId}     → delete the row (+ token). Does NOT deregister the number at Meta.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  corsHeaders, json, serviceClient, graph, graphError, META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_WEBHOOK_VERIFY_TOKEN, Any,
} from "../_shared/meta-whatsapp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook`;
const APP_TOKEN = META_APP_ID && META_APP_SECRET ? `${META_APP_ID}|${META_APP_SECRET}` : "";
const WEBHOOK_FIELDS = ["messages", "account_update", "phone_number_name_update"];

async function validateAdminToken(token: string): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&select=expires_at`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return rows?.length > 0 && new Date(rows[0].expires_at) > new Date();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const token = req.headers.get("x-admin-token");
    if (!token || !(await validateAdminToken(token))) return json({ error: "Invalid or expired admin token" }, 401);

    const admin = serviceClient();
    const body = await req.json();
    const action: string = body.action;

    // ── readiness / setup ─────────────────────────────────────────────────
    if (action === "readiness" || action === "setup") {
      const errors: string[] = [];
      const out: Record<string, unknown> = {
        app_id: META_APP_ID || null,
        app_secret: !!META_APP_SECRET,
        config_id: META_CONFIG_ID || null,
        verify_token: !!META_WEBHOOK_VERIFY_TOKEN,
        app_name: null,
        webhook_subscribed: false,
        webhook_fields: [] as string[],
        webhook_url: WEBHOOK_URL,
        errors,
      };
      if (!META_APP_ID) errors.push("META_APP_ID secret is not set (Meta app dashboard → App ID).");
      if (!META_APP_SECRET) errors.push("META_APP_SECRET secret is not set (Meta app dashboard → App settings → Basic → App secret).");
      if (!META_CONFIG_ID) errors.push("META_CONFIG_ID secret is not set (Meta app → Facebook Login for Business → Configurations → Embedded Signup config ID).");
      if (!META_WEBHOOK_VERIFY_TOKEN) errors.push("META_WEBHOOK_VERIFY_TOKEN secret is not set (any random string; Meta echoes it when verifying the webhook).");

      if (APP_TOKEN) {
        const app = await graph("GET", `/${META_APP_ID}?fields=name,link`, APP_TOKEN);
        if (app.ok) out.app_name = app.data?.name || null;
        else errors.push(`Meta rejected the app credentials: ${graphError(app)}`);

        if (action === "setup") {
          if (!META_WEBHOOK_VERIFY_TOKEN) {
            errors.push("Cannot subscribe the webhook without META_WEBHOOK_VERIFY_TOKEN.");
          } else {
            // Meta calls GET <callback>?hub.challenge=… during this request, so the webhook
            // function must already be deployed.
            const sub = await graph("POST", `/${META_APP_ID}/subscriptions`, APP_TOKEN, {
              object: "whatsapp_business_account",
              callback_url: WEBHOOK_URL,
              verify_token: META_WEBHOOK_VERIFY_TOKEN,
              fields: WEBHOOK_FIELDS,
              include_values: true,
            });
            if (!sub.ok) errors.push(`Webhook subscription failed: ${graphError(sub)}. Is meta-whatsapp-webhook deployed?`);
          }
        }

        const subs = await graph("GET", `/${META_APP_ID}/subscriptions`, APP_TOKEN);
        if (subs.ok) {
          const wa = (subs.data?.data || []).find((s: Any) => s.object === "whatsapp_business_account");
          const fields: string[] = (wa?.fields || []).map((f: Any) => (typeof f === "string" ? f : f?.name)).filter(Boolean);
          out.webhook_fields = fields;
          out.webhook_callback = wa?.callback_url || null;
          out.webhook_subscribed = !!wa && wa.active !== false && fields.includes("messages") && (wa.callback_url || "").startsWith(WEBHOOK_URL);
          if (wa && !out.webhook_subscribed) {
            errors.push(`Webhook is subscribed but points at ${wa.callback_url || "another URL"} or lacks the "messages" field. Run setup.`);
          } else if (!wa) {
            errors.push("The app has no whatsapp_business_account webhook yet. Run setup.");
          }
        } else {
          errors.push(`Could not read webhook subscriptions: ${graphError(subs)}`);
        }
      }
      out.ready = !!META_APP_ID && !!META_APP_SECRET && !!META_CONFIG_ID && !!META_WEBHOOK_VERIFY_TOKEN && !!out.app_name && out.webhook_subscribed === true;
      return json(out);
    }

    // ── list ──────────────────────────────────────────────────────────────
    if (action === "list") {
      const [{ data: accounts, error: e1 }, { data: users, error: e2 }, { data: numbers, error: e3 }] = await Promise.all([
        admin.from("whatsapp_accounts").select("*, profiles:user_id(id, full_name, email, company_name, account_type)").order("created_at", { ascending: false }),
        admin.from("profiles").select("id, full_name, email, company_name, account_type").order("full_name", { ascending: true }),
        admin.from("phone_numbers").select("phone_number, assigned_to, provider, is_active").not("assigned_to", "is", null),
      ]);
      if (e1 || e2 || e3) return json({ error: (e1 || e2 || e3)!.message }, 500);
      return json({ accounts: accounts || [], users: users || [], numbers: numbers || [] });
    }

    // ── enable ────────────────────────────────────────────────────────────
    if (action === "enable") {
      const { userId, phoneNumber } = body as { userId?: string; phoneNumber?: string };
      if (!userId || !phoneNumber) return json({ error: "userId and phoneNumber are required" }, 400);
      const e164 = phoneNumber.replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(e164)) return json({ error: "phoneNumber must be in E.164 format (e.g. +447700900123)" }, 400);

      const { data: existing } = await admin.from("whatsapp_accounts").select("status, phone_number").eq("user_id", userId).maybeSingle();
      const numberChanged = existing && existing.phone_number && existing.phone_number !== e164;
      const row: Record<string, unknown> = { user_id: userId, enabled: true, phone_number: e164 };
      if (!existing || numberChanged) {
        Object.assign(row, {
          status: "not_connected", waba_id: null, phone_number_id: null, business_id: null,
          connected_phone_number: null, last_error: null, signup_state: null,
        });
      }
      const { error } = await admin.from("whatsapp_accounts").upsert(row, { onConflict: "user_id" });
      if (error) return json({ error: error.message }, 500);
      if (numberChanged) await admin.from("whatsapp_secrets").delete().eq("user_id", userId);
      return json({ ok: true, warnings: [] });
    }

    if (action === "disable") {
      const { userId } = body as { userId?: string };
      if (!userId) return json({ error: "userId is required" }, 400);
      const { error } = await admin.from("whatsapp_accounts").update({ enabled: false }).eq("user_id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "remove") {
      const { userId } = body as { userId?: string };
      if (!userId) return json({ error: "userId is required" }, 400);
      const { error } = await admin.from("whatsapp_accounts").delete().eq("user_id", userId); // secrets cascade
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("admin-whatsapp error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
