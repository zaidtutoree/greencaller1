import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// This endpoint handles Call Control events when an agent is dialed to join a conference
// When the agent answers, we use the conference command to put them in the same conference as the caller
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const conferenceNameFromQuery = url.searchParams.get('conference') || '';
  
  console.log('Join conference webhook received, query params:', { conference: conferenceNameFromQuery });

  try {
    const contentType = req.headers.get('content-type') || '';
    let payload: any = {};
    
    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      for (const [key, value] of formData.entries()) {
        payload[key] = value;
      }
    }

    console.log('Join conference payload:', JSON.stringify(payload, null, 2));

    // Handle Call Control events
    const eventType = payload.data?.event_type || payload.event_type;
    const callControlId = payload.data?.payload?.call_control_id || payload.CallControlId || payload.CallSid;
    
    // Get conference name from query params or custom headers
    let conferenceName = conferenceNameFromQuery;
    const customHeaders = payload.data?.payload?.custom_headers || [];
    const confHeader = customHeaders.find((h: any) => h.name === 'X-Conference-Name');
    if (confHeader?.value) {
      conferenceName = confHeader.value;
    }

    console.log('Event details:', { eventType, callControlId, conferenceName });

    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    
    if (!telnyxApiKey) {
      console.error('TELNYX_API_KEY not configured');
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // When the call is answered, join the agent to the conference
    if (eventType === 'call.answered' && callControlId && conferenceName) {
      console.log('Agent answered - joining to conference:', conferenceName);
      
      // Use Telnyx Call Control conference command
      const conferenceResponse = await fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/conference`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            call_control_id: callControlId,
            conference_name: conferenceName,
            // Agent joins and starts the conference (stops hold music for caller)
            start_conference_on_enter: true,
            // When agent hangs up, end the conference
            end_conference_on_exit: true,
            // No beep when joining
            beep_enabled: 'never',
            // Play hold music to agent if they're first (shouldn't happen)
            hold_audio_url: 'http://com.twilio.sounds.music.s3.amazonaws.com/ClockworkWaltz.mp3',
          }),
        }
      );

      const conferenceData = await conferenceResponse.json();
      console.log('Conference join response:', conferenceData);

      if (!conferenceResponse.ok) {
        console.error('Failed to join conference:', conferenceData);
        return new Response(JSON.stringify({ error: 'Failed to join conference', details: conferenceData }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, message: 'Agent joined conference' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle call.initiated - just acknowledge
    if (eventType === 'call.initiated') {
      console.log('Call initiated to agent');
      return new Response(JSON.stringify({ success: true, message: 'Call initiated' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle call.hangup - conference ended
    if (eventType === 'call.hangup') {
      console.log('Agent call ended');
      return new Response(JSON.stringify({ success: true, message: 'Call ended' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Default response for other events
    return new Response(JSON.stringify({ success: true, message: 'Event acknowledged' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in telnyx-join-conference:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
