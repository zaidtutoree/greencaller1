// Version 4 - Use Call Control API for both inbound and outbound, store call_control_id
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to check if a string is a valid UUID (TeXML CallSid format)
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Helper to update call_history call_sid to the call_control_id (so recording webhook lookup works)
async function updateCallSidToControlId(originalCallSid: string, callControlId: string, fromNumber?: string, toNumber?: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    console.log('Supabase not configured, skipping call_history update');
    return;
  }

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // First try: Update by exact call_sid match
    const url1 = `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(originalCallSid)}`;
    const response1 = await fetch(url1, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ call_sid: callControlId }),
    });

    if (response1.ok) {
      const updated = await response1.json();
      if (updated && updated.length > 0) {
        console.log('Updated call_history call_sid from', originalCallSid, 'to', callControlId);
        return;
      }
    }

    // Second try: Find most recent inbound call and update it
    console.log('No exact match found, looking for recent inbound call...');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const searchUrl = `${supabaseUrl}/rest/v1/call_history?direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`;
    const searchRes = await fetch(searchUrl, { headers });

    if (searchRes.ok) {
      const calls = await searchRes.json();
      if (calls && calls.length > 0) {
        const callId = calls[0].id;
        console.log('Found recent inbound call:', callId, 'with call_sid:', calls[0].call_sid);

        // Update this call's call_sid
        const updateUrl = `${supabaseUrl}/rest/v1/call_history?id=eq.${callId}`;
        const updateRes = await fetch(updateUrl, {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ call_sid: callControlId }),
        });

        if (updateRes.ok) {
          console.log('Updated recent inbound call call_sid to:', callControlId);
        } else {
          console.log('Failed to update recent inbound call:', await updateRes.text());
        }
      } else {
        console.log('No recent inbound calls found');
      }
    }
  } catch (err) {
    console.error('Error updating call_history:', err);
  }
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

    const { callId, userId, fromNumber, toNumber } = await req.json();

    if (!callId) {
      throw new Error('Call ID is required');
    }

    console.log('Starting recording for Telnyx call:', { callId, userId, fromNumber, toNumber });

    // Determine the call type:
    // - Call Control IDs start with v2: or v3: (outbound calls OR newer TeXML format)
    // - TeXML CallSids are UUIDs (older inbound calls)
    const isCallControlId = callId.startsWith('v2:') || callId.startsWith('v3:');
    const isTexmlCallSid = isValidUUID(callId);

    console.log('Call ID analysis:', { callId, isCallControlId, isTexmlCallSid });

    let callControlId = callId;
    let originalCallId = callId;

    // If this is a TeXML CallSid (UUID), look up the Call Control ID via TeXML API
    if (isTexmlCallSid && !isCallControlId) {
      console.log('Looking up Call Control ID for TeXML call:', callId);

      // Get the TeXML call details to find the call_control_id
      const callInfoResponse = await fetch(`https://api.telnyx.com/v2/texml_calls/${callId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (callInfoResponse.ok) {
        const callInfo = await callInfoResponse.json();
        console.log('TeXML call info:', callInfo);

        // Extract call_control_id from the response
        if (callInfo.data?.call_control_id) {
          callControlId = callInfo.data.call_control_id;
          console.log('Found Call Control ID:', callControlId);

          // Update call_sid in call_history to use call_control_id
          // This makes recording webhook lookup work exactly like outbound calls
          await updateCallSidToControlId(callId, callControlId);
        } else {
          console.log('No call_control_id in response, using original callId');
        }
      } else {
        const errorText = await callInfoResponse.text();
        console.error('Failed to get TeXML call info:', errorText);
        // Continue with original callId as fallback
      }
    } else if (isCallControlId) {
      // For v3: format IDs (newer TeXML or inbound calls), we need to look up the call
      // to find the correct PSTN call_control_id that will be used in recording webhook
      console.log('Looking up call info for Call Control ID:', callId);

      // First try to get the call info from Call Control API
      const callInfoResponse = await fetch(`https://api.telnyx.com/v2/calls/${callId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (callInfoResponse.ok) {
        const callInfo = await callInfoResponse.json();
        console.log('Call Control call info:', callInfo);

        // Check if this call has a different call_control_id we should use
        const resolvedId = callInfo.data?.call_control_id;
        if (resolvedId && resolvedId !== callId) {
          console.log('Resolved to different Call Control ID:', resolvedId);
          callControlId = resolvedId;
          // Update call_history to use the resolved ID
          await updateCallSidToControlId(callId, callControlId);
        }
      } else {
        // Call Control API lookup failed - the call might be TeXML-originated
        // Try the TeXML calls endpoint as fallback
        console.log('Call Control lookup failed, trying TeXML endpoint...');

        // For TeXML calls with v3: IDs, we need to update call_history
        // so the recording webhook can find it
        // The webhook will send the same call_control_id we use for recording
        // So we just need to ensure call_history has this ID
        await updateCallSidToControlId(callId, callId);
      }
    }

    // Now use the Call Control API with the resolved call_control_id
    console.log('Using Call Control API for recording with ID:', callControlId);
    console.log('Original callId was TeXML:', isTexmlCallSid, 'Call Control:', isCallControlId);

    const apiUrl = `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`;
    const supabaseUrl = Deno.env.get('SUPABASE_URL');

    // Include webhook URL explicitly for TeXML calls
    // This ensures recording.saved webhook goes to our handler
    const requestBody: Record<string, any> = {
      format: 'mp3',
      channels: 'dual',
    };

    // For inbound/TeXML calls, specify the callback URL explicitly
    if (supabaseUrl) {
      requestBody.status_callback_url = `${supabaseUrl}/functions/v1/telnyx-call-events`;
    }

    console.log('Recording API request:', { apiUrl, requestBody });

    const recordResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!recordResponse.ok) {
      const errorText = await recordResponse.text();
      console.error('Telnyx recording API error:', errorText);
      throw new Error(`Failed to start recording: ${errorText}`);
    }

    const result = await recordResponse.json();
    console.log('Recording started successfully:', result);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Recording started successfully',
        callControlId: callControlId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in telnyx-start-recording function:', error);
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
