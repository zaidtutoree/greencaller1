import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint that plays hold music for callers waiting in department queue.
// Used as Conference waitUrl — Telnyx calls this to get music to play.
// Also updates heartbeat and checks if an agent has picked up.
serve(async (req) => {
  const url = new URL(req.url);
  const callSid = url.searchParams.get('callSid') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    console.log('Hold music requested for call:', callSid);

    if (callSid) {
      // Update heartbeat so frontend knows caller is still on the line
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

        // If caller hung up or call completed, stop
        if (queueData?.status === 'abandoned' || queueData?.status === 'completed') {
          console.log('Call queue status is terminal:', queueData.status);
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            { headers: { 'Content-Type': 'application/xml' } }
          );
        }

        // If agent picked up, transfer the call
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

    // Play hold music — Conference waitUrl loops this automatically
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3</Play>
  <Say voice="Polly.Amy-Neural">Thank you for your patience. An agent will be with you shortly.</Say>
  <Play>https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3</Play>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  } catch (error) {
    console.error('Hold music error:', error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3</Play>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
