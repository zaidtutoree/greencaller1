import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { conferenceName, callSid, hold } = await req.json();
    
    console.log('Hold call request:', { conferenceName, callSid, hold });

    if (!conferenceName || !callSid) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing conferenceName or callSid' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not configured');
    }

    // First, get the conference SID from the friendly name
    const conferenceListUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}&Status=in-progress`;
    
    const conferenceResponse = await fetch(conferenceListUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
      },
    });

    const conferenceData = await conferenceResponse.json();
    console.log('Conference lookup result:', conferenceData);

    if (!conferenceData.conferences || conferenceData.conferences.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Conference not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const conferenceSid = conferenceData.conferences[0].sid;
    console.log('Conference SID:', conferenceSid);

    // Get all participants in the conference
    const participantsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants.json`;
    
    const participantsResponse = await fetch(participantsUrl, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
      },
    });

    const participantsData = await participantsResponse.json();
    console.log('Participants:', participantsData);

    // Find the customer participant (not the agent)
    // The customer's call SID should match the one we're trying to hold
    const customerParticipant = participantsData.participants?.find(
      (p: any) => p.call_sid === callSid
    );

    if (!customerParticipant) {
      // If we can't find by exact call SID, try to find any participant that isn't coaching
      // Usually there are 2 participants - agent and customer
      const participants = participantsData.participants || [];
      console.log('Looking for customer among participants:', participants.length);
      
      if (participants.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'No participants in conference' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Hold all non-agent participants (typically just the customer)
      for (const participant of participants) {
        // Update the participant's hold status
        const updateUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${participant.call_sid}.json`;
        
        const updateBody = new URLSearchParams();
        updateBody.append('Hold', hold ? 'true' : 'false');
        
        if (hold) {
          // Play hold music or announcement
          updateBody.append('HoldUrl', 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical');
        }

        console.log('Updating participant:', participant.call_sid, 'Hold:', hold);
        
        const updateResponse = await fetch(updateUrl, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: updateBody.toString(),
        });

        const updateResult = await updateResponse.json();
        console.log('Update result for', participant.call_sid, ':', updateResult);
      }
    } else {
      // Update the specific customer participant
      const updateUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`;
      
      const updateBody = new URLSearchParams();
      updateBody.append('Hold', hold ? 'true' : 'false');
      
      if (hold) {
        // Play hold music
        updateBody.append('HoldUrl', 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical');
      }

      console.log('Updating customer participant:', callSid, 'Hold:', hold);
      
      const updateResponse = await fetch(updateUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: updateBody.toString(),
      });

      const updateResult = await updateResponse.json();
      console.log('Update result:', updateResult);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        hold,
        message: hold ? 'Call placed on hold with music' : 'Call resumed'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Error in hold-call function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
