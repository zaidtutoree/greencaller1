import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Verify if queued calls are still active by checking Telnyx API.
// For each call_sid, does GET /v2/calls/{callSid} — 404 means caller hung up.
// With checkOnly=true, returns abandoned list without updating DB.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { callSids, checkOnly } = await req.json();

    if (!callSids || !Array.isArray(callSids) || callSids.length === 0) {
      return new Response(
        JSON.stringify({ abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    if (!telnyxApiKey) {
      console.error('TELNYX_API_KEY not configured');
      return new Response(
        JSON.stringify({ abandoned: [], error: 'API key not configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const abandoned: string[] = [];

    // Check each call in parallel
    const checks = callSids.map(async (callSid: string) => {
      try {
        const resp = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callSid)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
          },
        });

        // 404 = call no longer exists = caller hung up
        if (resp.status === 404) {
          abandoned.push(callSid);
        }
      } catch (e) {
        console.error(`Error checking call ${callSid}:`, e);
      }
    });

    await Promise.all(checks);

    // If not checkOnly, update DB to mark abandoned
    if (!checkOnly && abandoned.length > 0) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

      for (const sid of abandoned) {
        await fetch(
          `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(sid)}&status=in.(waiting,ringing)`,
          {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ status: 'abandoned' }),
          }
        );
      }
    }

    return new Response(
      JSON.stringify({ abandoned }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in verify-queue-calls:', error);
    return new Response(
      JSON.stringify({ abandoned: [], error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
