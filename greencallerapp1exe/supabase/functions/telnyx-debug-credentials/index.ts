import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type TelnyxListResponse<T> = { data?: T[]; meta?: any };

async function telnyxFetchJson(url: string, init: RequestInit) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  return { ok: resp.ok, status: resp.status, text, json };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get("TELNYX_API_KEY");
    if (!telnyxApiKey) throw new Error("TELNYX_API_KEY not configured");

    // Optional filter via query string
    const url = new URL(req.url);
    const connectionId = url.searchParams.get("connectionId");

    const headers = {
      Authorization: `Bearer ${telnyxApiKey}`,
      "Content-Type": "application/json",
    };

    // 1) Credential Connections
    const conns = await telnyxFetchJson("https://api.telnyx.com/v2/credential_connections?page[size]=100", {
      method: "GET",
      headers,
    });
    if (!conns.ok) {
      return new Response(JSON.stringify({ ok: false, step: "credential_connections", status: conns.status, error: conns.text }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const connections = ((conns.json as TelnyxListResponse<any>)?.data ?? []).map((c) => ({
      id: c.id,
      connection_name: c.connection_name,
      user_name: c.user_name,
      created_at: c.created_at,
      outbound_voice_profile_id: c?.outbound?.outbound_voice_profile_id ?? null,
    }));

    // 2) Telephony Credentials (these are the gencred... users)
    // Telnyx is paginated; we’ll fetch up to 500 for diagnostics.
    const credsAgg: any[] = [];
    let pageNumber = 1;
    const pageSize = 100;
    while (pageNumber <= 5) {
      const credsUrl = new URL("https://api.telnyx.com/v2/telephony_credentials");
      credsUrl.searchParams.set("page[number]", String(pageNumber));
      credsUrl.searchParams.set("page[size]", String(pageSize));

      const credsResp = await telnyxFetchJson(credsUrl.toString(), { method: "GET", headers });
      if (!credsResp.ok) break;
      const page = ((credsResp.json as TelnyxListResponse<any>)?.data ?? []) as any[];
      credsAgg.push(...page);
      if (page.length < pageSize) break;
      pageNumber++;
    }

    const getConnId = (c: any) =>
      c.connection_id ?? c.credential_connection_id ?? c.credential_connection?.id ?? c.credential_connection_id;

    const filteredCreds = connectionId ? credsAgg.filter((c) => getConnId(c) === connectionId) : credsAgg;

    const credentialsPreview = filteredCreds.slice(0, 25).map((c) => ({
      id: c.id,
      name: c.name,
      sip_username: c.sip_username,
      // Telnyx field name can vary; include all relevant candidates for debugging.
      connection_id: c.connection_id ?? null,
      credential_connection_id: c.credential_connection_id ?? null,
      credential_connection: c.credential_connection?.id ?? null,
      expires_at: c.expires_at,
      created_at: c.created_at,
    }));

    const sampleKeys = credsAgg[0] ? Object.keys(credsAgg[0]).sort() : [];

    const response = {
      ok: true,
      connectionIdFilter: connectionId,
      credentialConnections: {
        count: connections.length,
        items: connections,
      },
      telephonyCredentials: {
        fetched: credsAgg.length,
        matched: filteredCreds.length,
        sampleKeys,
        preview: credentialsPreview,
      },
    };

    return new Response(JSON.stringify(response, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
