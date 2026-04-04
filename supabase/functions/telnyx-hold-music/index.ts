import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint that plays hold music and checks if agent has picked up.
// Uses Gather with short timeout to loop every ~3-5 seconds.
// Each loop updates the heartbeat (updated_at) so the frontend can detect caller hangup.
serve(async (req) => {
  const url = new URL(req.url);
  const callSid = url.searchParams.get('callSid') || '';
  const iteration = parseInt(url.searchParams.get('iteration') || '0');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    console.log('Hold music requested for call:', callSid, 'iteration:', iteration);

    if (callSid) {
      // Update heartbeat — frontend uses this to detect when caller hangs up
      await fetch(
        `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
        {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ updated_at: new Date().toISOString() }),
        }
      );

      // Check queue status
      const queueResponse = await fetch(
        `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&select=status,picked_up_by,from_number`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Cache-Control': 'no-cache',
          },
        }
      );

      if (queueResponse.ok) {
        const queueArr = await queueResponse.json();
        const queueData = Array.isArray(queueArr) && queueArr.length > 0 ? queueArr[0] : null;
        console.log('Queue status check:', { status: queueData?.status, picked_up_by: queueData?.picked_up_by });

        // If caller hung up or call completed, stop the hold music loop
        if (queueData?.status === 'abandoned' || queueData?.status === 'completed') {
          console.log('Call queue status is terminal:', queueData.status);
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            { headers: { 'Content-Type': 'application/xml' } }
          );
        }

        if (queueData?.status === 'picked_up' && queueData?.picked_up_by) {
          console.log('Agent picked up! Getting SIP details for user:', queueData.picked_up_by);

          const regResponse = await fetch(
            `${supabaseUrl}/rest/v1/telnyx_webrtc_registrations?user_id=eq.${encodeURIComponent(queueData.picked_up_by)}&select=sip_username`,
            {
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
              },
            }
          );

          if (regResponse.ok) {
            const regArr = await regResponse.json();
            const regData = Array.isArray(regArr) && regArr.length > 0 ? regArr[0] : null;

            if (regData?.sip_username) {
              const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
              console.log('Agent picked up - transferring call to:', sipUri);

              const callerNumber = (queueData.from_number || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

              // Update queue status to connected
              await fetch(
                `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}`,
                {
                  method: 'PATCH',
                  headers: { ...headers, 'Prefer': 'return=minimal' },
                  body: JSON.stringify({
                    status: 'connected',
                    connected_at: new Date().toISOString()
                  }),
                }
              );

              const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;

              return new Response(
                `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Connecting you now.</Say>
  <Dial callerId="${callerNumber}" timeout="60" answerOnBridge="false" statusCallback="${statusCallbackUrl}" statusCallbackEvent="initiated ringing answered completed">
    <Sip>${sipUri}?X-PSTN-Call-Sid=${encodeURIComponent(callSid)}</Sip>
  </Dial>
  <Hangup/>
</Response>`,
                { headers: { 'Content-Type': 'application/xml' } }
              );
            }
          }
        }
      }
    }

    // Not picked up yet — play short music segment then loop back to check again
    const nextIteration = iteration + 1;
    const checkUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&iteration=${nextIteration}`;
    const actionUrl = checkUrl.replace(/&/g, '&amp;');

    // Every 10th iteration, say patience message
    const sayMessage = nextIteration % 10 === 0
      ? `<Say voice="Polly.Amy-Neural">Thank you for your patience. An agent will be with you shortly.</Say>`
      : '';

    // Gather with 3-second timeout loops quickly for fast heartbeat + pickup detection
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayMessage}
  <Gather input="dtmf" timeout="3" action="${actionUrl}" numDigits="1">
    <Play>https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3</Play>
  </Gather>
  <Redirect>${actionUrl}</Redirect>
</Response>`;

    return new Response(texml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  } catch (error) {
    console.error('Hold music error:', error);
    const fallbackUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&iteration=${iteration}`;
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Please continue to hold.</Say>
  <Pause length="3"/>
  <Redirect>${fallbackUrl.replace(/&/g, '&amp;')}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
