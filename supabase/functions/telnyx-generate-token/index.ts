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
    let body: { userId?: string } = {};
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
          error: "Invalid JSON body. Expected: { \"userId\": \"your-user-id\" }" 
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const userId = body.userId;

    console.log("Generating Telnyx SIP credentials for user:", userId);

    if (!userId) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Missing userId. Expected: { \"userId\": \"your-user-id\" }" 
        }), 
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
    const expiresAtISO = expiresAt.toISOString();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const storeRegistration = async (sipUsername: string) => {
      const { error: regError } = await supabase
        .from("telnyx_webrtc_registrations")
        .upsert(
          {
            user_id: userId,
            sip_username: sipUsername,
            expires_at: expiresAtISO,
          },
          { onConflict: "user_id" },
        );

      if (regError) {
        console.error("Error storing SIP registration:", regError);
      } else {
        console.log("Stored SIP registration for user:", userId, sipUsername);
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

    if (preferredConnectionId) {
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
    const credName = `lovable-user-${userId}-${Date.now()}`;
    console.log("Creating Telnyx telephony credential", { userId, connectionId, expiresAt: expiresAtISO });

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

    if (!sipUsername || !sipPassword) {
      console.error("Telnyx credential response missing username/password", credData);
      throw new Error("Failed to obtain Telnyx credentials");
    }

    await storeRegistration(sipUsername);

    return new Response(
      JSON.stringify({
        success: true,
        sipUsername,
        sipPassword,
        authType: "credentials",
        expiresAt: expiresAtISO,
        connectionId,
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
