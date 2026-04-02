import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint that plays hold music and frequently checks if agent has picked up
// If picked up, redirects the call to dial the agent's SIP
serve(async (req) => {
  const url = new URL(req.url);
  const callSid = url.searchParams.get('callSid') || '';
  const iteration = parseInt(url.searchParams.get('iteration') || '0');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    console.log('Hold music requested for call:', callSid, 'iteration:', iteration);

    // Check if this call has been picked up by an agent
    if (callSid) {
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
          // Agent has picked up - get their SIP details and transfer the call
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

          console.log('SIP registration lookup response status:', regResponse.status);

          if (regResponse.ok) {
            const regArr = await regResponse.json();
            const regData = Array.isArray(regArr) && regArr.length > 0 ? regArr[0] : null;
            console.log('SIP registration data:', regData);

            if (regData?.sip_username) {
              const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
              console.log('Agent picked up - transferring call to:', sipUri);

              // Escape caller number for XML
              const callerNumber = (queueData.from_number || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

              // Update queue status to connected
              await fetch(
                `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}`,
                {
                  method: 'PATCH',
                  headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                  },
                  body: JSON.stringify({
                    status: 'connected',
                    connected_at: new Date().toISOString()
                  }),
                }
              );

              // Transfer the call to the agent's SIP endpoint
              const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-call-events`;

              console.log('Returning TeXML to transfer call to agent SIP');

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
            } else {
              console.log('No sip_username found in registration data');
            }
          } else {
            console.log('SIP registration lookup failed:', await regResponse.text());
          }
        }
      }
    }

    // Update last_heartbeat so the frontend knows this caller is still on the line
    if (callSid) {
      await fetch(
        `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ updated_at: new Date().toISOString() }),
        }
      );
    }

    // Not picked up yet - play a short segment and check again quickly
    const nextIteration = iteration + 1;
    const checkUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&iteration=${nextIteration}`;

    // Every 3rd iteration, say the patience message
    const sayMessage = nextIteration % 3 === 0
      ? `<Say voice="Polly.Amy-Neural">Thank you for your patience. An agent will be with you shortly.</Say>`
      : '';

    // Play music for just ~10 seconds (loop=1), then redirect to check again
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="1">https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3</Play>
  ${sayMessage}
  <Redirect>${checkUrl.replace(/&/g, '&amp;')}</Redirect>
</Response>`;

    return new Response(texml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  } catch (error) {
    console.error('Hold music error:', error);
    // ALWAYS return valid TeXML even on error - never let Telnyx show "application error"
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
