import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint that plays hold music and frequently checks if agent has picked up
// If picked up, redirects the call to dial the agent's SIP
// Also acts as a heartbeat: updates updated_at on each iteration so the frontend
// can detect when a caller hangs up (updated_at goes stale).
serve(async (req) => {
  try {
    const url = new URL(req.url);
    const callSid = url.searchParams.get('callSid') || '';
    const iteration = parseInt(url.searchParams.get('iteration') || '0');

    console.log('Hold music requested for call:', callSid, 'iteration:', iteration);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    // Heartbeat: update updated_at so frontend knows the caller is still on the line
    if (callSid) {
      try {
        await fetch(
          `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}&status=in.(waiting,ringing)`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ updated_at: new Date().toISOString() }),
          }
        );
      } catch (e) {
        console.error('Heartbeat update failed:', e);
      }
    }

    // Check if this call has been picked up by an agent
    if (callSid) {
      try {
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
          const queueData = Array.isArray(queueArr) && queueArr.length > 0 ? queueArr[0] : queueArr;
          console.log('Queue status check:', { status: queueData?.status, picked_up_by: queueData?.picked_up_by });

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
              const regData = Array.isArray(regArr) && regArr.length > 0 ? regArr[0] : regArr;
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
                    headers: { ...headers, 'Prefer': 'return=minimal' },
                    body: JSON.stringify({
                      status: 'connected',
                      connected_at: new Date().toISOString()
                    }),
                  }
                );

                // Transfer the call to the agent's SIP endpoint
                const voicemailUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?callSid=${encodeURIComponent(callSid)}`;

                console.log('Returning TeXML to transfer call to agent SIP');

                return new Response(
                  `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Connecting you now.</Say>
  <Dial callerId="${callerNumber}" timeout="60" answerOnBridge="false" action="${voicemailUrl}">
    <Sip>${sipUri}</Sip>
  </Dial>
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

          // Check if call was abandoned (caller hung up) - stop the loop
          if (queueData?.status === 'abandoned' || queueData?.status === 'completed') {
            console.log('Call queue status is terminal:', queueData.status, '- hanging up');
            return new Response(
              `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`,
              { headers: { 'Content-Type': 'application/xml' } }
            );
          }
        }
      } catch (e) {
        console.error('Error checking queue status:', e);
      }
    }

    // Not picked up yet - play a short segment and check again quickly
    const nextIteration = iteration + 1;
    const checkUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&amp;iteration=${nextIteration}`;

    // Every 10th iteration, say the patience message (loops cycle every ~3s)
    const sayMessage = nextIteration % 10 === 0
      ? `<Say voice="Polly.Amy-Neural">Thank you for your patience. An agent will be with you shortly.</Say>`
      : '';

    // Use <Gather> with a short timeout to create a ~3 second loop cycle.
    // Telnyx interrupts the <Play> when the gather timeout expires, cycling the loop quickly.
    // This keeps the heartbeat fresh every ~3 seconds so the frontend detects hang-ups fast.
    const musicUrl = 'https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3';
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayMessage}
  <Gather input="dtmf" timeout="3" action="${checkUrl}" numDigits="1">
    <Play>${musicUrl}</Play>
  </Gather>
  <Redirect>${checkUrl}</Redirect>
</Response>`;

    return new Response(texml, {
      headers: { 'Content-Type': 'application/xml' },
    });

  } catch (error) {
    console.error('Hold music error:', error);
    // Always return valid TeXML even on error - play a short message and try again
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const fallbackUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music`;
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Please continue to hold.</Say>
  <Pause length="3"/>
  <Redirect>${fallbackUrl}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
