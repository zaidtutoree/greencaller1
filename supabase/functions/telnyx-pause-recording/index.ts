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

    const { callId, fromNumber, toNumber } = await req.json();

    if (!callId) {
      throw new Error('Call ID is required');
    }

    console.log('Pausing recording for call:', callId, 'from:', fromNumber, 'to:', toNumber);

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

      // Fallback: look up the v3: Call Control ID from call_history.
      // For SDK-direct outbound calls, the inbound row inserted by
      // handleTeXMLIncoming on the receiver's leg carries the real v3: ID.
      // Match by trailing 9 digits of from/to to tolerate +/no-+ formatting.
      if (callControlId === callId) {
        try {
          const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
          const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
          const normalizeNum = (n: string | undefined) => (n || '').replace(/\D/g, '');
          const toLast9 = normalizeNum(toNumber).slice(-9);
          const fromLast9 = normalizeNum(fromNumber).slice(-9);
          console.log('Pause fallback digits — from:', fromLast9, 'to:', toLast9);

          // Pull recent rows once, scan locally for both outbound and inbound v3:
          const searchUrl = `${supabaseUrl}/rest/v1/call_history?created_at=gte.${encodeURIComponent(fiveMinAgo)}&order=created_at.desc&limit=20&select=call_sid,from_number,to_number,direction`;
          const searchRes = await fetch(searchUrl, { headers });
          if (searchRes.ok) {
            const rows = await searchRes.json();
            if (Array.isArray(rows) && rows.length > 0) {
              // Pass 1: outbound v3: matching to_number digits
              if (toLast9) {
                for (const row of rows) {
                  if (row.direction !== 'outbound') continue;
                  if (!row.call_sid || (!row.call_sid.startsWith('v2:') && !row.call_sid.startsWith('v3:'))) continue;
                  if (normalizeNum(row.to_number).slice(-9) === toLast9) {
                    callControlId = row.call_sid;
                    console.log('Found PSTN Call Control ID via outbound match:', callControlId);
                    break;
                  }
                }
              }
              // Pass 2: inbound v3: matching from/to digits (SDK-direct outbound case)
              if (callControlId === callId && toLast9 && fromLast9) {
                for (const row of rows) {
                  if (row.direction !== 'inbound') continue;
                  if (!row.call_sid || (!row.call_sid.startsWith('v2:') && !row.call_sid.startsWith('v3:'))) continue;
                  if (normalizeNum(row.to_number).slice(-9) === toLast9 &&
                      normalizeNum(row.from_number).slice(-9) === fromLast9) {
                    callControlId = row.call_sid;
                    console.log('Found PSTN Call Control ID via inbound bridged-leg row:', callControlId);
                    break;
                  }
                }
              }
              // Pass 3: most recent v3: of any direction
              if (callControlId === callId) {
                for (const row of rows) {
                  if (row.call_sid && (row.call_sid.startsWith('v2:') || row.call_sid.startsWith('v3:'))) {
                    callControlId = row.call_sid;
                    console.log('Found PSTN Call Control ID (most recent v3:):', callControlId);
                    break;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.log('DB lookup failed:', e);
        }
      }
    }

    // Verify the call is still active before trying to pause; otherwise
    // Telnyx returns 90018 "Call has already ended".
    if (callControlId && (callControlId.startsWith('v2:') || callControlId.startsWith('v3:'))) {
      try {
        const aliveResp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}`, {
          headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
        });
        if (aliveResp.ok) {
          const aliveData = await aliveResp.json();
          const isAlive = aliveData?.data?.is_alive;
          console.log('Pause liveness check:', { callControlId, isAlive });
          if (isAlive === false) {
            return new Response(
              JSON.stringify({
                success: false,
                error: 'Call has already ended — cannot pause recording',
                callEnded: true,
              }),
              { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        }
      } catch (e) {
        console.log('Liveness check failed (continuing):', e);
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
