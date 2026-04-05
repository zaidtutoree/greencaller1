// Version 2 - Use Call Control API for both inbound and outbound
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to check if a string is a valid UUID (TeXML CallSid format)
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');

    if (!telnyxApiKey) {
      throw new Error('Telnyx API key not configured');
    }

    const { callId } = await req.json();

    if (!callId) {
      throw new Error('Call ID is required');
    }

    console.log('Pausing recording for call:', callId);

    const isCallControlId = callId.startsWith('v2:') || callId.startsWith('v3:');
    const isTexmlCallSid = isValidUUID(callId);

    let callControlId = callId;

    // If this is a UUID (WebRTC SDK or TeXML), resolve to Call Control ID
    if (isTexmlCallSid && !isCallControlId) {
      console.log('Resolving Call Control ID for UUID:', callId);

      // Try TeXML API
      try {
        const resp = await fetch(`https://api.telnyx.com/v2/texml_calls/${callId}`, {
          headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.data?.call_control_id) {
            callControlId = data.data.call_control_id;
            console.log('Found Call Control ID via TeXML API:', callControlId);
          }
        }
      } catch {}

      // Fallback: look up PSTN leg from call_history
      if (callControlId === callId) {
        try {
          const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
          const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const searchUrl = `${supabaseUrl}/rest/v1/call_history?direction=eq.outbound&created_at=gte.${encodeURIComponent(fiveMinAgo)}&call_sid=like.v3%3A*&order=created_at.desc&limit=1&select=call_sid`;
          const searchRes = await fetch(searchUrl, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
          });
          if (searchRes.ok) {
            const rows = await searchRes.json();
            if (Array.isArray(rows) && rows.length > 0 && rows[0].call_sid) {
              callControlId = rows[0].call_sid;
              console.log('Found PSTN Call Control ID from DB:', callControlId);
            }
          }
        } catch (e) {
          console.log('DB lookup failed:', e);
        }
      }
    }

    // Use Call Control API
    const apiUrl = `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_pause`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telnyx API error:', errorText);
      throw new Error(`Failed to pause recording: ${errorText}`);
    }

    const result = await response.json();
    console.log('Recording paused successfully:', result);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Recording paused successfully',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in telnyx-pause-recording function:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
