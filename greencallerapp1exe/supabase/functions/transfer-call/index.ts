import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

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
    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('Missing Twilio credentials');
    }

    const { callSid, conferenceName, targetId, targetType, targetNumber, fromNumber, companyName } = await req.json();

    console.log('Transfer call request:', { callSid, conferenceName, targetId, targetType, targetNumber, fromNumber, companyName });

    if (!callSid && !conferenceName) {
      throw new Error('Either callSid or conferenceName is required');
    }

    // If transferring to a department, redirect caller to department IVR
    if (targetType === 'department') {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Missing Supabase credentials');
      }

      const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // Get department details
      const { data: dept, error: deptError } = await supabaseAdmin
        .from('departments')
        .select('id, name, company_name, phone_number_id')
        .eq('id', targetId)
        .single();

      if (deptError || !dept) {
        throw new Error('Department not found');
      }

      // Get the department's phone number
      let toNumber = targetNumber;
      if (dept.phone_number_id) {
        const { data: phoneData } = await supabaseAdmin
          .from('phone_numbers')
          .select('phone_number')
          .eq('id', dept.phone_number_id)
          .single();
        
        if (phoneData) {
          toNumber = phoneData.phone_number;
        }
      }

      // Find the customer's call SID in the conference (not the agent)
      // First get conference SID
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

      // Find the customer participant (the one matching callSid or the non-agent)
      const customerParticipant = participantsData.participants?.find(
        (p: { call_sid: string }) => p.call_sid === callSid
      ) || participantsData.participants?.[0];

      if (!customerParticipant) {
        throw new Error('No customer participant found in conference');
      }

      const customerCallSid = customerParticipant.call_sid;
      console.log('Customer call SID:', customerCallSid);

      // Generate a unique transfer ID to track this transfer
      const transferId = `transfer-${Date.now()}-${customerCallSid.slice(-6)}`;

      // Create TwiML URL for department transfer - this will play the department greeting
      // Pass the transferId so the ivr-handler can create the queue entry with proper tracking
      const transferTwimlUrl = `${SUPABASE_URL}/functions/v1/ivr-handler?To=${encodeURIComponent(toNumber || '')}&departmentId=${targetId}&isTransfer=true&transferId=${encodeURIComponent(transferId)}&fromNumber=${encodeURIComponent(fromNumber || '')}`;

      // Redirect the customer's call to the department IVR
      const redirectUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${customerCallSid}.json`;
      
      const redirectParams = new URLSearchParams({
        Url: transferTwimlUrl,
        Method: 'POST',
      });

      console.log('Redirecting customer call to:', transferTwimlUrl);

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
        console.error('Failed to redirect customer call:', errorText);
        throw new Error(`Failed to redirect call: ${errorText}`);
      }

      const redirectData = await redirectResponse.json();
      console.log('Customer call redirected:', redirectData);

      // Note: We don't insert into call_queue here anymore - the ivr-handler will do it
      // with the correct call_sid after the redirect completes

      console.log('Call transferred to department:', dept.name);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Call transferred to ${dept.name} - caller will hear department greeting`,
          departmentId: targetId,
          departmentName: dept.name,
          disconnectAgent: true, // Signal to frontend to end agent's call
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // For user transfers, continue with direct transfer logic
    if (!targetNumber) {
      throw new Error('Target number is required for transfer');
    }

    // If we have a conference, we can add the new participant to it
    if (conferenceName) {
      // Add new participant to conference
      const addParticipantUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Conferences/${conferenceName}/Participants.json`;
      
      const participantParams = new URLSearchParams({
        From: Deno.env.get('TWILIO_PHONE_NUMBER') || '',
        To: targetNumber,
        EarlyMedia: 'true',
        BeepOnEnter: 'true',
        StatusCallback: `${Deno.env.get('SUPABASE_URL')}/functions/v1/call-events`,
        StatusCallbackEvent: 'initiated ringing answered completed',
      });

      const addResponse = await fetch(addParticipantUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: participantParams.toString(),
      });

      if (!addResponse.ok) {
        const errorText = await addResponse.text();
        console.error('Failed to add participant:', errorText);
        throw new Error(`Failed to add participant: ${errorText}`);
      }

      const participantData = await addResponse.json();
      console.log('Added participant to conference:', participantData);

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Transfer initiated - adding new participant to conference',
          participantSid: participantData.call_sid,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // If we only have a callSid, use Twilio's redirect for warm transfer
    const redirectUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    
    // Create TwiML for transfer
    const twimlUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/transfer-twiml?to=${encodeURIComponent(targetNumber)}`;

    const redirectParams = new URLSearchParams({
      Url: twimlUrl,
      Method: 'POST',
    });

    const redirectResponse = await fetch(redirectUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: redirectParams.toString(),
    });

    if (!redirectResponse.ok) {
      const errorText = await redirectResponse.text();
      console.error('Failed to redirect call:', errorText);
      throw new Error(`Failed to redirect call: ${errorText}`);
    }

    const redirectData = await redirectResponse.json();
    console.log('Call redirected for transfer:', redirectData);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Call transfer initiated',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    console.error('Error transferring call:', error);
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
