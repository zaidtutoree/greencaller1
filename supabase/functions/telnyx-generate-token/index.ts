import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type TelnyxListResponse<T> = { data?: T[] };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get("TELNYX_API_KEY");

    if (!telnyxApiKey) {
      throw new Error("Telnyx API key not configured");
    }

    // Safely parse JSON body - handle empty or malformed requests
    let body: { userId?: string; deviceType?: string } = {};
    try {
      const text = await req.text();
      if (text && text.trim()) {
        body = JSON.parse(text);
      }
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid JSON body. Expected: { \"userId\": \"your-user-id\", \"deviceType\": \"web\" | \"mobile\" }"
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const userId = body.userId;
    // device_type defaults to 'web' to preserve existing web-app behaviour.
    // Mobile clients pass 'mobile' so the app gets a per-user mobile SIP
    // credential instead of the legacy shared TELNYX_SIP_USERNAME env var.
    const deviceType = body.deviceType === "mobile" ? "mobile" : "web";

    console.log("Generating Telnyx SIP credentials for user:", userId, "deviceType:", deviceType);

    if (!userId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing userId. Expected: { \"userId\": \"your-user-id\", \"deviceType\": \"web\" | \"mobile\" }"
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 30 days. Was 1 hour, which meant that one hour after the app last ran, the
    // credential was dead — telnyx-incoming-call then logged
    //   "Per-user mobile SIP credential is expired ... - skipping mobile endpoint"
    //   "No SIP endpoints available, routing to voicemail"
    // and inbound calls went straight to voicemail without ever dialling. The VoIP
    // wake push still woke the app (it re-minted ~2s later), but far too late: the
    // TeXML had already been returned. Verified live 2026-09-09 11:31.
    //
    // MUST STAY IN LOCKSTEP WITH CRED_CACHE_TTL_MS in lib/telnyxService.ts.
    // The app short-circuits on its local cache and only calls this function once
    // that cache lapses. If the cache expires BEFORE this value, a push-woken app
    // mints a new credential while telnyx-incoming-call is still dialling the old
    // one from the registrations row — the credential-rotation mismatch documented
    // in .claude/BACKGROUND_ANSWER_CONNECT.md §4, where the INVITE never reaches the
    // device. Keeping the two equal means both lapse together, so the app re-mints
    // on the next launch exactly when the row expires, and there is no window where
    // the dialled credential differs from the registered one.
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    const expiresAtISO = expiresAt.toISOString();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the existing row so we can DELETE the previous Telnyx credential
    // when we mint a new one (prevents the 1665-orphan accumulation we hit
    // before). We do NOT trust this row as a cache — multiple times we've
    // seen the row stay valid in the DB while the actual Telnyx credential
    // is gone (deleted by another path, by bulk cleanup, by Telnyx side),
    // and the app then fails SIP login with "Login failed. Please check
    // your credentials". Always minting fresh + deleting the previous is
    // the only reliable behaviour given how often the user-switch flow
    // exercises this code path. Cost: ~1s extra per app init — acceptable
    // for a calling app, and we still avoid accumulation because every
    // mint here is paired with a delete of the previous credential below.
    const { data: existing } = await supabase
      .from("telnyx_webrtc_registrations")
      .select("sip_username, sip_password, expires_at, telnyx_credential_id")
      .eq("user_id", userId)
      .eq("device_type", deviceType)
      .maybeSingle();

    console.log("Always-mint mode — existing row:", existing ? {
      sipUsername: existing.sip_username?.substring(0, 12) + "...",
      hasPassword: !!existing.sip_password,
      telnyxCredentialId: existing.telnyx_credential_id,
      expiresAt: existing.expires_at,
    } : "none");

    const storeRegistration = async (
      sipUsername: string,
      sipPassword: string,
      telnyxCredentialId: string | null,
    ) => {
      // Keyed by (user_id, device_type) so a single user can have one row
      // for web and a separate row for mobile. The 20260508 migration adds
      // the device_type column and the (user_id, device_type) unique key
      // that this onConflict targets.
      const { error: regError } = await supabase
        .from("telnyx_webrtc_registrations")
        .upsert(
          {
            user_id: userId,
            device_type: deviceType,
            sip_username: sipUsername,
            sip_password: sipPassword,
            expires_at: expiresAtISO,
            telnyx_credential_id: telnyxCredentialId,
          },
          { onConflict: "user_id,device_type" },
        );

      if (regError) {
        console.error("Error storing SIP registration:", regError);
      } else {
        console.log("Stored SIP registration for user:", userId, deviceType, sipUsername);
      }
    };

    const telnyxFetchJson = async (url: string, init: RequestInit) => {
      const resp = await fetch(url, init);
      const text = await resp.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // ignore
      }
      return { ok: resp.ok, status: resp.status, text, json };
    };

    // Helper to get or create an outbound voice profile
    const getOrCreateOutboundProfile = async (): Promise<string | null> => {
      const list = await telnyxFetchJson("https://api.telnyx.com/v2/outbound_voice_profiles", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (list.ok) {
        const first = list.json?.data?.[0];
        if (first?.id) {
          console.log("Found existing outbound voice profile:", first.id);
          return first.id;
        }
      }

      console.log("Creating new outbound voice profile...");
      const create = await telnyxFetchJson("https://api.telnyx.com/v2/outbound_voice_profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Lovable WebRTC Outbound Profile",
          traffic_type: "conversational",
          service_plan: "global",
        }),
      });

      if (create.ok) {
        const id = create.json?.data?.id;
        console.log("Created outbound voice profile:", id);
        return id || null;
      }

      console.error("Failed to create outbound voice profile", create.text);
      return null;
    };

    const patchCredentialConnectionOutbound = async (connectionId: string, outboundProfileId: string) => {
      // IMPORTANT: Telnyx expects outbound_voice_profile_id nested under `outbound`
      const patch = await telnyxFetchJson(`https://api.telnyx.com/v2/credential_connections/${connectionId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          outbound: {
            outbound_voice_profile_id: outboundProfileId,
          },
          sip_uri_calling_preference: "unrestricted",
        }),
      });

      if (!patch.ok) {
        console.error("Failed to patch credential connection with outbound profile:", patch.text);
        return false;
      }

      console.log("Patched credential connection with outbound_voice_profile_id:", outboundProfileId);
      return true;
    };

    // Step 1: Prefer an explicit connection id (prevents drifting to the wrong connection when multiple exist)
    const preferredConnectionId = Deno.env.get("TELNYX_CONNECTION_ID") || null;
    let connectionId: string | null = null;
    let connections: any[] = [];

    // Step 0 (desktop/web only): use a dedicated credential connection that
    // has a webhook URL. Telnyx only issues Call Control IDs — and only fires
    // call.initiated/answered/hangup — for calls on a connection with a
    // webhook; without one the WebRTC SDK gets telnyx_leg_id/session_id but
    // never telnyx_call_control_id, so record_start can't target the call
    // (Telnyx 90015). Mobile keeps the plain connection so its iOS
    // background-call flow is untouched. Override with TELNYX_WEB_CONNECTION_ID.
    if (deviceType === "web") {
      const WEB_CC_CONNECTION_NAME = "Greencaller Desktop (Call Control)";
      const webhookUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;
      const telnyxHeaders = {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      };

      const preferredWebId = Deno.env.get("TELNYX_WEB_CONNECTION_ID") || null;
      let webConn: any = null;

      if (preferredWebId) {
        const single = await telnyxFetchJson(`https://api.telnyx.com/v2/credential_connections/${preferredWebId}`, {
          method: "GET",
          headers: telnyxHeaders,
        });
        if (single.ok && single.json?.data?.id) {
          webConn = single.json.data;
        } else {
          console.warn("TELNYX_WEB_CONNECTION_ID invalid or not accessible; falling back to lookup by name.");
        }
      }

      if (!webConn) {
        const list = await telnyxFetchJson("https://api.telnyx.com/v2/credential_connections?page[size]=100", {
          method: "GET",
          headers: telnyxHeaders,
        });
        if (list.ok) {
          webConn = ((list.json as TelnyxListResponse<any>)?.data || []).find(
            (c: any) => c?.connection_name === WEB_CC_CONNECTION_NAME,
          ) || null;
        } else {
          console.error("Failed to list credential connections for web lookup:", list.text);
        }
      }

      if (!webConn) {
        console.log("Creating dedicated web credential connection with webhook:", WEB_CC_CONNECTION_NAME);
        const outboundProfileId = await getOrCreateOutboundProfile();
        const created = await telnyxFetchJson("https://api.telnyx.com/v2/credential_connections", {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({
            connection_name: WEB_CC_CONNECTION_NAME,
            user_name: `gcweb${Date.now()}`, // Telnyx: letters and numbers only
            password: crypto.randomUUID().replace(/-/g, "").substring(0, 24),
            sip_uri_calling_preference: "unrestricted",
            default_on_hold_comfort_noise_enabled: true,
            webhook_event_url: webhookUrl,
            webhook_event_failover_url: webhookUrl,
            webhook_api_version: "2",
            webhook_timeout_secs: 25,
            ...(outboundProfileId ? { outbound: { outbound_voice_profile_id: outboundProfileId } } : {}),
          }),
        });
        if (created.ok && created.json?.data?.id) {
          webConn = created.json.data;
          console.log("Created web credential connection:", webConn.id);
        } else {
          console.error("Failed to create web credential connection; falling back to shared connection:", created.text);
        }
      }

      if (webConn) {
        // Keep the webhook pointed at us and the outbound profile attached
        // (the profile is what lets the connection dial PSTN numbers).
        const fixes: Record<string, unknown> = {};
        if (webConn.webhook_event_url !== webhookUrl) fixes.webhook_event_url = webhookUrl;
        if (webConn.webhook_event_failover_url !== webhookUrl) fixes.webhook_event_failover_url = webhookUrl;
        if (webConn.webhook_api_version !== "2") fixes.webhook_api_version = "2";
        if (!webConn?.outbound?.outbound_voice_profile_id) {
          const outboundProfileId = await getOrCreateOutboundProfile();
          if (outboundProfileId) fixes.outbound = { outbound_voice_profile_id: outboundProfileId };
        }
        if (Object.keys(fixes).length > 0) {
          console.log("Patching web credential connection:", Object.keys(fixes));
          const patch = await telnyxFetchJson(`https://api.telnyx.com/v2/credential_connections/${webConn.id}`, {
            method: "PATCH",
            headers: telnyxHeaders,
            body: JSON.stringify(fixes),
          });
          if (!patch.ok) console.error("Failed to patch web credential connection:", patch.text);
        }
        connectionId = webConn.id;
        console.log("Using dedicated web credential connection:", connectionId);
      }
    }

    if (!connectionId && preferredConnectionId) {
      console.log("TELNYX_CONNECTION_ID provided; validating:", preferredConnectionId);
      const single = await telnyxFetchJson(`https://api.telnyx.com/v2/credential_connections/${preferredConnectionId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (single.ok && single.json?.data?.id) {
        const conn = single.json.data;
        connectionId = conn.id;
        console.log("Using preferred credential connection:", connectionId);

        const existingOutboundId = conn?.outbound?.outbound_voice_profile_id;
        if (!existingOutboundId) {
          console.log("Preferred credential connection missing outbound.outbound_voice_profile_id; patching...");
          const outboundProfileId = await getOrCreateOutboundProfile();
          if (outboundProfileId) {
            await patchCredentialConnectionOutbound(connectionId!, outboundProfileId);
          }
        }
      } else {
        console.warn("TELNYX_CONNECTION_ID invalid or not accessible; falling back to discovery.");
      }
    }

    // Fallback: discover existing credential connections
    if (!connectionId) {
      console.log("Discovering Telnyx credential connections...");
      const connectionsResp = await telnyxFetchJson("https://api.telnyx.com/v2/credential_connections", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (connectionsResp.ok) {
        connections = (connectionsResp.json as TelnyxListResponse<any>)?.data || [];
        console.log("Found credential connections:", connections.length);

        if (connections.length > 0) {
          const conn = connections[0];
          connectionId = conn.id;
          console.log("Using existing credential connection:", connectionId);

          // If outbound profile missing, patch the connection
          const existingOutboundId = conn?.outbound?.outbound_voice_profile_id;
          if (!existingOutboundId) {
            console.log("Credential connection missing outbound.outbound_voice_profile_id; patching...");
            const outboundProfileId = await getOrCreateOutboundProfile();
            if (outboundProfileId) {
              await patchCredentialConnectionOutbound(connectionId!, outboundProfileId);
            }
          }
        }
      } else {
        console.error("Failed to list credential connections:", connectionsResp.text);
      }
    }

    // Step 2: Create credential connection if none exist
    if (!connectionId) {
      console.log("No credential connection found; creating one...");

      const outboundProfileId = await getOrCreateOutboundProfile();

      const connUsername = `lovable_conn_${Date.now()}`;
      const connPassword = crypto.randomUUID().replace(/-/g, "").substring(0, 24);

      const createConn = await telnyxFetchJson("https://api.telnyx.com/v2/credential_connections", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connection_name: "Lovable WebRTC Connection",
          user_name: connUsername,
          password: connPassword,
          sip_uri_calling_preference: "unrestricted",
          default_on_hold_comfort_noise_enabled: true,
          ...(outboundProfileId
            ? {
                outbound: {
                  outbound_voice_profile_id: outboundProfileId,
                },
              }
            : {}),
        }),
      });

      if (!createConn.ok) {
        console.error("Failed to create Telnyx credential connection:", createConn.text);
        throw new Error("Failed to create Telnyx credential connection");
      }

      const connData = createConn.json;
      connectionId = connData?.data?.id || null;
      console.log("Created credential connection:", connectionId);
    }

    if (!connectionId) {
      throw new Error("Could not determine a valid Telnyx credential connection id");
    }

    // Step 3: Create short-lived telephony credentials for this user
    const credName = `gca-${deviceType}-${userId}-${Date.now()}`;
    console.log("Creating Telnyx telephony credential", { userId, deviceType, connectionId, expiresAt: expiresAtISO });

    const createCred = await telnyxFetchJson("https://api.telnyx.com/v2/telephony_credentials", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: credName,
        connection_id: connectionId,
        expires_at: expiresAtISO,
      }),
    });

    if (!createCred.ok) {
      console.error("Failed to create Telnyx telephony credential:", createCred.text);
      throw new Error("Failed to create Telnyx credentials");
    }

    const credData = createCred.json;
    const sipUsername = credData?.data?.sip_username;
    const sipPassword = credData?.data?.sip_password;
    const telnyxCredentialId = credData?.data?.id ?? null;

    if (!sipUsername || !sipPassword) {
      console.error("Telnyx credential response missing username/password", credData);
      throw new Error("Failed to obtain Telnyx credentials");
    }

    // Delete the previous Telnyx credential resource, if we have its id.
    // Without this we'd orphan a credential on Telnyx every time we mint
    // a fresh one — that's how the connection ballooned to 1665 expired
    // credentials and started failing SIP logins.
    if (existing?.telnyx_credential_id) {
      console.log("Deleting previous Telnyx credential:", existing.telnyx_credential_id);
      const del = await telnyxFetchJson(
        `https://api.telnyx.com/v2/telephony_credentials/${existing.telnyx_credential_id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${telnyxApiKey}` },
        },
      );
      if (!del.ok) {
        console.warn("Failed to delete previous Telnyx credential (continuing):", del.status, del.text);
      }
    }

    await storeRegistration(sipUsername, sipPassword, telnyxCredentialId);

    return new Response(
      JSON.stringify({
        success: true,
        sipUsername,
        sipPassword,
        authType: "credentials",
        deviceType,
        expiresAt: expiresAtISO,
        connectionId,
        cached: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error generating Telnyx credentials:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
