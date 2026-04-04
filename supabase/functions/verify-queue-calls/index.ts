import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Checks queued calls and marks stale ones as abandoned.
// The hold music loop updates updated_at on each iteration (~33 seconds).
// If updated_at hasn't been refreshed in 45 seconds, the caller has hung up.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const { callSids } = await req.json();
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

    // Fetch queue entries with their timestamps
    const queueResp = await fetch(
      `${supabaseUrl}/rest/v1/call_queue?call_sid=in.(${callSids.map(s => `"${s}"`).join(',')})&select=call_sid,updated_at,created_at,status&status=in.(waiting,ringing)`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (!queueResp.ok) {
      console.error('Failed to fetch queue entries:', await queueResp.text());
      return new Response(
        JSON.stringify({ success: true, abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const entries = await queueResp.json();
    const now = Date.now();
    const staleMs = 45 * 1000; // 45 seconds — hold music loops every ~33s
    const abandoned: string[] = [];

    for (const entry of entries) {
      const lastUpdate = new Date(entry.updated_at || entry.created_at).getTime();
      const entryAge = now - new Date(entry.created_at).getTime();
      const heartbeatAge = now - lastUpdate;

      // Only check entries older than 45 seconds (give new entries time for first heartbeat)
      if (entryAge > staleMs && heartbeatAge > staleMs) {
        abandoned.push(entry.call_sid);
      }
    }

    // Mark abandoned using service role key (bypasses RLS)
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

    if (abandoned.length > 0) {
      console.log('Marked as abandoned (stale heartbeat):', abandoned);
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
