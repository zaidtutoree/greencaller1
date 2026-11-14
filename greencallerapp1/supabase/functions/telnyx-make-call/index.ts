import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to format phone number to E.164
function formatToE164(phoneNumber: string): string {
  // Remove all non-digit characters except leading +
  let formatted = phoneNumber.replace(/[^\d+]/g, '');

  // UK numbers starting with 0 -> +44
  if (formatted.startsWith('0') && formatted.length >= 10) {
    formatted = '+44' + formatted.substring(1);
  }
  // US/Canada numbers: 10 digits without country code
  else if (!formatted.startsWith('+') && formatted.length === 10) {
    formatted = '+1' + formatted;
  }
  // US/Canada numbers: 11 digits starting with 1
  else if (!formatted.startsWith('+') && formatted.length === 11 && formatted.startsWith('1')) {
    formatted = '+' + formatted;
  }
  // Add + if missing for other international numbers
  else if (!formatted.startsWith('+') && formatted.length > 10) {
    formatted = '+' + formatted;
  }
  // Fallback: just add + if missing
  else if (!formatted.startsWith('+')) {
    formatted = '+' + formatted;
  }

  console.log(`formatToE164: "${phoneNumber}" -> "${formatted}"`);
  return formatted;
}

async function getOrCreateOutboundVoiceProfileId(telnyxApiKey: string): Promise<string | null> {
  // Try to reuse an existing outbound profile
  const listResp = await fetch('https://api.telnyx.com/v2/outbound_voice_profiles', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (listResp.ok) {
    const data = await listResp.json();
    const first = data?.data?.[0];
    if (first?.id) return first.id;
  }

  // Create one if none exist
  const createResp = await fetch('https://api.telnyx.com/v2/outbound_voice_profiles', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Lovable Outbound Voice Profile',
      traffic_type: 'conversational',
      service_plan: 'global',
    }),
  });

  if (!createResp.ok) {
    const txt = await createResp.text();
    console.error('Failed to create outbound voice profile:', txt);
    return null;
  }

  const data = await createResp.json();
  return data?.data?.id || null;
}

// Ensure the credential connection has the outbound profile (fixes D38 error)
async function ensureCredentialConnectionHasOutboundProfile(
  telnyxApiKey: string,
  outboundProfileId: string
): Promise<void> {
  // List credential connections
  const listResp = await fetch('https://api.telnyx.com/v2/credential_connections', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!listResp.ok) {
    console.error('Failed to list credential connections');
    return;
  }

  const data = await listResp.json();
  const connections = data?.data || [];

  for (const conn of connections) {
    const existingProfileId = conn?.outbound?.outbound_voice_profile_id;
    if (!existingProfileId) {
      console.log(`Patching credential connection ${conn.id} with outbound profile...`);
      const patchResp = await fetch(`https://api.telnyx.com/v2/credential_connections/${conn.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          outbound: {
            outbound_voice_profile_id: outboundProfileId,
          },
          sip_uri_calling_preference: 'unrestricted',
        }),
      });

      if (!patchResp.ok) {
        const txt = await patchResp.text();
        console.error('Failed to patch credential connection:', txt);
      } else {
        console.log('Patched credential connection with outbound profile');
      }
    }
  }
}


serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    if (!telnyxApiKey) throw new Error('Telnyx API key not configured');

    const { toNumber, fromNumber, userId, record = false, setupOnly = false } = await req.json();

    if (!toNumber || !fromNumber || !userId) {
      throw new Error('toNumber, fromNumber, userId are required');
    }

    const formattedTo = formatToE164(toNumber);
    const formattedFrom = formatToE164(fromNumber);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // If setupOnly, just ensure credential connection has outbound voice profile and return
    if (setupOnly) {
      console.log('Setup-only mode: ensuring outbound voice profile is configured');
      try {
        const outboundProfileId = await getOrCreateOutboundVoiceProfileId(telnyxApiKey);
        await ensureCredentialConnectionHasOutboundProfile(telnyxApiKey, outboundProfileId);
      } catch (e) {
        console.warn('Setup-only: non-critical error:', e);
      }
      return new Response(
        JSON.stringify({ success: true, setupOnly: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check subscription status - block if not active or trialing
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('can_make_calls, subscription_status')
      .eq('id', userId)
      .single();

    if (userProfile && userProfile.can_make_calls === false) {
      return new Response(
        JSON.stringify({ error: 'Your subscription does not allow making calls. Please contact your administrator.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get the user's current WebRTC SIP username
    const { data: regData } = await supabase
      .from('telnyx_webrtc_registrations')
      .select('sip_username')
      .eq('user_id', userId)
      .single();

    if (!regData?.sip_username) {
      throw new Error('User has no active Telnyx WebRTC registration');
    }

    const userSipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
    const webhookUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;

    console.log('Making Telnyx Call Control outbound call:', {
      to: formattedTo,
      from: formattedFrom,
      userId,
      userSipUri,
      record,
    });

    // Get outbound voice profile for routing
    const outboundVoiceProfileId = await getOrCreateOutboundVoiceProfileId(telnyxApiKey);
    if (!outboundVoiceProfileId) {
      throw new Error('Outbound Voice Profile is not configured on this Telnyx account.');
    }

    // Ensure credential connections have outbound profile
    await ensureCredentialConnectionHasOutboundProfile(telnyxApiKey, outboundVoiceProfileId);

    // Telnyx Call Control requires `connection_id` to be a Call Control Application ID
    // with a valid webhook_event_url.
    const configuredConnectionId = Deno.env.get('TELNYX_CONNECTION_ID');

    const telnyxFetchJson = async (url: string, init: RequestInit) => {
      const resp = await fetch(url, init);
      const text = await resp.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // ignore
      }
      return { ok: resp.ok, status: resp.status, text, json };
    };

    const getOrCreateCallControlAppId = async (outboundProfileId: string): Promise<string> => {
      // 1) If an app id is configured, validate it and ensure it has the correct webhook URL.
      if (configuredConnectionId) {
        const existing = await telnyxFetchJson(
          `https://api.telnyx.com/v2/call_control_applications/${configuredConnectionId}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${telnyxApiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (existing.ok && existing.json?.data?.id) {
          const currentUrl = existing.json?.data?.webhook_event_url;
          const currentProfileId = existing.json?.data?.outbound_voice_profile_id;

          const updates: Record<string, any> = {};
          if (currentUrl !== webhookUrl) updates.webhook_event_url = webhookUrl;
          if (currentProfileId !== outboundProfileId) updates.outbound_voice_profile_id = outboundProfileId;

          if (Object.keys(updates).length > 0) {
            console.log('Patching configured Call Control app...', { appId: configuredConnectionId, updates, outboundProfileId });

            const patch = await telnyxFetchJson(
              `https://api.telnyx.com/v2/call_control_applications/${configuredConnectionId}`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${telnyxApiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(updates),
              }
            );

            console.log('Patch response:', patch.status, patch.text);

            if (!patch.ok) {
              console.error('Failed to patch Call Control app:', patch.text);
            }
          }

          return configuredConnectionId;
        }

        console.log('TELNYX_CONNECTION_ID is set but is not a valid Call Control App ID.');
      }

      // 2) Reuse an existing Lovable Call Control app that already points to our webhook.
      const list = await telnyxFetchJson('https://api.telnyx.com/v2/call_control_applications', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (list.ok) {
        const apps = list.json?.data || [];
        const match = apps.find((app: any) => app?.webhook_event_url === webhookUrl);
        if (match?.id) {
          console.log('Reusing existing Call Control app with correct webhook:', match.id);

          // Ensure it has the outbound profile
          if (match.outbound_voice_profile_id !== outboundProfileId) {
            console.log('Patching existing Call Control app with outbound profile:', {
              appId: match.id,
              oldProfile: match.outbound_voice_profile_id,
              newProfile: outboundProfileId
            });

            const patch = await telnyxFetchJson(
              `https://api.telnyx.com/v2/call_control_applications/${match.id}`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${telnyxApiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ outbound_voice_profile_id: outboundProfileId }),
              }
            );
            console.log('Patch existing response:', patch.status, patch.text);
          }
          return match.id;
        }
      }

      // 3) Create a new Call Control app with a valid webhook URL + outbound profile.
      const create = await telnyxFetchJson('https://api.telnyx.com/v2/call_control_applications', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          application_name: `Lovable Call Control ${Date.now()}`,
          webhook_event_url: webhookUrl,
          webhook_event_failover_url: webhookUrl,
          webhook_timeout_secs: 25,
          outbound_voice_profile_id: outboundProfileId
        }),
      });

      if (!create.ok) {
        throw new Error(`Failed to create Call Control application: ${create.text}`);
      }

      const appId = create.json?.data?.id;
      if (!appId) throw new Error('Call Control application created but no id returned');

      console.log('Created new Call Control app:', appId);
      return appId;
    };

    const connectionId = await getOrCreateCallControlAppId(outboundVoiceProfileId);

    // Place the outbound PSTN call
    const callResponse = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection_id: connectionId,

        // Workaround for accounts where Call Control Apps can’t persist outbound_voice_profile_id.
        // Telnyx accepts this on call creation and it prevents D38.
        outbound_voice_profile_id: outboundVoiceProfileId,

        to: formattedTo,
        from: formattedFrom,
        webhook_url: webhookUrl,
        webhook_url_method: 'POST',
        answering_machine_detection: 'disabled',
        time_limit_secs: 14400,
        client_state: btoa(JSON.stringify({
          action: 'bridge_to_webrtc',
          userId,
          userSipUri,
          fromNumber: formattedFrom,
          toNumber: formattedTo,
          record,
        })),
      }),
    });

    if (!callResponse.ok) {
      const errorText = await callResponse.text();
      console.error('Telnyx Call Control error:', errorText);
      throw new Error(`Telnyx Call Control error: ${errorText}`);
    }

    const callData = await callResponse.json();
    const callControlId = callData.data?.call_control_id;
    const callLegId = callData.data?.call_leg_id;

    console.log('Telnyx outbound call initiated:', { callControlId, callLegId });

    // Log the call to history
    const { error: insertError } = await supabase
      .from('call_history')
      .insert({
        user_id: userId,
        call_sid: callControlId,
        from_number: formattedFrom,
        to_number: formattedTo,
        direction: 'outbound',
        status: 'initiated',
      });

    if (insertError) {
      console.error('Error inserting call history:', insertError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        callControlId,
        callLegId,
        message: 'Call initiated - will bridge to WebRTC when answered',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error making Telnyx call:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
