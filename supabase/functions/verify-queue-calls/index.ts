import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!telnyxApiKey) {
      throw new Error('TELNYX_API_KEY not configured');
    }

    const { callSids } = await req.json();

    if (!callSids || !Array.isArray(callSids) || callSids.length === 0) {
      return new Response(
        JSON.stringify({ success: true, abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const abandoned: string[] = [];

    // Check each call via Telnyx API
    for (const callSid of callSids) {
      try {
        const resp = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callSid)}`, {
          headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
        });

        if (!resp.ok) {
          // 404 or error means call no longer exists — it's abandoned
          console.log('Call not found (abandoned):', callSid, resp.status);
          abandoned.push(callSid);
        } else {
          const data = await resp.json();
          const isActive = data?.data?.is_alive;
          if (!isActive) {
            console.log('Call no longer alive:', callSid);
            abandoned.push(callSid);
          }
        }
      } catch (err) {
        console.error('Error checking call:', callSid, err);
        // On error, don't mark as abandoned — keep it in queue
      }
    }

    // Mark abandoned calls in the database
    if (abandoned.length > 0) {
      const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      };

      for (const callSid of abandoned) {
        await fetch(
          `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'abandoned' }),
          }
        );
      }
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
