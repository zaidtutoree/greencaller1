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

    if (!telnyxApiKey) throw new Error('TELNYX_API_KEY not configured');

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

    // Get all active calls from Telnyx and build a set of all active phone numbers
    const activeNumbers = new Set<string>();
    const activeIds = new Set<string>();

    try {
      // Fetch active calls - try with pagination
      const resp = await fetch('https://api.telnyx.com/v2/calls?page[size]=250', {
        headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
      });

      if (resp.ok) {
        const data = await resp.json();
        const calls = data?.data || [];
        console.log('Telnyx active calls:', calls.length);

        for (const call of calls) {
          // Track all identifiers
          if (call.call_control_id) activeIds.add(call.call_control_id);
          if (call.call_session_id) activeIds.add(call.call_session_id);
          if (call.call_leg_id) activeIds.add(call.call_leg_id);

          // Normalize and track phone numbers
          const normalize = (n: string) => n?.replace(/[^0-9]/g, '') || '';
          if (call.from) {
            activeNumbers.add(normalize(call.from));
          }
          if (call.to) {
            activeNumbers.add(normalize(call.to));
          }
        }
        console.log('Active numbers:', [...activeNumbers].slice(0, 10), 'Active IDs:', activeIds.size);
      } else {
        const errText = await resp.text();
        console.error('Failed to fetch active calls:', resp.status, errText);
        return new Response(
          JSON.stringify({ success: true, abandoned: [] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } catch (err) {
      console.error('Error fetching active calls:', err);
      return new Response(
        JSON.stringify({ success: true, abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get queue entries with their phone numbers
    const queueResp = await fetch(
      `${supabaseUrl}/rest/v1/call_queue?call_sid=in.(${callSids.map(s => `"${s}"`).join(',')})&select=call_sid,from_number,to_number&status=in.(waiting,ringing)`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    const queueEntries = queueResp.ok ? await queueResp.json() : [];
    const abandoned: string[] = [];
    const normalize = (n: string) => n?.replace(/[^0-9]/g, '') || '';

    for (const entry of queueEntries) {
      const fromNorm = normalize(entry.from_number);

      // Check if the caller's number appears in any active call
      const callerActive = activeNumbers.has(fromNorm);
      // Also check if the call_sid matches any active call identifier
      const sidActive = activeIds.has(entry.call_sid);

      console.log('Queue entry check:', {
        callSid: entry.call_sid,
        from: entry.from_number,
        fromNorm,
        callerActive,
        sidActive,
      });

      if (!callerActive && !sidActive) {
        abandoned.push(entry.call_sid);
      }
    }

    // Mark abandoned calls using service role key (bypasses RLS)
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
