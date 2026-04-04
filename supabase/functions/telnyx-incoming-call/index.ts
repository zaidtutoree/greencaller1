import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to make Supabase REST API calls without the client library
async function supabaseQuery(table: string, params: {
  select?: string;
  filters?: Record<string, string>;
  single?: boolean;
}) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let url = `${supabaseUrl}/rest/v1/${table}?`;
  if (params.select) url += `select=${encodeURIComponent(params.select)}&`;
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      url += `${key}=eq.${encodeURIComponent(value)}&`;
    }
  }

  const headers: Record<string, string> = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };
  if (params.single) headers['Accept'] = 'application/vnd.pgrst.object+json';

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    return { data: null, error: { message: text } };
  }
  return { data: await response.json(), error: null };
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

  if (!response.ok) {
    const text = await response.text();
    return { error: { message: text } };
  }
  return { error: null };
}

async function supabaseUpdate(table: string, data: Record<string, any>, filters: Record<string, string>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let url = `${supabaseUrl}/rest/v1/${table}?`;
  for (const [key, value] of Object.entries(filters)) {
    url += `${key}=eq.${encodeURIComponent(value)}&`;
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: { message: text } };
  }
  return { error: null };
}

async function supabaseUpsert(table: string, data: Record<string, any>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: { message: text } };
  }
  return { error: null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    console.log('Incoming request content-type:', contentType);

    // Handle both JSON (Call Control) and form-urlencoded (TeXML) formats
    if (contentType.includes('application/x-www-form-urlencoded')) {
      // TeXML webhook format
      const formData = await req.formData();
      const formObj: Record<string, string> = {};
      formData.forEach((value, key) => {
        formObj[key] = value.toString();
      });
      console.log('TeXML webhook received:', formObj);

      // Check for recording webhook (TeXML format)
      // Recording webhooks have RecordingUrl or RecordingSid
      if (formObj.RecordingUrl || formObj.RecordingSid) {
        console.log('=== TEXML RECORDING WEBHOOK RECEIVED ===');
        return await handleTeXMLRecording(formObj);
      }

      // Check for call status callback (TeXML format)
      // These have CallStatus field indicating the call state
      if (formObj.CallStatus && formObj.CallSid) {
        console.log('=== TEXML STATUS CALLBACK ===', formObj.CallStatus);
        return await handleTeXMLStatusCallback(formObj);
      }

      // Telnyx TeXML webhooks don't always include CallStatus/Direction.
      // If we have the basic call fields, treat it as an inbound call and return TeXML to route it.
      if (formObj.From && formObj.To && formObj.CallSid) {
        return await handleTeXMLIncoming(formObj);
      }

      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { ...corsHeaders, 'Content-Type': 'application/xml' } }
      );
    } else {
      // Call Control JSON format
      const body = await req.json();
      const eventType = body.data?.event_type;
      const payload = body.data?.payload;

      console.log('Telnyx Call Control webhook:', { eventType, payload });

      if (eventType === 'call.initiated' && payload?.direction === 'incoming') {
        return await handleIncomingCall(payload);
      }

      if (eventType === 'call.answered') {
        return await handleCallAnswered(payload);
      }

      if (eventType === 'call.hangup') {
        return await handleCallHangup(payload);
      }

      // Handle recording.saved event for TeXML calls
      if (eventType === 'call.recording.saved') {
        console.log('Recording saved event received in telnyx-incoming-call');
        return await handleRecordingSaved(payload);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error handling Telnyx incoming call:', error);
    // Return valid XML so Telnyx doesn't play "application error" message
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>',
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
      }
    );
  }
});

async function handleTeXMLIncoming(formData: Record<string, string>) {
  const from = formData.From;
  const to = formData.To;
  const callSid = formData.CallSid;

  console.log('TeXML incoming call:', { from, to, callSid });

  // Query phone numbers to find who it's assigned to
  const { data: phoneData, error: phoneError } = await supabaseQuery('phone_numbers', {
    select: 'id,assigned_to,is_active,company_name',
    filters: { phone_number: to, provider: 'telnyx' },
    single: true,
  });

  console.log('Phone number lookup:', { phoneData, phoneError });

  if (phoneError || !phoneData || !phoneData.is_active) {
    console.log('Phone number not found or not active, rejecting call');
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Check if phone is assigned to a specific user first
  if (phoneData.assigned_to) {
    const userId = phoneData.assigned_to;
    console.log('Routing TeXML call to user:', userId);

    // Check subscription status for inbound call gating
    const { data: profileRows } = await supabaseQuery('profiles', {
      select: 'can_make_calls',
      filters: { id: userId },
    });
    const userProfile = Array.isArray(profileRows) && profileRows.length > 0 ? profileRows[0] : null;
    if (userProfile && userProfile.can_make_calls === false) {
      console.log('User subscription inactive, rejecting inbound call');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">We're sorry, this number is not currently available. Please try again later.</Say>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    // Record the inbound call
    await supabaseInsert('call_history', {
      user_id: userId,
      from_number: from,
      to_number: to,
      direction: 'inbound',
      status: 'ringing',
      duration: 0,
      call_sid: callSid,
    });

    // Get the user's SIP credentials with freshness check
    const { data: regData } = await supabaseQuery('telnyx_webrtc_registrations', {
      select: 'sip_username,updated_at,expires_at',
      filters: { user_id: userId },
      single: true,
    });

    if (regData?.sip_username) {
      // Check if registration is fresh (updated within last 3 minutes)
      // This prevents dialing stale registrations where the WebRTC client has disconnected
      const updatedAt = regData.updated_at ? new Date(regData.updated_at).getTime() : 0;
      const now = Date.now();
      const secondsSinceUpdate = (now - updatedAt) / 1000;
      const expiresAt = regData.expires_at ? new Date(regData.expires_at).getTime() : 0;
      const isExpired = expiresAt && expiresAt < now;

      // Consider registration stale if not updated in 3 minutes or if expired
      const isStale = secondsSinceUpdate > 180 || isExpired;

      console.log('Registration check:', {
        userId,
        sipUsername: regData.sip_username,
        secondsSinceUpdate: Math.round(secondsSinceUpdate),
        isExpired,
        isStale,
      });

      if (isStale) {
        console.log('SIP registration is stale, routing to voicemail');

        // Update call to missed status
        await supabaseUpdate('call_history', { status: 'missed' }, { call_sid: callSid });

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const voicemailUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(to)}&amp;from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(callSid)}`;

        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${voicemailUrl}</Redirect>
</Response>`,
          { headers: { 'Content-Type': 'application/xml' } }
        );
      }

      console.log('Found user SIP registration:', regData.sip_username);
      const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
      console.log('Dialing SIP URI via TeXML:', sipUri);

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

      // Build the voicemail action URL for when dial fails/times out
      // Include callSid so the voicemail handler can update call status to 'missed'
      const voicemailActionUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(to)}&amp;from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(callSid)}`;

      // Use answerOnBridge="false" so Telnyx answers immediately and plays ringback to caller
      // while the SIP endpoint rings. The WebRTC client has time to accept.
      // Also increase timeout to 60 seconds.
      // The action URL routes to voicemail on no-answer, busy, or failed.
      // The statusCallback URL receives status updates (answered, completed) to update call_history
      // NOTE: Use the original caller's number (from) as callerId so the WebRTC client
      // displays who is actually calling, not the business number.
      // Pass the original PSTN CallSid via custom SIP header so WebRTC client can use it for recording
      const sipUriWithHeaders = `${sipUri}?X-PSTN-Call-Sid=${encodeURIComponent(callSid)}&amp;X-To-Number=${encodeURIComponent(to)}`;
      const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-incoming-call`;
      console.log('SIP URI with headers:', sipUriWithHeaders);

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}" timeout="60" answerOnBridge="false" action="${voicemailActionUrl}" statusCallback="${statusCallbackUrl}" statusCallbackEvent="initiated answered completed">
    <Sip>${sipUriWithHeaders}</Sip>
  </Dial>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    } else {
      console.log('No SIP registration found for user');

      // Mark as missed and go to voicemail
      await supabaseUpdate('call_history', { status: 'missed' }, { call_sid: callSid });

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const voicemailUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(to)}&amp;from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(callSid)}`;

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${voicemailUrl}</Redirect>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  // First, check if this phone number is assigned to a department
  // If so, skip IVR and route directly to the department queue
  const { data: deptData, error: deptError } = await supabaseQuery('departments', {
    select: 'id,name,company_name',
    filters: { phone_number_id: phoneData.id },
    single: true,
  });

  console.log('Department lookup:', { deptData, deptError });

  if (deptData) {
    console.log('Phone number assigned to department:', deptData.name, '- routing directly (skipping IVR)');

    // Get IVR voice setting for this company (just for the voice, not the menu)
    const { data: ivrVoice } = await supabaseQuery('ivr_configurations', {
      select: 'voice',
      filters: { company_name: deptData.company_name },
      single: true,
    });
    const voiceName = ivrVoice?.voice || 'Polly.Amy-Neural';

    // Escape department name for XML
    const escapedDeptName = deptData.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Insert into call queue
    await supabaseInsert('call_queue', {
      call_sid: callSid,
      from_number: from,
      to_number: to,
      company_name: deptData.company_name,
      department_id: deptData.id,
      status: 'waiting',
    });

    // Hold music URL with Redirect loop — checks for agent pickup every ~3 seconds
    const holdMusicUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;

    console.log('Playing hold music for caller, call_sid:', callSid);

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">Thank you for calling ${escapedDeptName}. Please hold while we connect you with an available representative.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Check if there's an IVR configuration for this phone number
  const { data: ivrByPhone } = await supabaseQuery('ivr_configurations', {
    select: 'id,greeting_message,voice,company_name',
    filters: { phone_number_id: phoneData.id },
    single: true,
  });

  console.log('IVR lookup by phone_number_id:', ivrByPhone ? 'found' : 'not found');

  if (ivrByPhone) {
    console.log('IVR configuration found for phone, generating IVR menu inline');

    // Fetch menu options separately
    let menuOptions: any[] = [];
    if (ivrByPhone.id) {
      const ivrConfigId = ivrByPhone.id;
      const optionsUrl = `${supabaseUrl}/rest/v1/ivr_menu_options?ivr_config_id=eq.${ivrConfigId}&select=digit,label,department_id`;
      const optionsRes = await fetch(optionsUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (optionsRes.ok) {
        menuOptions = await optionsRes.json();
      }
    }

    console.log('IVR config:', ivrByPhone);
    console.log('Menu options:', menuOptions);

    const voiceName = ivrByPhone.voice || 'Polly.Amy-Neural';

    if (!menuOptions || menuOptions.length === 0) {
      // No menu options, send to voicemail
      console.log('No IVR menu options, sending to voicemail');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">I'm sorry, no one is available at the moment. Please leave a message after the tone.</Say>
  <Record maxLength="120" />
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    // Build menu message
    let menuMessage = (ivrByPhone.greeting_message || 'Thank you for calling.') + ' ';
    menuOptions.forEach((option: any) => {
      menuMessage += `Press ${option.digit} for ${option.label}. `;
    });

    // Generate Gather URL for digit collection - use &amp; for XML escaping
    const gatherUrl = `${supabaseUrl}/functions/v1/telnyx-ivr-gather?phoneNumberId=${encodeURIComponent(phoneData.id)}&amp;companyName=${encodeURIComponent(ivrByPhone.company_name || '')}&amp;ivrConfigId=${encodeURIComponent(ivrByPhone.id || '')}`;

    console.log('Returning IVR menu with Gather URL:', gatherUrl);

    // Escape special XML characters in the menu message
    const escapedMenuMessage = menuMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="10">
    <Say voice="${voiceName}">${escapedMenuMessage}</Say>
  </Gather>
  <Say voice="${voiceName}">We didn't receive a selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Also check if company_name on phone has an IVR config
  if (phoneData.company_name) {
    const { data: ivrByCompanyName } = await supabaseQuery('ivr_configurations', {
      select: 'id,greeting_message,voice,company_name',
      filters: { company_name: phoneData.company_name },
      single: true,
    });

    console.log('IVR lookup by phone company_name:', ivrByCompanyName ? 'found' : 'not found');

    if (ivrByCompanyName) {
      console.log('IVR configuration found via phone company_name, generating IVR menu inline');

      // Fetch menu options
      let menuOptions: any[] = [];
      const ivrConfigId = ivrByCompanyName.id;
      const optionsUrl = `${supabaseUrl}/rest/v1/ivr_menu_options?ivr_config_id=eq.${ivrConfigId}&select=digit,label,department_id`;
      const optionsRes = await fetch(optionsUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (optionsRes.ok) {
        menuOptions = await optionsRes.json();
      }

      console.log('Company name IVR menu options:', menuOptions);

      const voiceName = ivrByCompanyName?.voice || 'Polly.Amy-Neural';

      if (!menuOptions || menuOptions.length === 0) {
        console.log('No IVR menu options configured');
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">I'm sorry, no one is available at the moment. Goodbye.</Say>
  <Hangup/>
</Response>`,
          { headers: { 'Content-Type': 'application/xml' } }
        );
      }

      // Build menu message
      let menuMessage = (ivrByCompanyName?.greeting_message || 'Thank you for calling.') + ' ';
      menuOptions.forEach((option: any) => {
        menuMessage += `Press ${option.digit} for ${option.label}. `;
      });

      // Escape special XML characters in the menu message
      const escapedMenuMessage = menuMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const gatherUrl = `${supabaseUrl}/functions/v1/telnyx-ivr-gather?phoneNumberId=${encodeURIComponent(phoneData.id)}&amp;companyName=${encodeURIComponent(phoneData.company_name)}&amp;ivrConfigId=${encodeURIComponent(ivrConfigId)}`;

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="10">
    <Say voice="${voiceName}">${escapedMenuMessage}</Say>
  </Gather>
  <Say voice="${voiceName}">We didn't receive a selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }
  }

  // No user, department, or IVR assignment - reject
  console.log('Phone number not assigned to user, department, or IVR - rejecting');
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}

async function handleIncomingCall(payload: any) {
  const toNumber = payload?.to;
  const fromNumber = payload?.from;
  const callControlId = payload?.call_control_id;
  const telnyxApiKey = Deno.env.get('TELNYX_API_KEY')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  console.log('Incoming Telnyx call:', { from: fromNumber, to: toNumber, callControlId });

  const { data: phoneData, error: phoneError } = await supabaseQuery('phone_numbers', {
    select: 'id,assigned_to,is_active,company_name',
    filters: { phone_number: toNumber, provider: 'telnyx' },
    single: true,
  });

  console.log('Phone number lookup:', { phoneData, phoneError });

  if (phoneError || !phoneData || !phoneData.is_active) {
    console.log('Phone number not found or not active, rejecting call');
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cause: 'USER_BUSY' }),
    });
    return new Response(JSON.stringify({ handled: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (phoneData.assigned_to) {
    const userId = phoneData.assigned_to;
    console.log('Routing Telnyx call to user:', userId);

    await supabaseInsert('call_history', {
      user_id: userId,
      from_number: fromNumber,
      to_number: toNumber,
      direction: 'inbound',
      status: 'ringing',
      duration: 0,
      call_sid: callControlId,
    });

    const { data: regData } = await supabaseQuery('telnyx_webrtc_registrations', {
      select: 'sip_username',
      filters: { user_id: userId },
      single: true,
    });

    if (regData?.sip_username) {
      console.log('Found user SIP registration:', regData.sip_username);
      const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
      console.log('Transferring to SIP URI:', sipUri);

      const transferResponse = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: sipUri,
          from: fromNumber,
          caller_id_number: fromNumber,
          caller_id_name: fromNumber,
          webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call`,
          client_state: btoa(JSON.stringify({ userId, fromNumber, toNumber, originalCallControlId: callControlId })),
          custom_headers: [
            { name: 'X-Original-Caller', value: fromNumber },
          ],
        }),
      });

      if (!transferResponse.ok) {
        const errorText = await transferResponse.text();
        console.error('Transfer to WebRTC error:', errorText);
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call` }),
        });
      } else {
        console.log('Call transferred to WebRTC client');
      }
    } else {
      console.log('No SIP registration found, looking up credentials...');
      const credsResponse = await fetch('https://api.telnyx.com/v2/telephony_credentials', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
      });

      if (credsResponse.ok) {
        const credsData = await credsResponse.json();
        const userCred = credsData.data?.find((c: any) => c.name === `lovable-user-${userId}`);

        if (userCred?.sip_username) {
          console.log('Found user creds in Telnyx:', userCred.sip_username);
          await supabaseUpsert('telnyx_webrtc_registrations', {
            user_id: userId,
            sip_username: userCred.sip_username,
            updated_at: new Date().toISOString(),
          });

          const sipUri = `sip:${userCred.sip_username}@sip.telnyx.com`;
          await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: sipUri,
              from: fromNumber,
              caller_id_number: fromNumber,
              caller_id_name: fromNumber,
              webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call`,
              custom_headers: [
                { name: 'X-Original-Caller', value: fromNumber },
              ],
            }),
          });
        } else {
          console.log('User has no WebRTC credentials, rejecting call');
          await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cause: 'USER_BUSY' }),
          });
        }
      }
    }
  }

  return new Response(JSON.stringify({ handled: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCallAnswered(payload: any) {
  const callControlId = payload?.call_control_id;
  const clientState = payload?.client_state;

  console.log('Call answered event:', { callControlId });

  await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: callControlId });

  if (clientState) {
    try {
      const state = JSON.parse(atob(clientState));
      if (state.originalCallControlId) {
        await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: state.originalCallControlId });
      }
    } catch (e) {
      console.error('Error parsing client state:', e);
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCallHangup(payload: any) {
  const callControlId = payload?.call_control_id;
  const hangupCause = payload?.hangup_cause;
  const duration = payload?.duration_seconds || 0;

  console.log('Call hangup:', { callControlId, hangupCause, duration });

  let status = 'completed';
  if (hangupCause === 'originator_cancel') {
    const { data: callData } = await supabaseQuery('call_history', {
      select: 'status',
      filters: { call_sid: callControlId },
      single: true,
    });
    if (callData?.status === 'ringing') status = 'missed';
  } else if (hangupCause === 'user_busy') {
    status = 'busy';
  } else if (hangupCause === 'no_answer' || hangupCause === 'timeout') {
    status = 'no-answer';
  }

  await supabaseUpdate('call_history', { status, duration: Math.round(duration) }, { call_sid: callControlId });

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRecordingSaved(payload: any) {
  console.log('=== RECORDING SAVED (telnyx-incoming-call) ===');
  console.log('Full payload:', JSON.stringify(payload, null, 2));

  const callControlId = payload?.call_control_id;
  const recordingUrl = payload?.recording_urls?.mp3;
  const recordingSid = payload?.recording_id;
  const recordingDuration = payload?.recording_duration_ms ? Math.round(payload.recording_duration_ms / 1000) : 0;
  const payloadFrom = payload?.from;
  const payloadTo = payload?.to;

  console.log('Extracted:', { callControlId, recordingUrl, recordingSid, payloadFrom, payloadTo });

  if (!recordingUrl || !recordingSid) {
    console.log('Missing recording URL or SID, skipping');
    return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Try to find the call in call_history
  let { data: callData } = await supabaseQuery('call_history', {
    select: '*',
    filters: { call_sid: callControlId },
    single: true,
  });
  console.log('Primary lookup:', callData ? 'found' : 'not found');

  // Fallback: find most recent inbound call
  if (!callData) {
    console.log('Trying fallback lookup...');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=*&direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      console.log('Fallback result:', fallbackData?.length || 0, 'records');
      if (fallbackData && fallbackData.length > 0) {
        callData = fallbackData[0];
      }
    }
  }

  // Use payload data as fallback for from/to
  const fromNumber = callData?.from_number || payloadFrom || 'unknown';
  const toNumber = callData?.to_number || payloadTo || 'unknown';
  const direction = callData?.direction || 'inbound';
  const userId = callData?.user_id || null;

  console.log('Inserting recording with:', { callControlId, fromNumber, toNumber, direction, userId });
  const insertResult = await supabaseInsert('call_recordings', {
    call_sid: callControlId,
    recording_sid: recordingSid,
    recording_url: recordingUrl,
    duration: recordingDuration,
    from_number: fromNumber,
    to_number: toNumber,
    direction: direction,
    user_id: userId,
  });

  if (insertResult.error) {
    console.error('INSERT FAILED:', insertResult.error);
  } else {
    console.log('=== RECORDING SAVED SUCCESSFULLY ===');
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

// Handle TeXML recording webhook (form-urlencoded format)
async function handleTeXMLRecording(formObj: Record<string, string>) {
  console.log('=== TEXML RECORDING HANDLER ===');
  console.log('Form data:', formObj);

  // TeXML recording webhook fields (Twilio/Telnyx TeXML format)
  const recordingUrl = formObj.RecordingUrl;
  const recordingSid = formObj.RecordingSid || formObj.RecordingId;
  const callSid = formObj.CallSid;
  const recordingDuration = parseInt(formObj.RecordingDuration || '0', 10);
  const fromNumber = formObj.From || 'unknown';
  const toNumber = formObj.To || 'unknown';

  console.log('Extracted:', { recordingUrl, recordingSid, callSid, recordingDuration, fromNumber, toNumber });

  if (!recordingUrl) {
    console.log('No recording URL, skipping');
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Try to find the call in call_history
  let callData: any = null;
  if (callSid) {
    const result = await supabaseQuery('call_history', {
      select: '*',
      filters: { call_sid: callSid },
      single: true,
    });
    callData = result.data;
    console.log('Lookup by CallSid:', callData ? 'found' : 'not found');
  }

  // Fallback: find most recent inbound call
  if (!callData) {
    console.log('Trying fallback lookup...');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=*&direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      console.log('Fallback result:', fallbackData?.length || 0, 'records');
      if (fallbackData && fallbackData.length > 0) {
        callData = fallbackData[0];
      }
    }
  }

  // Use call data or form data for the recording
  const finalFrom = callData?.from_number || fromNumber;
  const finalTo = callData?.to_number || toNumber;
  const direction = callData?.direction || 'inbound';
  const userId = callData?.user_id || null;

  console.log('Inserting TeXML recording:', { callSid, finalFrom, finalTo, direction, userId });

  const insertResult = await supabaseInsert('call_recordings', {
    call_sid: callSid || 'texml-' + Date.now(),
    recording_sid: recordingSid || 'rec-' + Date.now(),
    recording_url: recordingUrl,
    duration: recordingDuration,
    from_number: finalFrom,
    to_number: finalTo,
    direction: direction,
    user_id: userId,
  });

  if (insertResult.error) {
    console.error('INSERT FAILED:', insertResult.error);
  } else {
    console.log('=== TEXML RECORDING SAVED SUCCESSFULLY ===');
  }

  // Return empty TeXML response
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}

// Handle TeXML status callback (form-urlencoded format)
// Updates call_history with status and duration
async function handleTeXMLStatusCallback(formObj: Record<string, string>) {
  const callSid = formObj.CallSid;
  const callStatus = formObj.CallStatus?.toLowerCase();
  const callDuration = parseInt(formObj.CallDuration || formObj.Duration || '0', 10);
  const dialCallStatus = formObj.DialCallStatus?.toLowerCase();

  console.log('TeXML status callback:', { callSid, callStatus, callDuration, dialCallStatus });

  if (!callSid) {
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Map TeXML status to our status values
  let status = 'completed';
  const statusToCheck = dialCallStatus || callStatus;

  switch (statusToCheck) {
    case 'in-progress':
    case 'answered':
      status = 'answered';
      break;
    case 'completed':
      status = 'completed';
      break;
    case 'busy':
      status = 'busy';
      break;
    case 'no-answer':
    case 'noanswer':
      status = 'no-answer';
      break;
    case 'failed':
    case 'canceled':
      status = 'failed';
      break;
    case 'ringing':
      status = 'ringing';
      break;
    default:
      status = statusToCheck || 'completed';
  }

  console.log('Updating call_history:', { callSid, status, duration: callDuration });

  // Update by CallSid
  const updateResult = await supabaseUpdate('call_history',
    { status, duration: callDuration },
    { call_sid: callSid }
  );

  if (updateResult.error) {
    console.log('Update by call_sid failed, trying fallback...');

    // Fallback: find recent inbound call and update it
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=id&direction=eq.inbound&status=eq.ringing&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      if (fallbackData && fallbackData.length > 0) {
        const callId = fallbackData[0].id;
        console.log('Found call via fallback, updating:', callId);

        await fetch(
          `${supabaseUrl}/rest/v1/call_history?id=eq.${callId}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ status, duration: callDuration, call_sid: callSid }),
          }
        );
      }
    }
  } else {
    console.log('Call history updated successfully');
  }

  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}
