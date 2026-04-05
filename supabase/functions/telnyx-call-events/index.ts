import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function supabaseHeaders() {
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  } as Record<string, string>;
}

async function supabaseSelectSingle(table: string, select: string, filters: Record<string, string>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  let url = `${supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&`;
  for (const [k, v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;

  const res = await fetch(url, {
    headers: {
      ...supabaseHeaders(),
      Accept: 'application/vnd.pgrst.object+json',
    },
  });

  if (!res.ok) return { data: null as any, errorText: await res.text() };
  return { data: await res.json(), errorText: null as string | null };
}

async function supabaseUpdate(table: string, patch: any, filters: Record<string, string>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  let url = `${supabaseUrl}/rest/v1/${table}?`;
  for (const [k, v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) return { errorText: await res.text() };
  return { errorText: null as string | null };
}

async function supabaseInsert(table: string, row: any) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) return { errorText: await res.text() };
  return { errorText: null as string | null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    console.log('Telnyx call events - content-type:', contentType);

    // Handle TeXML-style form-urlencoded webhooks (status callbacks)
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      const formObj: Record<string, string> = {};
      formData.forEach((value, key) => (formObj[key] = value.toString()));
      console.log('Form webhook received on telnyx-call-events:', formObj);
      
      const callSid = formObj.CallSid || formObj.CallControlId;
      const callStatus = formObj.CallStatus;
      const callDurationRaw = formObj.CallDuration;
      const answeredTime = formObj.AnsweredTime;
      const endTime = formObj.EndTime;
      
      if (callSid && callStatus) {
        // Calculate actual talk time (from answered to end) instead of total call duration (includes ring time)
        let actualTalkTime = 0;
        if (answeredTime && endTime && callStatus === 'completed') {
          const answered = new Date(answeredTime).getTime();
          const ended = new Date(endTime).getTime();
          actualTalkTime = Math.round((ended - answered) / 1000);
          console.log('Calculated actual talk time:', { answeredTime, endTime, actualTalkTime, rawDuration: callDurationRaw });
        } else if (callDurationRaw) {
          actualTalkTime = parseInt(callDurationRaw, 10);
        }
        
        console.log('Processing TeXML status callback:', { callSid, callStatus, actualTalkTime, rawDuration: callDurationRaw });
        
        // Map TeXML statuses to our status values
        let status = callStatus;
        if (callStatus === 'completed') {
          status = 'completed';
        } else if (callStatus === 'busy') {
          status = 'busy';
        } else if (callStatus === 'no-answer') {
          status = 'no-answer';
        } else if (callStatus === 'failed') {
          status = 'failed';
        }
        
        const updateData: Record<string, any> = { status };
        if (actualTalkTime > 0) {
          updateData.duration = actualTalkTime;
        }
        
        // Check if voicemail-requested — don't overwrite
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const checkUrl = `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(callSid)}&select=status`;
        const checkRes = await fetch(checkUrl, { headers: supabaseHeaders() });
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if (Array.isArray(checkData) && checkData.length > 0 && checkData[0].status === 'voicemail-requested') {
            console.log('Call is voicemail-requested, skipping status update');
            return new Response(JSON.stringify({ received: true }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        console.log('Updating call_history:', { callSid, updateData });
        const { errorText } = await supabaseUpdate('call_history', updateData, { call_sid: callSid });
        if (errorText) {
          console.error('Failed to update call_history:', errorText);
        }

        // Update call_queue entry to terminal status
        const terminalStatuses = ['completed', 'busy', 'no-answer', 'failed'];
        if (terminalStatuses.includes(status)) {
          // Check current queue status to distinguish: if still 'waiting'/'ringing',
          // the caller hung up before being picked up → mark as 'abandoned'
          const supabaseUrlForQueue = Deno.env.get('SUPABASE_URL')!;
          const queueCheckUrl = `${supabaseUrlForQueue}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&select=status`;
          const queueCheckRes = await fetch(queueCheckUrl, { headers: supabaseHeaders() });
          let queueStatus = (status === 'completed') ? 'completed' : 'abandoned';
          if (queueCheckRes.ok) {
            const queueArr = await queueCheckRes.json();
            if (Array.isArray(queueArr) && queueArr.length > 0) {
              const currentQueueStatus = queueArr[0].status;
              if (currentQueueStatus === 'waiting' || currentQueueStatus === 'ringing') {
                queueStatus = 'abandoned';
                console.log('Caller hung up while still waiting in queue — marking as abandoned');
              }
            }
          }
          await supabaseUpdate('call_queue', { status: queueStatus }, { call_sid: callSid });
          console.log('Updated call_queue status to:', queueStatus);
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const eventType = body.data?.event_type;
    const payload = body.data?.payload;
    const callControlId = payload?.call_control_id;

    console.log('Telnyx call event:', { eventType, callControlId });

    // Decode client_state if present
    const clientStateB64 = payload?.client_state;
    let clientState: any = null;
    if (clientStateB64) {
      try {
        clientState = JSON.parse(atob(clientStateB64));
      } catch {
        // ignore
      }
    }

    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');

    switch (eventType) {
      case 'call.initiated': {
        // Update status to ringing — try matching by call_control_id first
        const { errorText: err1 } = await supabaseUpdate('call_history', { status: 'ringing' }, { call_sid: callControlId });

        // If no match, try by call_leg_id (WebRTC SDK calls store this UUID as call_sid)
        // Also update call_sid to the real Call Control ID so recording works
        const callLegId = payload?.call_leg_id;
        if (callLegId && callLegId !== callControlId) {
          console.log('Trying to map call_leg_id to call_control_id:', callLegId, '->', callControlId);
          await supabaseUpdate('call_history', { status: 'ringing', call_sid: callControlId }, { call_sid: callLegId });
        }
        break;
      }

      case 'call.answered': {
        console.log('Call answered, client_state:', clientState);

        // Pickup flow: when the agent WebRTC leg answers, join it into the existing department conference.
        if (clientState?.action === 'pickup_join_conference' && clientState?.conferenceName && telnyxApiKey) {
          console.log('Pickup WebRTC leg answered, joining conference:', clientState.conferenceName);
          try {
            const joinResp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/conference`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${telnyxApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                call_control_id: callControlId,
                conference_name: clientState.conferenceName,
                start_conference_on_enter: true,
                end_conference_on_exit: true,
                beep_enabled: 'never',
              }),
            });

            if (!joinResp.ok) {
              const txt = await joinResp.text();
              console.error('Failed to join conference for pickup:', txt);
            } else {
              console.log('Pickup leg joined conference successfully');
            }
          } catch (err) {
            console.error('Error joining conference for pickup:', err);
          }
        }
        
        // Bridge to WebRTC user if this is an outbound call
        if (clientState?.action === 'bridge_to_webrtc' && clientState?.userSipUri && telnyxApiKey) {
          console.log('Bridging PSTN call to WebRTC user:', clientState.userSipUri);

          // Look up the credential connection ID from the registration table
          // The PSTN call's connection_id is the Call Control App ID, but to dial
          // a SIP URI we need the Credential Connection ID that the SIP creds are registered under
          let credentialConnectionId = payload?.connection_id; // fallback
          try {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            const regResp = await fetch(
              `${supabaseUrl}/rest/v1/telnyx_webrtc_registrations?user_id=eq.${clientState.userId}&select=credential_connection_id&limit=1`,
              { headers: supabaseHeaders() },
            );

            if (regResp.ok) {
              const regRows = await regResp.json();
              if (regRows?.[0]?.credential_connection_id) {
                credentialConnectionId = regRows[0].credential_connection_id;
                console.log('Using credential connection ID from registration:', credentialConnectionId);
              } else {
                console.warn('No credential_connection_id found in registration, falling back to payload.connection_id:', credentialConnectionId);
              }
            } else {
              console.error('Failed to fetch registration:', await regResp.text());
            }
          } catch (err) {
            console.error('Error looking up credential connection ID:', err);
          }

          // First, dial the WebRTC user to create their call leg
          try {
            const dialResp = await fetch('https://api.telnyx.com/v2/calls', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${telnyxApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                connection_id: credentialConnectionId,
                to: clientState.userSipUri,
                from: clientState.fromNumber || payload?.from,
                webhook_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-call-events`,
                timeout_secs: 30,
                time_limit_secs: 14400,
                client_state: btoa(JSON.stringify({
                  action: 'webrtc_leg',
                  pstnCallControlId: callControlId,
                  bridgedFrom: clientState.toNumber,
                  fromNumber: clientState.fromNumber,
                  toNumber: clientState.toNumber,
                  userId: clientState.userId,
                  record: clientState.record,
                })),
              }),
            });

            if (!dialResp.ok) {
              const errText = await dialResp.text();
              console.error('Failed to dial WebRTC user:', errText);
            } else {
              const dialData = await dialResp.json();
              console.log('WebRTC dial initiated:', dialData.data?.call_control_id);
            }
          } catch (err) {
            console.error('Error dialing WebRTC user:', err);
          }
        }
        
        // If this is the WebRTC leg being answered, bridge it to the PSTN leg immediately
        if (clientState?.action === 'webrtc_leg' && clientState?.pstnCallControlId && telnyxApiKey) {
          console.log('WebRTC leg answered, bridging to PSTN leg:', clientState.pstnCallControlId);
          
          try {
            // Use the bridge command to instantly connect audio (no ringing)
            const bridgeResp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/bridge`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${telnyxApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                call_control_id: clientState.pstnCallControlId,
              }),
            });

            if (!bridgeResp.ok) {
              const errText = await bridgeResp.text();
              console.error('Failed to bridge calls:', errText);
            } else {
              console.log('Successfully bridged WebRTC to PSTN - audio connected instantly');

              // Store bridge info for recording management
              const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

              // Auto-start recording if the dialpad "Record Call" checkbox was ticked
              if (clientState.record) {
                console.log('Auto-record enabled, starting recording on PSTN leg:', clientState.pstnCallControlId);
                try {
                  const recordResp = await fetch(`https://api.telnyx.com/v2/calls/${clientState.pstnCallControlId}/actions/record_start`, {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${telnyxApiKey}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      format: 'mp3',
                      channels: 'dual',
                      status_callback_url: `${supabaseUrl}/functions/v1/telnyx-call-events`,
                    }),
                  });
                  if (!recordResp.ok) {
                    const errText = await recordResp.text();
                    console.error('Auto-record failed:', errText);
                  } else {
                    console.log('Auto-recording started successfully');
                  }
                } catch (recErr) {
                  console.error('Error starting auto-record:', recErr);
                }
              }
              await fetch(`${supabaseUrl}/rest/v1/telnyx_call_bridges`, {
                method: 'POST',
                headers: {
                  ...supabaseHeaders(),
                  Prefer: 'return=minimal',
                },
                body: JSON.stringify({
                  user_id: clientState.userId,
                  webrtc_call_control_id: callControlId,
                  pstn_call_control_id: clientState.pstnCallControlId,
                  from_number: clientState.fromNumber,
                  to_number: clientState.toNumber,
                  status: 'bridged',
                }),
              });
            }
          } catch (err) {
            console.error('Error bridging calls:', err);
          }
        }
        
        await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: callControlId });
        if (clientState?.originalCallControlId) {
          await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: clientState.originalCallControlId });
        }
        if (clientState?.pstnCallControlId) {
          await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: clientState.pstnCallControlId });
        }
        break;
      }

      case 'call.hangup': {
        const hangupCause = payload?.hangup_cause;
        const startTime = payload?.start_time;
        const endTime = payload?.end_time;
        
        // Calculate duration from timestamps
        let duration = 0;
        if (startTime && endTime) {
          const start = new Date(startTime).getTime();
          const end = new Date(endTime).getTime();
          duration = Math.round((end - start) / 1000);
          console.log('Calculated duration from timestamps:', { startTime, endTime, duration });
        }
        
        console.log('Call hangup details:', { callControlId, hangupCause, startTime, endTime, duration, fullPayload: JSON.stringify(payload) });

        let status = 'completed';
        if (hangupCause === 'originator_cancel' || hangupCause === 'normal_clearing') {
          const { data: callData } = await supabaseSelectSingle('call_history', 'status', { call_sid: callControlId });
          if (callData?.status === 'ringing' || callData?.status === 'initiated') status = 'missed';
        } else if (hangupCause === 'user_busy') {
          status = 'busy';
        } else if (hangupCause === 'no_answer' || hangupCause === 'timeout') {
          status = 'no-answer';
        }

        const updateData: Record<string, any> = { status };
        if (duration > 0) {
          updateData.duration = duration;
        }
        
        // Check if voicemail-requested — don't overwrite
        const { data: currentCallData } = await supabaseSelectSingle('call_history', 'status', { call_sid: callControlId });
        if (currentCallData?.status === 'voicemail-requested') {
          console.log('Call is voicemail-requested, skipping status update');
        } else {
          console.log('Updating call_history with:', updateData);
          await supabaseUpdate('call_history', updateData, { call_sid: callControlId });
        }

        // Update call_queue entry to terminal status
        const queueStatus = (status === 'completed') ? 'completed' : 'abandoned';
        await supabaseUpdate('call_queue', { status: queueStatus }, { call_sid: callControlId });
        console.log('Updated call_queue status to:', queueStatus, 'for call:', callControlId);
        break;
      }

      case 'call.recording.saved': {
        const recordingUrl = payload?.recording_urls?.mp3;
        const recordingSid = payload?.recording_id;
        const recordingDuration = payload?.recording_duration_ms ? Math.round(payload.recording_duration_ms / 1000) : 0;
        // Get from/to directly from payload - these should always be present
        const payloadFrom = payload?.from;
        const payloadTo = payload?.to;

        console.log('=== RECORDING SAVED EVENT ===');
        console.log('Full payload:', JSON.stringify(payload, null, 2));
        console.log('Extracted:', { callControlId, recordingUrl, recordingSid, recordingDuration, payloadFrom, payloadTo });

        if (recordingUrl && recordingSid) {
          // Lookup by call_sid
          let { data: callData } = await supabaseSelectSingle('call_history', '*', { call_sid: callControlId });
          console.log('Primary lookup result:', callData ? 'found' : 'not found');

          // Fallback: find most recent inbound call
          if (!callData) {
            console.log('Primary lookup failed, trying fallback...');
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

            const fallbackUrl = `${supabaseUrl}/rest/v1/call_history?select=*&direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`;
            const fallbackRes = await fetch(fallbackUrl, { headers: supabaseHeaders() });

            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json();
              console.log('Fallback lookup result:', fallbackData?.length || 0, 'records');
              if (fallbackData && fallbackData.length > 0) {
                callData = fallbackData[0];
                console.log('Using fallback call:', callData.id);
                await supabaseUpdate('call_history', { call_sid: callControlId }, { id: callData.id });
              }
            }
          }

          // Determine direction from payload or call data
          // If 'from' starts with the Telnyx number pattern or matches assigned numbers, it's outbound
          // Otherwise it's likely inbound
          let direction = callData?.direction || 'inbound';
          let fromNumber = callData?.from_number || payloadFrom || 'unknown';
          let toNumber = callData?.to_number || payloadTo || 'unknown';
          let userId = callData?.user_id || null;

          // If we still don't have user_id, try to find by phone number
          if (!userId && (payloadFrom || payloadTo)) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            // Check if either number is assigned to a user
            const phoneToCheck = direction === 'outbound' ? payloadFrom : payloadTo;
            if (phoneToCheck) {
              const phoneRes = await fetch(
                `${supabaseUrl}/rest/v1/phone_numbers?phone_number=eq.${encodeURIComponent(phoneToCheck)}&select=assigned_to`,
                { headers: supabaseHeaders() }
              );
              if (phoneRes.ok) {
                const phoneData = await phoneRes.json();
                if (phoneData?.[0]?.assigned_to) {
                  userId = phoneData[0].assigned_to;
                  console.log('Found user_id from phone number:', userId);
                }
              }
            }
          }

          console.log('Inserting recording:', { callControlId, direction, fromNumber, toNumber, userId });
          const insertResult = await supabaseInsert('call_recordings', {
            call_sid: callControlId,
            recording_sid: recordingSid,
            recording_url: recordingUrl,
            from_number: fromNumber,
            to_number: toNumber,
            direction: direction,
            duration: recordingDuration,
            user_id: userId,
          });

          if (insertResult.errorText) {
            console.error('INSERT FAILED:', insertResult.errorText);
          } else {
            console.log('=== RECORDING SAVED SUCCESSFULLY ===');
          }

          // Check if this was a voicemail recording - if so, hang up the call
          // Look for a bridge record with voicemail_recording status
          const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
          const bridgeCheckUrl = `${supabaseUrl}/rest/v1/telnyx_call_bridges?pstn_call_control_id=eq.${encodeURIComponent(callControlId)}&select=webrtc_call_control_id,status`;

          const bridgeRes = await fetch(bridgeCheckUrl, {
            headers: supabaseHeaders(),
          });

          if (bridgeRes.ok) {
            const bridgeData = await bridgeRes.json();
            console.log('Bridge data for recording:', bridgeData);

            if (bridgeData && bridgeData.length > 0 && bridgeData[0].status === 'voicemail_recording') {
              console.log('Voicemail recording completed - hanging up both legs');

              // Hang up the PSTN leg (customer)
              if (telnyxApiKey) {
                try {
                  await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${telnyxApiKey}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({})
                  });
                  console.log('PSTN leg hung up');
                } catch (e) {
                  console.log('PSTN leg may already be disconnected');
                }

                // Also hang up the WebRTC leg if it exists
                const webrtcCallControlId = bridgeData[0].webrtc_call_control_id;
                if (webrtcCallControlId) {
                  try {
                    await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(webrtcCallControlId)}/actions/hangup`, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${telnyxApiKey}`,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({})
                    });
                    console.log('WebRTC leg hung up');
                  } catch (e) {
                    console.log('WebRTC leg may already be disconnected');
                  }
                }

                // Update bridge status
                await supabaseUpdate('telnyx_call_bridges',
                  { status: 'voicemail_completed' },
                  { pstn_call_control_id: callControlId }
                );

                // Save as voicemail record too
                if (callData) {
                  await supabaseInsert('voicemails', {
                    user_id: callData.user_id,
                    from_number: callData.direction === 'outbound' ? callData.to_number : callData.from_number,
                    to_number: callData.direction === 'outbound' ? callData.from_number : callData.to_number,
                    recording_url: recordingUrl,
                    duration: payload?.recording_duration_ms ? Math.round(payload.recording_duration_ms / 1000) : 0,
                    status: 'new',
                  });
                  console.log('Voicemail saved to voicemails table');
                }
              }
            }
          }
        }
        break;
      }

      default:
        console.log('Unhandled Telnyx event type:', eventType);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error handling Telnyx call event:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
