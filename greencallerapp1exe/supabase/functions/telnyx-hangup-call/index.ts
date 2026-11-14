import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Check if an ID looks like a Call Control ID (v2:/v3: prefix)
function isCallControlId(id: string): boolean {
  return id.startsWith('v2:') || id.startsWith('v3:');
}

// Check if an ID looks like a UUID (TeXML CallSid format)
function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { callControlId } = await req.json();

    if (!callControlId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing callControlId' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    const apiKey = Deno.env.get('TELNYX_API_KEY');
    if (!apiKey) {
      console.error('Missing TELNYX_API_KEY');
      return new Response(
        JSON.stringify({ success: false, error: 'Server configuration error' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      );
    }

    console.log('Hanging up call:', callControlId);

    let success = false;
    let lastError = '';

    // Strategy 1: If it looks like a Call Control ID, use the Call Control API
    if (isCallControlId(callControlId)) {
      console.log('Using Call Control API for:', callControlId);
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      if (response.ok || response.status === 404) {
        success = true;
        console.log('Call Control hangup successful (or call already ended)');
      } else {
        lastError = await response.text();
        console.error('Call Control hangup error:', response.status, lastError);
      }
    }

    // Strategy 2: If it's a UUID (TeXML CallSid), use the TeXML update API
    // to redirect the PSTN call to <Hangup/>
    if (!success && isUUID(callControlId)) {
      console.log('Using TeXML update API for CallSid:', callControlId);
      const texmlResponse = await fetch(
        `https://api.telnyx.com/v2/texml/calls/${callControlId}/update`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            texml: '<Response><Hangup/></Response>',
          }),
        }
      );

      if (texmlResponse.ok) {
        success = true;
        console.log('TeXML update hangup successful');
      } else {
        const texmlError = await texmlResponse.text();
        console.error('TeXML update error:', texmlResponse.status, texmlError);

        // If call is already ended, treat as success
        if (texmlResponse.status === 404 || texmlError.includes('not found')) {
          success = true;
          console.log('TeXML call already ended - treating as success');
        } else {
          lastError = texmlError;
        }
      }
    }

    // Strategy 3: If neither worked, try both APIs as fallback
    if (!success && !isCallControlId(callControlId) && !isUUID(callControlId)) {
      console.log('Unknown ID format, trying Call Control API:', callControlId);
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      if (response.ok || response.status === 404) {
        success = true;
      } else {
        lastError = await response.text();
        console.error('Fallback hangup error:', response.status, lastError);
      }
    }

    if (success) {
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: `Failed to hang up call: ${lastError}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  } catch (error: unknown) {
    console.error('Error in telnyx-hangup-call:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
