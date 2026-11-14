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

    console.log('Resuming recording for call:', callId);

    const isCallControlId = callId.startsWith('v2:') || callId.startsWith('v3:');
    const isTexmlCallSid = isValidUUID(callId);

    let callControlId = callId;

    // If this is a TeXML CallSid, look up the Call Control ID
    if (isTexmlCallSid && !isCallControlId) {
      console.log('Looking up Call Control ID for TeXML call:', callId);

      const callInfoResponse = await fetch(`https://api.telnyx.com/v2/texml_calls/${callId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (callInfoResponse.ok) {
        const callInfo = await callInfoResponse.json();
        if (callInfo.data?.call_control_id) {
          callControlId = callInfo.data.call_control_id;
          console.log('Found Call Control ID:', callControlId);
        }
      }
    }

    // Use Call Control API
    const apiUrl = `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_resume`;

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
      throw new Error(`Failed to resume recording: ${errorText}`);
    }

    const result = await response.json();
    console.log('Recording resumed successfully:', result);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Recording resumed successfully',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in telnyx-resume-recording function:', error);
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
