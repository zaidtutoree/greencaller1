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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');

    if (!twilioAccountSid || !twilioAuthToken) {
      throw new Error('Twilio credentials not configured');
    }

    const { conferenceName, userId, fromNumber, toNumber } = await req.json();

    if (!conferenceName) {
      throw new Error('Conference name is required');
    }

    console.log('Starting recording for conference:', conferenceName);

    // Get conference SID from conference name
    const conferencesUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}&Status=in-progress`;
    
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
    console.log('Found conference SID:', conferenceSid);

    // Check if there's already an active recording
    const recordingsCheckUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences/${conferenceSid}/Recordings.json?Status=in-progress`;
    
    const recordingsCheckResponse = await fetch(recordingsCheckUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
      },
    });

    const recordingsCheckData = await recordingsCheckResponse.json();
    
    if (recordingsCheckData.recordings && recordingsCheckData.recordings.length > 0) {
      console.log('Recording already in progress:', recordingsCheckData.recordings[0].sid);
      return new Response(
        JSON.stringify({
          success: true,
          recordingSid: recordingsCheckData.recordings[0].sid,
          message: 'Recording already in progress',
          alreadyRecording: true,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Start a new recording on the conference
    const startRecordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences/${conferenceSid}/Recordings.json`;
    
    const recordingParams = new URLSearchParams({
      RecordingStatusCallback: `${supabaseUrl}/functions/v1/call-events?userId=${userId || ''}&fromNumber=${encodeURIComponent(fromNumber || '')}&toNumber=${encodeURIComponent(toNumber || '')}`,
      RecordingStatusCallbackEvent: 'completed',
      RecordingChannels: 'dual',
    });

    const startRecordingResponse = await fetch(startRecordingUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: recordingParams.toString(),
    });

    if (!startRecordingResponse.ok) {
      const errorText = await startRecordingResponse.text();
      console.error('Twilio API error:', errorText);
      throw new Error(`Failed to start recording: ${errorText}`);
    }

    const result = await startRecordingResponse.json();
    console.log('Recording started successfully:', result.sid);

    return new Response(
      JSON.stringify({
        success: true,
        recordingSid: result.sid,
        message: 'Recording started successfully',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in start-recording function:', error);
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
