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
    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('Missing Twilio credentials');
    }

    const { callSid, conferenceName, toNumber, fromNumber } = await req.json();

    console.log('Send to voicemail request:', { callSid, conferenceName, toNumber, fromNumber });

    if (!conferenceName) {
      throw new Error('Conference name is required');
    }

    // Find the conference and get the customer's call SID
    const conferenceListUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}&Status=in-progress`;
    
    const conferenceResponse = await fetch(conferenceListUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      },
    });

    const conferenceData = await conferenceResponse.json();
    console.log('Conference lookup:', conferenceData);

    if (!conferenceData.conferences || conferenceData.conferences.length === 0) {
      throw new Error('Conference not found');
    }

    const conferenceSid = conferenceData.conferences[0].sid;

    // Get all participants
    const participantsUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Conferences/${conferenceSid}/Participants.json`;
    
    const participantsResponse = await fetch(participantsUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      },
    });

    const participantsData = await participantsResponse.json();
    console.log('Conference participants:', participantsData);

    // Find the customer participant (the one matching callSid or the first non-agent)
    const customerParticipant = participantsData.participants?.find(
      (p: { call_sid: string }) => p.call_sid === callSid
    ) || participantsData.participants?.[0];

    if (!customerParticipant) {
      throw new Error('No customer participant found in conference');
    }

    const customerCallSid = customerParticipant.call_sid;
    console.log('Customer call SID:', customerCallSid);

    // Create TwiML URL for voicemail - pass both the original caller (from) and the business number (to)
    const voicemailTwimlUrl = `${SUPABASE_URL}/functions/v1/voicemail-twiml?to=${encodeURIComponent(toNumber || '')}&from=${encodeURIComponent(fromNumber || '')}`;

    // Redirect the customer's call to voicemail
    const redirectUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${customerCallSid}.json`;
    
    const redirectParams = new URLSearchParams({
      Url: voicemailTwimlUrl,
      Method: 'POST',
    });

    console.log('Redirecting customer call to voicemail:', voicemailTwimlUrl);

    const redirectResponse = await fetch(redirectUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: redirectParams.toString(),
    });

    if (!redirectResponse.ok) {
      const errorText = await redirectResponse.text();
      console.error('Failed to redirect customer call to voicemail:', errorText);
      throw new Error(`Failed to redirect call: ${errorText}`);
    }

    const redirectData = await redirectResponse.json();
    console.log('Customer call redirected to voicemail:', redirectData);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Call sent to voicemail',
        disconnectAgent: true,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    console.error('Error sending to voicemail:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
