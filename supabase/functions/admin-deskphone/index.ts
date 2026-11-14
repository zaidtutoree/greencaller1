// Admin: provision / list / remove a physical desk phone (Yealink etc.) for a user.
//
// Each desk phone gets its OWN Telnyx credential connection so it can never
// collide with the apps' per-user WebRTC credentials (which is what broke calls
// when a Yealink was registered with the shared app credential). The
// connection carries a Call Control webhook (so telnyx-call-events can write
// call_history for calls made on the handset), the shared outbound voice
// profile, and a caller-ID override set to the user's assigned number.
//
// Guarded by the admin session token exactly like admin-assign-phone.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-token",
};

// The desktop Call Control connection; its outbound voice profile is reused.
const WEB_CC_CONNECTION_ID = "3053154786162509280";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function telnyx(apiKey: string, path: string, init: RequestInit = {}) {
  const resp = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) return json({ success: false, error: "Missing admin token" }, 401);
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("admin_sessions")
      .select("*, admin_users!inner(*)")
      .eq("token", adminToken)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (sessionError || !session) {
      return json({ success: false, error: "Invalid or expired admin session" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action;

    if (action === "list") {
      const q = supabaseAdmin
        .from("desk_phones")
        .select("id,user_id,phone_number_id,telnyx_connection_id,sip_username,sip_password,label,is_active,auto_record,created_at")
        .order("created_at", { ascending: false });
      const { data, error } = body.userId ? await q.eq("user_id", body.userId) : await q;
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, deskPhones: data ?? [] });
    }

    const telnyxApiKey = Deno.env.get("TELNYX_API_KEY");
    if (!telnyxApiKey) return json({ success: false, error: "TELNYX_API_KEY not configured" }, 500);

    if (action === "create") {
      const { userId, phoneId, label } = body as { userId?: string; phoneId?: string; label?: string };
      if (!userId || !phoneId) return json({ success: false, error: "Missing userId or phoneId" }, 400);

      const { data: phone } = await supabaseAdmin
        .from("phone_numbers")
        .select("id,phone_number,assigned_to,provider")
        .eq("id", phoneId)
        .maybeSingle();
      if (!phone) return json({ success: false, error: "Phone number not found" }, 404);
      if (phone.provider !== "telnyx") return json({ success: false, error: "Desk phones need a Telnyx number" }, 400);
      if (phone.assigned_to !== userId) {
        return json({ success: false, error: "That number is not assigned to this user" }, 400);
      }

      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("full_name,email")
        .eq("id", userId)
        .maybeSingle();
      const who = (profile?.full_name || profile?.email || userId).toString();
      const slug = who.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
      const connectionName = `Greencaller Desk - ${who}`.slice(0, 60);

      // Outbound profile: same one the desktop app's connection uses.
      const webConn = await telnyx(telnyxApiKey, `/credential_connections/${WEB_CC_CONNECTION_ID}`);
      const outboundProfileId = webConn.data?.data?.outbound?.outbound_voice_profile_id ?? null;

      const sipUser = `gcdesk${slug}${Date.now().toString(36)}`;
      const sipPass = crypto.randomUUID().replace(/-/g, "").slice(0, 24) + "Aa1";

      const created = await telnyx(telnyxApiKey, "/credential_connections", {
        method: "POST",
        body: JSON.stringify({
          connection_name: connectionName,
          active: true,
          user_name: sipUser,
          password: sipPass,
          webhook_event_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telnyx-call-events`,
          webhook_api_version: "2",
          // telnyx-incoming-call reaches the handset by dialling
          // sip:<credential>@sip.telnyx.com from our TeXML app. With this left
          // at its default (disabled) Telnyx answers every such leg with SIP
          // 403 and the phone never rings. "internal" = same-account only.
          sip_uri_calling_preference: "internal",
          outbound: {
            ...(outboundProfileId ? { outbound_voice_profile_id: outboundProfileId } : {}),
            ani_override: phone.phone_number,
            ani_override_type: "always",
            localization: "GB",
          },
          inbound: { codecs: ["G722", "G711U", "G711A"] },
        }),
      });
      if (!created.ok) {
        console.error("Telnyx connection create failed:", created.text);
        return json({ success: false, error: `Telnyx: ${created.data?.errors?.[0]?.detail || created.status}` }, 502);
      }
      const conn = created.data.data;

      // The handset must register with an ON-DEMAND telephony credential, not
      // the connection's own user_name. Telnyx only routes
      // `sip:<username>@sip.telnyx.com` (what telnyx-incoming-call puts in the
      // <Dial>) for telephony credentials; dialling a connection-level
      // user_name that way is rejected with SIP 403 (seen 2026-10-04, the
      // Yealink never rang inbound while outbound worked fine).
      const cred = await telnyx(telnyxApiKey, "/telephony_credentials", {
        method: "POST",
        body: JSON.stringify({ connection_id: String(conn.id), name: `desk-${slug}`, tag: "deskphone" }),
      });
      if (!cred.ok || !cred.data?.data?.sip_username) {
        console.error("Telnyx credential create failed:", cred.text);
        await telnyx(telnyxApiKey, `/credential_connections/${conn.id}`, { method: "DELETE" });
        return json({ success: false, error: `Telnyx credential: ${cred.data?.errors?.[0]?.detail || cred.status}` }, 502);
      }
      const credData = cred.data.data;

      const { data: row, error: insErr } = await supabaseAdmin
        .from("desk_phones")
        .insert({
          user_id: userId,
          phone_number_id: phone.id,
          telnyx_connection_id: String(conn.id),
          telnyx_credential_id: String(credData.id),
          sip_username: credData.sip_username,
          sip_password: credData.sip_password,
          label: label || "Desk phone",
        })
        .select()
        .single();
      if (insErr) {
        // Roll back the Telnyx object so we never leave an orphan connection.
        await telnyx(telnyxApiKey, `/credential_connections/${conn.id}`, { method: "DELETE" });
        return json({ success: false, error: insErr.message }, 500);
      }
      return json({ success: true, deskPhone: row });
    }

    if (action === "delete") {
      const { id } = body as { id?: string };
      if (!id) return json({ success: false, error: "Missing id" }, 400);
      const { data: row } = await supabaseAdmin
        .from("desk_phones")
        .select("id,telnyx_connection_id")
        .eq("id", id)
        .maybeSingle();
      if (!row) return json({ success: false, error: "Desk phone not found" }, 404);

      const del = await telnyx(telnyxApiKey, `/credential_connections/${row.telnyx_connection_id}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) {
        console.error("Telnyx connection delete failed:", del.text);
        return json({ success: false, error: `Telnyx: ${del.data?.errors?.[0]?.detail || del.status}` }, 502);
      }
      const { error: delErr } = await supabaseAdmin.from("desk_phones").delete().eq("id", id);
      if (delErr) return json({ success: false, error: delErr.message }, 500);
      return json({ success: true });
    }

    return json({ success: false, error: "Invalid action" }, 400);
  } catch (error: unknown) {
    console.error("admin-deskphone error:", error);
    return json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
