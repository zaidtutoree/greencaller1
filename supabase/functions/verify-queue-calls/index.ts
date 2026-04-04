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

    // Get all currently active calls from Telnyx
    // This returns all live calls on the account
    let activeCalls: Set<string> = new Set();
    try {
      const resp = await fetch('https://api.telnyx.com/v2/calls', {
        headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
      });

      if (resp.ok) {
        const data = await resp.json();
        const calls = data?.data || [];
        // Collect all active call session IDs, call control IDs, and caller/callee numbers
        for (const call of calls) {
          if (call.call_session_id) activeCalls.add(call.call_session_id);
          if (call.call_control_id) activeCalls.add(call.call_control_id);
          if (call.call_leg_id) activeCalls.add(call.call_leg_id);
          // Also track by from/to numbers for TeXML calls where CallSid is different
          if (call.from) activeCalls.add(call.from);
          if (call.to) activeCalls.add(call.to);
        }
        console.log('Active calls on account:', calls.length, 'tracking', activeCalls.size, 'identifiers');
      } else {
        console.error('Failed to list active calls:', resp.status, await resp.text());
        // If we can't check, don't mark anything as abandoned
        return new Response(
          JSON.stringify({ success: true, abandoned: [] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } catch (err) {
      console.error('Error listing active calls:', err);
      return new Response(
        JSON.stringify({ success: true, abandoned: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For each queued call, check if it (or its caller number) is still in an active call
    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    // Get the from_numbers for the queued calls so we can cross-reference
    const queueResp = await fetch(
      `${supabaseUrl}/rest/v1/call_queue?call_sid=in.(${callSids.map(s => `"${s}"`).join(',')})&select=call_sid,from_number,to_number`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    const queueEntries = queueResp.ok ? await queueResp.json() : [];
    const abandoned: string[] = [];

    for (const entry of queueEntries) {
      const callSid = entry.call_sid;
      const fromNumber = entry.from_number;
      const toNumber = entry.to_number;

      // Check if call_sid, from_number, or to_number appears in active calls
      const isActive = activeCalls.has(callSid) ||
        activeCalls.has(fromNumber) ||
        activeCalls.has(toNumber) ||
        // Also check with/without + prefix
        activeCalls.has('+' + fromNumber) ||
        activeCalls.has(fromNumber?.replace('+', ''));

      if (!isActive) {
        console.log('Call no longer active:', callSid, fromNumber);
        abandoned.push(callSid);
      }
    }

    // Mark abandoned calls in the database
    if (abandoned.length > 0) {
      for (const callSid of abandoned) {
        await fetch(
          `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=minimal' },
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
