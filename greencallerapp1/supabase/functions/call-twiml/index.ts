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
    // Parse parameters from URL query string or request body
    const url = new URL(req.url);
    let conferenceName = url.searchParams.get('conferenceName') || url.searchParams.get('ConferenceName');
    let isAgent = url.searchParams.get('isAgent') === 'true' || url.searchParams.get('IsAgent') === 'true';
    
    // If parameters not in URL, check form body (TwiML App sends as form data)
    if (!conferenceName && req.method === 'POST') {
      const formData = await req.formData();
      const confNameValue = formData.get('conferenceName') || formData.get('ConferenceName');
      conferenceName = typeof confNameValue === 'string' ? confNameValue : 'default-conference';
      const isAgentValue = formData.get('isAgent') || formData.get('IsAgent');
      isAgent = typeof isAgentValue === 'string' && isAgentValue === 'true';
    }
    
    conferenceName = conferenceName || 'default-conference';

    // Generate TwiML that adds caller to a conference
    // The browser connection (agent) should end the conference when they hang up
    // The customer connection should not end the conference when they hang up
    // record="record-from-start" enables the Conference Recording API for mid-call recording control
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference statusCallback="https://${url.host}/functions/v1/call-events" statusCallbackEvent="start end join leave" beep="false" waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="${isAgent ? 'true' : 'false'}" record="record-from-start">
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    return new Response(twiml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/xml',
      },
    });
  } catch (error) {
    console.error('Error generating TwiML:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
