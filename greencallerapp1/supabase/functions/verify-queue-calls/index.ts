import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Checks if queued calls are still active by querying Telnyx API.
// Tries multiple approaches: individual call lookup, and call events API.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!telnyxApiKey) throw new Error('TELNYX_API_KEY not configured');

    const { callSids, checkOnly = false } = await req.json();
    if (!callSids || !Array.isArray(callSids) || callSids.length === 0) {
      return new Response(
        JSON.stringify({ success: true, abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const dbHeaders = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };
    const telnyxHeaders = { 'Authorization': `Bearer ${telnyxApiKey}` };

    const abandoned: string[] = [];

    for (const callSid of callSids) {
      let isActive = false;

      // Approach 1: Try GET /v2/calls/{callSid} directly
      try {
        const resp = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callSid)}`, {
          headers: telnyxHeaders,
        });
        if (resp.ok) {
          const data = await resp.json();
          isActive = data?.data?.is_alive === true;
          console.log('Call lookup:', callSid, 'is_alive:', isActive);
        } else {
          // 404 = call doesn't exist anymore = hung up
          const status = resp.status;
          console.log('Call lookup:', callSid, 'status:', status);
          if (status === 404) {
            isActive = false;
          } else {
            // Other error — don't assume abandoned
            isActive = true;
          }
        }
      } catch (err) {
        console.error('Error checking call:', callSid, err);
        isActive = true; // On error, don't remove
      }

      if (!isActive) {
        abandoned.push(callSid);
      }
    }

    // Mark abandoned using service role key (bypasses RLS) — skip if checkOnly
    if (!checkOnly) {
      for (const callSid of abandoned) {
        await fetch(
          `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
          {
            method: 'PATCH',
            headers: { ...dbHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'abandoned' }),
          }
        );
      }
    }

    if (abandoned.length > 0) {
      console.log('Marked as abandoned:', abandoned);
    }

    return new Response(
      JSON.stringify({ success: true, abandoned }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
