import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// This webhook handles Call Control events when the agent is dialed into a conference
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const conferenceFromQuery = url.searchParams.get('conference') || '';
  
  console.log('Agent conference webhook:', { method: req.method, conferenceFromQuery });

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    if (!telnyxApiKey) {
      throw new Error('TELNYX_API_KEY not configured');
    }

    // Parse the webhook payload
    let payload: any = {};
    const contentType = req.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      for (const [key, value] of formData.entries()) {
        payload[key] = value.toString();
      }
    }

    console.log('Agent webhook payload:', JSON.stringify(payload, null, 2));

    // Extract event type and call control ID (handles both Call Control and TeXML formats)
    const eventType = payload.data?.event_type || payload.event_type || payload.EventType || '';
    const callControlId = payload.data?.payload?.call_control_id || 
                          payload.call_control_id || 
                          payload.CallControlId ||
                          payload.CallSid || '';
    
    // Get conference name from custom headers or query param
    let conferenceName = conferenceFromQuery;
    const customHeaders = payload.data?.payload?.custom_headers || [];
    for (const header of customHeaders) {
      if (header.name === 'X-Conference-Name') {
        conferenceName = header.value;
        break;
      }
    }

    console.log('Parsed event:', { eventType, callControlId, conferenceName });

    // Handle different Call Control events
    if (eventType === 'call.initiated') {
      console.log('Agent call initiated, waiting for answer...');
      return new Response(JSON.stringify({ status: 'acknowledged' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (eventType === 'call.answered') {
      console.log('Agent answered, joining conference:', conferenceName);
      
      if (!callControlId) {
        console.error('No call_control_id in answered event');
        return new Response(JSON.stringify({ error: 'No call_control_id' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!conferenceName) {
        console.error('No conference name available');
        // Speak an error and hangup
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            payload: 'Error: No conference specified. Please try again.',
            voice: 'female',
            language: 'en-GB',
          }),
        });
        
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cause: 'normal_clearing' }),
        });
        
        return new Response(JSON.stringify({ error: 'No conference name' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Join the conference using Call Control API
      const conferenceResp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/conference`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          call_control_id: callControlId,
          // Telnyx Call Control expects `conference_name` (snake_case)
          conference_name: conferenceName,
          start_conference_on_enter: true,
          end_conference_on_exit: true,
          beep_enabled: 'never',
          hold_audio_url: '', // No hold audio for agent
        }),
      });

      const conferenceData = await conferenceResp.text();
      console.log('Conference join response:', { status: conferenceResp.status, body: conferenceData });

      if (!conferenceResp.ok) {
        console.error('Failed to join conference:', conferenceData);
        return new Response(JSON.stringify({ error: 'Failed to join conference', details: conferenceData }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ status: 'joined_conference', conferenceName }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (eventType === 'call.hangup') {
      console.log('Agent call hangup:', payload.data?.payload?.hangup_cause);
      return new Response(JSON.stringify({ status: 'call_ended' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // For TeXML compatibility - return XML if no recognized Call Control event
    if (!eventType && conferenceFromQuery) {
      console.log('Returning TeXML for backward compatibility');
      const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Connecting you to the caller.</Say>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">
      ${conferenceFromQuery}
    </Conference>
  </Dial>
</Response>`;
      return new Response(texml, { headers: { 'Content-Type': 'application/xml' } });
    }

    // Default acknowledgment for unhandled events
    console.log('Unhandled event type:', eventType);
    return new Response(JSON.stringify({ status: 'acknowledged', event: eventType }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in agent conference webhook:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
