import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function supabaseQuery(query: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function supabaseInsert(table: string, data: Record<string, any>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });

  return { error: response.ok ? null : await response.text() };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const phoneNumberId = url.searchParams.get('phoneNumberId') || '';
    const companyName = url.searchParams.get('companyName') || '';
    const ivrConfigId = url.searchParams.get('ivrConfigId') || '';

    // Parse form data for digit
    let digit = '';
    let callSid = '';
    let fromNumber = '';
    let toNumber = '';

    try {
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const bodyText = await req.text();
        console.log('Gather form body:', bodyText);
        const params = new URLSearchParams(bodyText);
        digit = params.get('Digits') || '';
        callSid = params.get('CallSid') || '';
        fromNumber = params.get('From') || '';
        toNumber = params.get('To') || '';
      }
    } catch (e) {
      console.log('Error parsing form data:', e);
    }

    console.log('IVR Gather received:', { digit, callSid, fromNumber, toNumber, phoneNumberId, companyName, ivrConfigId });

    if (!digit) {
      console.log('No digit received');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">We didn't receive a selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    // Find the menu option for this digit
    const menuOptions = await supabaseQuery(
      `ivr_menu_options?ivr_config_id=eq.${ivrConfigId}&digit=eq.${digit}&select=department_id,user_id,label`
    );

    console.log('Menu option lookup:', menuOptions);

    if (!menuOptions || menuOptions.length === 0) {
      console.log('Invalid digit pressed:', digit);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">That's not a valid selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    const menuOption = menuOptions[0];
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

    // Route to user directly if user_id is set
    if (menuOption.user_id) {
      console.log('Routing to user:', menuOption.user_id);

      // Get user's assigned phone number
      const phones = await supabaseQuery(
        `phone_numbers?assigned_to=eq.${menuOption.user_id}&select=phone_number&limit=1`
      );

      if (!phones || phones.length === 0 || !phones[0].phone_number) {
        console.error('No phone number assigned to user:', menuOption.user_id);
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">I'm sorry, this person is not available. Goodbye.</Say>
  <Hangup/>
</Response>`,
          { headers: { 'Content-Type': 'application/xml' } }
        );
      }

      // Insert call history for the user
      await supabaseInsert('call_history', {
        user_id: menuOption.user_id,
        call_sid: callSid,
        from_number: fromNumber,
        to_number: phones[0].phone_number,
        direction: 'inbound',
        status: 'ringing',
      });

      // Get user's WebRTC registration for SIP URI
      const regs = await supabaseQuery(
        `telnyx_webrtc_registrations?user_id=eq.${menuOption.user_id}&select=sip_username&limit=1`
      );

      const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;
      const sipTarget = (regs && regs.length > 0 && regs[0].sip_username)
        ? `<Sip>sip:${regs[0].sip_username}@sip.telnyx.com</Sip>`
        : `<Number>${phones[0].phone_number}</Number>`;

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Thank you. Connecting you now.</Say>
  <Dial callerId="${fromNumber}" timeout="30" statusCallback="${statusCallbackUrl}" statusCallbackEvent="initiated ringing answered completed">
    ${sipTarget}
  </Dial>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    // Route to department (existing flow)
    const departmentId = menuOption.department_id;
    console.log('Routing to department:', departmentId);

    // Add call to queue
    const insertResult = await supabaseInsert('call_queue', {
      call_sid: callSid,
      from_number: fromNumber,
      to_number: toNumber,
      department_id: departmentId,
      company_name: companyName,
      status: 'waiting',
    });

    if (insertResult.error) {
      console.error('Error inserting to call_queue:', insertResult.error);
    }

    // Get department name for greeting
    const depts = await supabaseQuery(`departments?id=eq.${departmentId}&select=name`);
    const deptName = depts?.[0]?.name || 'the department';

    // Escape department name for XML
    const escapedDeptName = deptName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Put caller on hold
    const holdMusicUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;

    console.log('Placing caller on hold for department:', deptName);

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Thank you. Please hold while we connect you to ${escapedDeptName}.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );

  } catch (error: any) {
    console.error('=== IVR GATHER ERROR ===');
    console.error('Error message:', error?.message || error);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', JSON.stringify(error, null, 2));
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">An error occurred. Please try again later.</Say>
  <Hangup/>
</Response>`,
      { status: 500, headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
