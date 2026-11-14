import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const toNumber = formData.get('To') as string;
    const fromNumber = formData.get('From') as string;
    const callSid = formData.get('CallSid') as string;

    console.log('Incoming call:', { from: fromNumber, to: toNumber, callSid });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query phone numbers to check if it's assigned to a company (IVR) or user (direct)
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select('id, assigned_to, is_active, company_name')
      .eq('phone_number', toNumber)
      .single();

    console.log('Phone number lookup:', { phoneData, phoneError });

    if (phoneError || !phoneData || !phoneData.is_active) {
      console.log('Phone number not found or not active, routing to voicemail');
      const voicemailUrl = `${supabaseUrl}/functions/v1/voicemail-twiml?to=${encodeURIComponent(toNumber)}`;
      
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="${voicemailUrl}" timeout="20">
    <Number>${toNumber}</Number>
  </Dial>
</Response>`;

      return new Response(twiml, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/xml',
        },
      });
    }

    // Check if this phone number is assigned to a department
    const { data: deptData } = await supabase
      .from('departments')
      .select('id, name, company_name')
      .eq('phone_number_id', phoneData.id)
      .single();

    if (deptData) {
      console.log('Phone number belongs to department:', deptData.name);

      // Add call to department queue with ringing status
      await supabase.from('call_queue').insert({
        call_sid: callSid,
        from_number: fromNumber,
        to_number: toNumber,
        department_id: deptData.id,
        company_name: deptData.company_name,
        status: 'ringing'
      });

      // Generate conference name
      const conferenceName = `dept-${deptData.id}-${callSid}`;

      // Put caller in a conference room with hold music while waiting for pickup
      // Add action URL to handle when caller hangs up before being picked up
      const hangupCallbackUrl = `${supabaseUrl}/functions/v1/call-hangup?callSid=${encodeURIComponent(callSid)}`;
      
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">Thank you for calling ${deptData.name}. Please hold while we connect you to a team member.</Say>
  <Dial action="${hangupCallbackUrl}" timeout="300">
    <Conference 
      statusCallback="${supabaseUrl}/functions/v1/call-events" 
      statusCallbackEvent="start end join leave"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
      beep="false"
      startConferenceOnEnter="true"
      endConferenceOnExit="false">
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
    }

    // Check if this number has IVR configured (company assignment without department)
    if (phoneData.company_name) {
      console.log('Routing to IVR for company:', phoneData.company_name);
      
      const ivrUrl = `${supabaseUrl}/functions/v1/ivr-handler`;
      
      // Forward the call to IVR handler
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${ivrUrl}</Redirect>
</Response>`;

      return new Response(twiml, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/xml',
        },
      });
    }

    // If phone number is assigned to a user, dial both their browser clients simultaneously
    // This rings both the Lovable web app and the Replit mobile app
    if (phoneData.assigned_to) {
      const userId = phoneData.assigned_to;
      const mobileUserId = `user_${userId}`; // Replit mobile app uses prefixed identity
      
      console.log('Routing call to both clients:', { lovable: userId, mobile: mobileUserId });
      
      // Record the inbound call in call_history
      const { error: historyError } = await supabase.from('call_history').insert({
        user_id: userId,
        from_number: fromNumber,
        to_number: toNumber,
        direction: 'inbound',
        status: 'ringing',
        duration: 0,
        call_sid: callSid
      });
      
      if (historyError) {
        console.error('Error recording inbound call to history:', historyError);
      } else {
        console.log('Inbound call recorded to history');
      }
      
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="${supabaseUrl}/functions/v1/call-hangup?to=${encodeURIComponent(toNumber)}&amp;from=${encodeURIComponent(fromNumber)}">
    <Client>${userId}</Client>
    <Client>${mobileUserId}</Client>
  </Dial>
</Response>`;

      return new Response(twiml, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/xml',
        },
      });
    }

    // Fallback to voicemail
    const voicemailUrl = `${supabaseUrl}/functions/v1/voicemail-twiml?to=${encodeURIComponent(toNumber)}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${voicemailUrl}</Redirect>
</Response>`;

    return new Response(twiml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/xml',
      },
    });
  } catch (error) {
    console.error('Error handling incoming call:', error);
    // Always return valid TwiML to avoid Twilio "application error" message
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We're sorry, we couldn't connect your call right now. Please try again later.</Say>
  <Hangup/>
</Response>`;
    return new Response(errorTwiml, {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  }
});
