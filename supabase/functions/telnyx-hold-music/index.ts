import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// TeXML endpoint that plays hold music in short segments (~4s each).
// Short segments ensure the heartbeat (updated_at) refreshes every ~4-5 seconds.
// When the caller hangs up, the Redirect stops firing and the heartbeat goes stale.
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
    if (callSid) {
      // Update heartbeat every iteration
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

        if (queueData?.status === 'abandoned' || queueData?.status === 'completed') {
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
            { headers: { 'Content-Type': 'application/xml' } }
          );
        }

        if (queueData?.status === 'picked_up' && queueData?.picked_up_by) {
          const regResponse = await fetch(
            `${supabaseUrl}/rest/v1/telnyx_webrtc_registrations?user_id=eq.${encodeURIComponent(queueData.picked_up_by)}&select=sip_username`,
            { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
          );

          if (regResponse.ok) {
            const regArr = await regResponse.json();
            const regData = Array.isArray(regArr) && regArr.length > 0 ? regArr[0] : null;

            if (regData?.sip_username) {
              const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
              const callerNumber = (queueData.from_number || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

              await fetch(
                `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callSid)}`,
                {
                  method: 'PATCH',
                  headers: { ...headers, 'Prefer': 'return=minimal' },
                  body: JSON.stringify({ status: 'connected', connected_at: new Date().toISOString() }),
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

    // Short content per iteration to keep the loop fast (~4 seconds per cycle)
    // This ensures the heartbeat stays fresh and hangup is detected quickly
    const nextIteration = iteration + 1;
    const nextUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&iteration=${nextIteration}`;
    const escapedUrl = nextUrl.replace(/&/g, '&amp;');

    // Alternate between music and messages to keep caller engaged
    let content: string;
    if (nextIteration % 8 === 0) {
      content = `<Say voice="Polly.Amy-Neural">Thank you for your patience. An agent will be with you shortly.</Say>`;
    } else {
      content = `<Pause length="4"/>`;
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${content}
  <Redirect>${escapedUrl}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  } catch (error) {
    console.error('Hold music error:', error);
    const fallbackUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}&iteration=${iteration}`;
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="3"/>
  <Redirect>${fallbackUrl.replace(/&/g, '&amp;')}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
