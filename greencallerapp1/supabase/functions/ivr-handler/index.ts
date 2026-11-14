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
    // Check for query params (used in transfers)
    const url = new URL(req.url);
    const departmentIdParam = url.searchParams.get('departmentId');
    const isTransfer = url.searchParams.get('isTransfer') === 'true';
    const transferFromNumber = url.searchParams.get('fromNumber');
    
    let toNumber = '';
    let fromNumber = transferFromNumber || '';
    let callSid = '';
    let digit = '';

    // First get query params (always available)
    toNumber = url.searchParams.get('To') || '';
    fromNumber = fromNumber || url.searchParams.get('From') || '';
    callSid = url.searchParams.get('CallSid') || '';
    digit = url.searchParams.get('Digits') || '';

    // Try to get form data (for POST requests with form data)
    // This may override query params if form data is available
    try {
      const contentType = req.headers.get('content-type') || '';
      console.log('Request method:', req.method, 'Content-Type:', contentType);

      if (req.method === 'POST' && contentType.includes('application/x-www-form-urlencoded')) {
        const bodyText = await req.text();
        console.log('Form body:', bodyText);

        const params = new URLSearchParams(bodyText);
        toNumber = params.get('To') || toNumber;
        fromNumber = params.get('From') || fromNumber;
        callSid = params.get('CallSid') || callSid;
        digit = params.get('Digits') || digit;
      }
    } catch (e) {
      console.log('Error parsing form data:', e);
    }

    console.log('IVR Handler - Parsed params:', { toNumber, fromNumber, callSid, digit, phoneNumberIdParam: url.searchParams.get('phoneNumberId') });
    
    console.log('IVR Handler:', { toNumber, fromNumber, callSid, digit, departmentIdParam, isTransfer });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // If this is a direct department transfer, skip to routing
    if (isTransfer && departmentIdParam) {
      console.log('Direct department transfer for department:', departmentIdParam);
      
      // Get department details
      const { data: dept } = await supabase
        .from('departments')
        .select('id, name, company_name')
        .eq('id', departmentIdParam)
        .single();

      if (!dept) {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">I'm sorry, this department is not available. Goodbye.</Say>
  <Hangup/>
</Response>`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
        });
      }

      // Get IVR config for voice
      const { data: ivrConfig } = await supabase
        .from('ivr_configurations')
        .select('voice')
        .eq('company_name', dept.company_name)
        .single();

      const voiceName = ivrConfig?.voice || 'Polly.Amy-Neural';
      const conferenceName = `dept-${departmentIdParam}-${callSid}`;
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const hangupCallbackUrl = `${supabaseUrl}/functions/v1/call-hangup?callSid=${encodeURIComponent(callSid)}`;

      // Add transferred call to the department queue
      const { error: queueError } = await supabase
        .from('call_queue')
        .insert({
          call_sid: callSid,
          from_number: fromNumber || 'Unknown',
          to_number: toNumber || 'Unknown',
          department_id: departmentIdParam,
          company_name: dept.company_name,
          status: 'ringing',
        });

      if (queueError) {
        console.error('Failed to add transferred call to queue:', queueError);
      } else {
        console.log('Transferred call added to queue:', { callSid, department: dept.name });
      }

      // Redirect caller to hold music loop which polls for agent pickup
      const holdMusicUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}" language="en-GB">You are being transferred to ${dept.name}. Please hold while we connect you.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // Get phoneNumberId from query params (passed from telnyx-incoming-call)
    const phoneNumberIdParam = url.searchParams.get('phoneNumberId');

    // Get phone number and company info - try by ID first, then by number
    let phoneData = null;

    if (phoneNumberIdParam) {
      console.log('Looking up phone by ID:', phoneNumberIdParam);
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, company_name, phone_number')
        .eq('id', phoneNumberIdParam)
        .single();
      phoneData = data;
    }

    // Fallback: lookup by phone number if ID lookup failed
    if (!phoneData && toNumber) {
      console.log('Looking up phone by number:', toNumber);
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, company_name, phone_number')
        .eq('phone_number', toNumber)
        .single();
      phoneData = data;

      // Try without + prefix
      if (!phoneData && toNumber.startsWith('+')) {
        const { data: data2 } = await supabase
          .from('phone_numbers')
          .select('id, company_name, phone_number')
          .eq('phone_number', toNumber.substring(1))
          .single();
        phoneData = data2;
      }

      // Try with + prefix
      if (!phoneData && !toNumber.startsWith('+')) {
        const { data: data3 } = await supabase
          .from('phone_numbers')
          .select('id, company_name, phone_number')
          .eq('phone_number', '+' + toNumber)
          .single();
        phoneData = data3;
      }
    }

    console.log('Phone lookup result:', phoneData);

    if (!phoneData) {
      console.log('Phone number not found in database');
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">This number is not configured. Goodbye.</Say>
  <Hangup/>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // If no company_name on phone, try to get it from IVR config
    let companyName = phoneData.company_name;
    if (!companyName) {
      console.log('No company_name on phone, checking IVR config...');
      const { data: ivrByPhone } = await supabase
        .from('ivr_configurations')
        .select('company_name')
        .eq('phone_number_id', phoneData.id)
        .single();

      if (ivrByPhone) {
        companyName = ivrByPhone.company_name;
        console.log('Found company from IVR config:', companyName);
      }
    }

    if (!companyName) {
      console.log('No company name found for phone');
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">This number is not configured. Goodbye.</Say>
  <Hangup/>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // If no digit pressed yet, get IVR config and play menu
    if (!digit) {
      const { data: ivrConfig } = await supabase
        .from('ivr_configurations')
        .select(`
          id,
          greeting_message,
          voice,
          ivr_menu_options (
            digit,
            label,
            department_id
          )
        `)
        .eq('company_name', companyName)
        .single();

      console.log('IVR config lookup for company:', companyName, '- Result:', ivrConfig ? 'found' : 'not found');

      // Use the full voice name including -Neural suffix
      const voiceName = ivrConfig?.voice || 'Polly.Amy-Neural';

      if (!ivrConfig || !ivrConfig.ivr_menu_options || ivrConfig.ivr_menu_options.length === 0) {
        // No IVR configured, send to voicemail
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}" language="en-GB">I'm sorry, no one is available at the moment. Please leave a message after the tone.</Say>
  <Record action="${Deno.env.get('SUPABASE_URL')}/functions/v1/voicemail-callback?to=${toNumber}" maxLength="120" transcribe="true"/>
</Response>`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
        });
      }

      // Build menu message
      let menuMessage = ivrConfig.greeting_message + ' ';
      ivrConfig.ivr_menu_options.forEach((option: any) => {
        menuMessage += `Press ${option.digit} for ${option.label}. `;
      });

      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${Deno.env.get('SUPABASE_URL')}/functions/v1/ivr-handler" method="POST" timeout="5">
    <Say voice="${voiceName}" language="en-GB">${menuMessage}</Say>
  </Gather>
  <Say voice="${voiceName}" language="en-GB">We didn't receive a selection. Goodbye, and thank you for calling.</Say>
  <Hangup/>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // Digit was pressed, route to department - fetch IVR config for voice
    const { data: ivrConfigForDigit } = await supabase
      .from('ivr_configurations')
      .select('id, voice')
      .eq('company_name', companyName)
      .single();

    const voiceNameDigit = ivrConfigForDigit?.voice || 'Polly.Amy-Neural';

    const { data: menuOption } = await supabase
      .from('ivr_menu_options')
      .select('department_id, user_id, ivr_config_id')
      .eq('digit', digit)
      .eq('ivr_config_id', ivrConfigForDigit?.id || '')
      .single();

    if (!menuOption) {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceNameDigit}" language="en-GB">I'm sorry, that's not a valid selection. Goodbye.</Say>
  <Hangup/>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');

    // Route to user directly if user_id is set
    if (menuOption.user_id) {
      console.log('Routing to user:', menuOption.user_id);

      // Get user's assigned phone number
      const { data: phoneAssignment } = await supabase
        .from('phone_numbers')
        .select('phone_number')
        .eq('assigned_to', menuOption.user_id)
        .limit(1)
        .single();

      if (!phoneAssignment?.phone_number) {
        console.error('No phone number assigned to user:', menuOption.user_id);
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceNameDigit}" language="en-GB">I'm sorry, this person is not available. Goodbye.</Say>
  <Hangup/>
</Response>`, {
          headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
        });
      }

      // Insert into call_history for the user
      await supabase.from('call_history').insert({
        user_id: menuOption.user_id,
        call_sid: callSid,
        from_number: fromNumber,
        to_number: phoneAssignment.phone_number,
        direction: 'inbound',
        status: 'ringing',
      });

      // Dial the user's SIP endpoint (same as normal incoming call routing)
      // Get user's WebRTC registration for SIP URI
      const { data: regData } = await supabase
        .from('telnyx_webrtc_registrations')
        .select('sip_username')
        .eq('user_id', menuOption.user_id)
        .single();

      const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;
      const sipTarget = regData?.sip_username
        ? `<Sip>sip:${regData.sip_username}@sip.telnyx.com</Sip>`
        : `<Number>${phoneAssignment.phone_number}</Number>`;

      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceNameDigit}" language="en-GB">Thank you. Connecting you now.</Say>
  <Dial callerId="${fromNumber}" timeout="30" statusCallback="${statusCallbackUrl}" statusCallbackEvent="initiated ringing answered completed">
    ${sipTarget}
  </Dial>
  <Hangup/>
</Response>`, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // Route to department (existing flow)
    // Add call to queue with ringing status
    await supabase.from('call_queue').insert({
      call_sid: callSid,
      from_number: fromNumber,
      to_number: toNumber,
      department_id: menuOption.department_id,
      company_name: companyName,
      status: 'ringing'
    });

    // Redirect caller to hold music loop which polls for agent pickup
    const holdMusicUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;

    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceNameDigit}" language="en-GB">Thank you. Please hold while we connect you to a team member.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`, {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('=== IVR HANDLER ERROR ===');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', JSON.stringify(error, null, 2));
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">I'm terribly sorry, but we've encountered an issue. Please try again later.</Say>
  <Hangup/>
</Response>`, {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  }
});