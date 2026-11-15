// Admin management of the WhatsApp Business feature (admin-token authed, like admin-user).
//
// Actions:
//   readiness            → is the Telnyx account ready for hosted signup? (API key, Meta app linked,
//                          shared messaging profile + signup webhook configured)
//   setup                → create the shared "Greencaller WhatsApp" messaging profile (webhook =
//                          telnyx-whatsapp-webhook) and register the signup webhook with Telnyx
//   list                 → every whatsapp_accounts row + all users with their assigned numbers
//   enable  {userId, phoneNumber} → grant WhatsApp to a user on one of their Telnyx numbers
//   disable {userId}     → hide the tab (keeps connection data)
//   remove  {userId}     → delete the row entirely (does NOT deregister the number at Telnyx/Meta)
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_KEY = Deno.env.get("TELNYX_API_KEY") || "";
const META_APP_ID = Deno.env.get("TELNYX_WHATSAPP_APP_ID") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function validateAdminToken(token: string): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&select=expires_at`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return rows?.length > 0 && new Date(rows[0].expires_at) > new Date();
}

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

const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/telnyx-whatsapp-webhook`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const token = req.headers.get("x-admin-token");
    if (!token || !(await validateAdminToken(token))) return json({ error: "Invalid or expired admin token" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json();
    const action: string = body.action;

    const getConfig = async (): Promise<Record<string, string>> => {
      const { data } = await admin.from("whatsapp_config").select("key, value");
      return Object.fromEntries((data || []).map((r: { key: string; value: string | null }) => [r.key, r.value || ""]));
    };
    const setConfig = (key: string, value: string) =>
      admin.from("whatsapp_config").upsert({ key, value, updated_at: new Date().toISOString() });

    // ── readiness ─────────────────────────────────────────────────────────
    if (action === "readiness" || action === "setup") {
      const cfg = await getConfig();
      const out: Record<string, unknown> = {
        telnyx_key: !!TELNYX_KEY,
        app_id: META_APP_ID || null,
        app_linked: false,
        solution_id: null,
        messaging_profile_id: cfg.messaging_profile_id || null,
        signup_webhook_set: cfg.signup_webhook_set === "true",
        webhook_url: WEBHOOK_URL,
        errors: [] as string[],
      };
      const errors = out.errors as string[];
      if (!TELNYX_KEY) errors.push("TELNYX_API_KEY secret is not set in Supabase.");
      if (!META_APP_ID) errors.push("TELNYX_WHATSAPP_APP_ID secret is not set (your Meta Tech Provider App ID).");

      if (TELNYX_KEY) {
        const apps = await telnyx("GET", "/whatsapp/foreign_apps");
        if (apps.ok) {
          const list: Array<{ app_id?: string; solution_id?: string; enabled?: boolean }> = Array.isArray(apps.data?.data)
            ? apps.data.data
            : apps.data?.data ? [apps.data.data] : [];
          const match = list.find((a) => String(a.app_id) === META_APP_ID) || (META_APP_ID ? undefined : list[0]);
          out.foreign_apps = list;
          if (match) {
            out.app_linked = !!match.enabled && !!match.solution_id;
            out.solution_id = match.solution_id || null;
            if (!out.app_linked) errors.push("Meta app is linked but not enabled / has no solution_id yet. Ask Telnyx support to finish the link.");
          } else {
            errors.push("No Meta app linked to this Telnyx account. Send Telnyx support your Meta App ID to link it.");
          }
        } else {
          errors.push(`Could not read linked Meta apps: ${telnyxError(apps)}`);
        }

        if (action === "setup") {
          // 1. Shared messaging profile → inbound WhatsApp + OTP SMS land on our webhook.
          if (!cfg.messaging_profile_id) {
            const mp = await telnyx("POST", "/messaging_profiles", {
              name: "Greencaller WhatsApp",
              enabled: true,
              webhook_url: WEBHOOK_URL,
              webhook_api_version: "2",
            });
            if (mp.ok && mp.data?.data?.id) {
              await setConfig("messaging_profile_id", mp.data.data.id);
              out.messaging_profile_id = mp.data.data.id;
            } else {
              errors.push(`Could not create messaging profile: ${telnyxError(mp)}`);
            }
          } else {
            // Keep the webhook pointed at us even if someone changed it in the portal.
            await telnyx("PATCH", `/messaging_profiles/${cfg.messaging_profile_id}`, {
              webhook_url: WEBHOOK_URL,
              webhook_api_version: "2",
            });
          }
          // 2. Signup completion webhook (account-wide).
          const ud = await telnyx("PATCH", "/whatsapp/user_data", { webhook_url: WEBHOOK_URL });
          if (ud.ok) {
            await setConfig("signup_webhook_set", "true");
            out.signup_webhook_set = true;
          } else {
            errors.push(`Could not set signup webhook: ${telnyxError(ud)}`);
          }
        }
      }
      out.ready = !!TELNYX_KEY && !!META_APP_ID && out.app_linked === true && !!out.messaging_profile_id;
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
      // Never leak OTP codes to the admin list.
      const safe = (accounts || []).map((a: Record<string, unknown>) => ({ ...a, last_otp_code: undefined }));
      return json({ accounts: safe, users: users || [], numbers: numbers || [] });
    }

    // ── enable ────────────────────────────────────────────────────────────
    if (action === "enable") {
      const { userId, phoneNumber } = body as { userId?: string; phoneNumber?: string };
      if (!userId || !phoneNumber) return json({ error: "userId and phoneNumber are required" }, 400);
      const e164 = phoneNumber.replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(e164)) return json({ error: "phoneNumber must be in E.164 format (e.g. +447700900123)" }, 400);

      const cfg = await getConfig();
      const warnings: string[] = [];

      const { data: existing } = await admin.from("whatsapp_accounts").select("status, phone_number").eq("user_id", userId).maybeSingle();
      const numberChanged = existing && existing.phone_number && existing.phone_number !== e164;
      const row: Record<string, unknown> = {
        user_id: userId,
        enabled: true,
        phone_number: e164,
        messaging_profile_id: cfg.messaging_profile_id || null,
      };
      if (!existing || numberChanged) {
        // New grant or a different number → connection has to be redone.
        Object.assign(row, {
          status: "not_connected", signup_session_id: null, signup_url: null, signup_expires_at: null,
          signup_state: null, connected_phone_number: null, last_error: null, last_otp_code: null,
        });
      }
      const { error } = await admin.from("whatsapp_accounts").upsert(row, { onConflict: "user_id" });
      if (error) return json({ error: error.message }, 500);

      // Best effort: put the Telnyx number on our messaging profile so Meta's SMS verification
      // code is delivered to our webhook (shown to the user in the WhatsApp tab). Numbers that
      // aren't SMS-capable simply fall back to Meta's voice-call verification.
      if (TELNYX_KEY && cfg.messaging_profile_id) {
        const lookup = await telnyx("GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`);
        const pn = lookup.ok ? lookup.data?.data?.[0] : null;
        if (pn?.id) {
          const upd = await telnyx("PATCH", `/phone_numbers/${pn.id}/messaging`, { messaging_profile_id: cfg.messaging_profile_id });
          if (!upd.ok) warnings.push(`Number kept its current messaging setup (${telnyxError(upd)}). SMS codes may not show in-app; the user can choose a voice call instead.`);
        } else {
          warnings.push("Number not found in this Telnyx account; SMS verification codes will not be captured in-app.");
        }
      } else if (!cfg.messaging_profile_id) {
        warnings.push("Run Setup first so inbound WhatsApp messages have a webhook to land on.");
      }
      return json({ ok: true, warnings });
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
      const { error } = await admin.from("whatsapp_accounts").delete().eq("user_id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("admin-whatsapp error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
