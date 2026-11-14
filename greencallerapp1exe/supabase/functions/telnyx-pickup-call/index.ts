import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { queueId, userId } = await req.json();

    console.log('Telnyx pickup call request:', { queueId, userId });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get queue item
    const { data: queueItem, error: queueError } = await supabase
      .from('call_queue')
      .select('*')
      .eq('id', queueId)
      .in('status', ['waiting', 'ringing'])
      .single();

    if (queueError || !queueItem) {
      console.log('Queue lookup result:', { queueItem, queueError });
      return new Response(JSON.stringify({ error: 'Call not found or already picked up' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get user's assigned phone number
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select('phone_number')
      .eq('assigned_to', userId)
      .eq('provider', 'telnyx')
      .eq('is_active', true)
      .single();

    if (phoneError || !phoneData) {
      console.log('User phone number lookup failed:', { phoneError });
      return new Response(JSON.stringify({ error: 'No phone number assigned to user' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get user's SIP username
    const { data: regData } = await supabase
      .from('telnyx_webrtc_registrations')
      .select('sip_username')
      .eq('user_id', userId)
      .single();

    if (!regData?.sip_username) {
      return new Response(JSON.stringify({ error: 'No SIP registration found for user - please refresh the page' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Picking up call:', {
      callSid: queueItem.call_sid,
      sipUsername: regData.sip_username,
      agentNumber: phoneData.phone_number
    });

    // Update queue status to picked_up
    const pickedUpAt = new Date().toISOString();
    await supabase
      .from('call_queue')
      .update({
        status: 'picked_up',
        picked_up_by: userId,
        picked_up_at: pickedUpAt
      })
      .eq('id', queueId);

    // Calculate wait time in seconds
    const waitTimeSeconds = Math.round(
      (new Date(pickedUpAt).getTime() - new Date(queueItem.created_at).getTime()) / 1000
    );

    // Insert into call_history for stats tracking
    await supabase
      .from('call_history')
      .insert({
        from_number: queueItem.from_number,
        to_number: phoneData.phone_number,
        direction: 'inbound',
        status: 'ringing',
        duration: waitTimeSeconds,
        user_id: userId,
        call_sid: queueItem.call_sid
      });

    // Actively redirect the caller directly to the agent's SIP endpoint
    // Use telnyx-transfer-dial to bypass the hold music loop entirely (avoids race conditions)
    const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');

    if (TELNYX_API_KEY && queueItem.call_sid) {
      console.log('Actively redirecting call to agent SIP via Telnyx API, call_sid:', queueItem.call_sid);

      const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
      const callerNumber = queueItem.from_number || '';

      // Redirect directly to the transfer-dial endpoint which returns <Dial><Sip> TeXML
      // This avoids the hold music loop race condition where the loop redirect
      // can interrupt an already-active <Dial>
      const transferUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-dial?sipUri=${encodeURIComponent(sipUri)}&from=${encodeURIComponent(callerNumber)}&agentNumber=${encodeURIComponent(phoneData.phone_number)}&userId=${encodeURIComponent(userId)}&callSid=${encodeURIComponent(queueItem.call_sid)}`;

      const updateResponse = await fetch(
        `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(queueItem.call_sid)}/update`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            Url: transferUrl,
            Method: 'GET',
          }),
        }
      );

      if (updateResponse.ok) {
        console.log('Telnyx call redirected to transfer-dial - agent SIP will ring immediately');
      } else {
        const errorText = await updateResponse.text();
        console.error('Telnyx call redirect failed:', updateResponse.status, errorText);
        // Don't fail the whole request - the hold music loop is still a fallback
      }
    } else {
      console.log('No TELNYX_API_KEY or call_sid - falling back to passive hold music detection');
    }

    return new Response(JSON.stringify({
      success: true,
      callSid: queueItem.call_sid,
      fromNumber: queueItem.from_number,
      toNumber: phoneData.phone_number,
      message: 'Call pickup initiated - transferring to agent'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in telnyx-pickup-call:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
