import "https://deno.land/x/xhr@0.1.0/mod.ts";
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
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!twilioAccountSid || !twilioAuthToken) {
      throw new Error('Twilio credentials not configured');
    }

    const { conferenceName, recordingSid } = await req.json();

    if (!conferenceName) {
      throw new Error('Conference name is required');
    }

    console.log('Pausing recording for conference:', conferenceName);

    // Get conference SID from conference name
    const conferencesUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}`;
    
    const conferencesResponse = await fetch(conferencesUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
      },
    });

    if (!conferencesResponse.ok) {
      throw new Error('Failed to fetch conference');
    }

    const conferencesData = await conferencesResponse.json();
    
    if (!conferencesData.conferences || conferencesData.conferences.length === 0) {
      throw new Error('Conference not found');
    }

    const conferenceSid = conferencesData.conferences[0].sid;

    // Get recordings for this conference
    const recordingsUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences/${conferenceSid}/Recordings.json?Status=in-progress`;
    
    const recordingsResponse = await fetch(recordingsUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
      },
    });

    if (!recordingsResponse.ok) {
      throw new Error('Failed to fetch recordings');
    }

    const recordingsData = await recordingsResponse.json();
    
    if (!recordingsData.recordings || recordingsData.recordings.length === 0) {
      throw new Error('No active recording found');
    }

    // Pause the recording
    const recording = recordingsData.recordings[0];
    const pauseUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences/${conferenceSid}/Recordings/${recording.sid}.json`;
    
    const pauseResponse = await fetch(pauseUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        Status: 'paused',
      }),
    });

    if (!pauseResponse.ok) {
      const errorText = await pauseResponse.text();
      console.error('Twilio API error:', errorText);
      throw new Error(`Failed to pause recording: ${errorText}`);
    }

    const result = await pauseResponse.json();
    console.log('Recording paused successfully:', result.sid);

    return new Response(
      JSON.stringify({
        success: true,
        recordingSid: result.sid,
        message: 'Recording paused successfully',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in pause-recording function:', error);
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
