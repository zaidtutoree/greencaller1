import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Direct Supabase API helpers (no CDN dependencies)
function supabaseHeaders() {
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  } as Record<string, string>;
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

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Look up the user's out-of-hours voicemail message by the dialed number.
async function getOutOfHoursMessage(toNumber: string | null): Promise<string | null> {
  if (!toNumber) return null;
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const pnUrl = `${supabaseUrl}/rest/v1/phone_numbers?phone_number=eq.${encodeURIComponent(toNumber)}&select=assigned_to`;
    const pnRes = await fetch(pnUrl, { headers: { ...supabaseHeaders(), Accept: 'application/json' } });
    if (!pnRes.ok) return null;
    const pn = await pnRes.json();
    const userId = Array.isArray(pn) && pn[0]?.assigned_to;
    if (!userId) return null;
    const ohUrl = `${supabaseUrl}/rest/v1/opening_hours?user_id=eq.${encodeURIComponent(userId)}&select=voicemail_message`;
    const ohRes = await fetch(ohUrl, { headers: { ...supabaseHeaders(), Accept: 'application/json' } });
    if (!ohRes.ok) return null;
    const oh = await ohRes.json();
    return (Array.isArray(oh) && oh[0]?.voicemail_message) || null;
  } catch {
    return null;
  }
}

async function safeUpdateCallQueue(callSid: string | null, status: string) {
  if (!callSid) return;
  // call_sid is stored in call_queue for department routing; if no row exists this will no-op
  await supabaseUpdate('call_queue', { status }, { call_sid: callSid });
}

// Check if voicemail was explicitly requested by the agent
async function wasVoicemailRequested(callSid: string | null): Promise<boolean> {
  if (!callSid) return false;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const url = `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(callSid)}&select=status`;

  try {
    const res = await fetch(url, {
      headers: {
        ...supabaseHeaders(),
        Accept: 'application/json',
      },
    });

    if (!res.ok) return false;

    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log('Call status from database:', data[0].status);
      return data[0].status === 'voicemail-requested';
    }
    return false;
  } catch (e) {
    console.error('Error checking voicemail requested status:', e);
    return false;
  }
}

serve(async (req) => {
  console.log('Telnyx Voicemail TwiML handler called, method:', req.method);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const toNumber = url.searchParams.get('to');
    const originalFrom = url.searchParams.get('from');
    const callSid = url.searchParams.get('callSid');
    const deptId = url.searchParams.get('deptId');
    const closed = url.searchParams.get('closed') === '1';
    
    // Parse form data if POST (Telnyx dial action callback)
    let dialCallStatus = '';
    if (req.method === 'POST') {
      try {
        const formData = await req.formData();
        dialCallStatus = (formData.get('DialCallStatus') as string) || '';
        console.log('Dial callback status:', dialCallStatus);
      } catch (e) {
        console.log('No form data in request');
      }
    }
    
    console.log('Telnyx Voicemail TwiML params:', { toNumber, originalFrom, dialCallStatus, callSid, deptId });
    
    // Only offer voicemail for no-answer or failed (timeout scenarios)
    // For completed calls - do NOT update status, let telnyx-call-events handle it
    // For busy (user rejected) - mark as busy and hangup
    // For canceled - just hangup
    
    if (dialCallStatus === 'completed') {
      // Check if voicemail was explicitly requested by the agent (via "Send to Voicemail" button)
      const voicemailRequested = await wasVoicemailRequested(callSid);

      if (voicemailRequested) {
        console.log('Call completed but voicemail was requested - routing to voicemail');
        // Don't return here - fall through to voicemail recording logic below
      } else {
        console.log('Call was answered and completed normally - not going to voicemail');

        // Clean up department queue entry if it exists
        await safeUpdateCallQueue(callSid, 'completed');

        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`,
          { headers: { ...corsHeaders, 'Content-Type': 'application/xml' } }
        );
      }
    }
    
    if (dialCallStatus === 'busy') {
      // In practice, Telnyx reports 'busy' for several SIP-level failures (including
      // unreachable/invalid registrations). Hanging up here creates the "rings then drops"
      // experience. Prefer routing to voicemail so the caller can leave a message.
      console.log('Dial returned busy - routing to voicemail instead of hanging up');
    }
    
    if (dialCallStatus === 'canceled') {
      console.log('Call was canceled - hanging up');

      // Clean up department queue entry if it exists
      await safeUpdateCallQueue(callSid, 'completed');

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`,
        { headers: { ...corsHeaders, 'Content-Type': 'application/xml' } }
      );
    }
    
    // Update call history to missed status since we're going to voicemail
    // But only if it wasn't already set to 'voicemail-requested' (which means agent explicitly sent to voicemail)
    if (callSid && dialCallStatus !== 'completed') {
      console.log('Updating call status to missed for callSid:', callSid);
      await supabaseUpdate('call_history', { status: 'missed' }, { call_sid: callSid });
    } else if (callSid) {
      // For voicemail-requested calls, update to 'voicemail' status
      console.log('Updating call status to voicemail for callSid:', callSid);
      await supabaseUpdate('call_history', { status: 'voicemail' }, { call_sid: callSid });
    }

    // Also mark the department queue record as missed (so it doesn't stay in Live Queue)
    // We don't rely on deptId here because call_sid is unique enough for this flow.
    await safeUpdateCallQueue(callSid, 'missed');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) {
      console.error('SUPABASE_URL not configured');
      throw new Error('SUPABASE_URL not configured');
    }
    
    // Build callback URL with both to and original from numbers
    const callbackParams = new URLSearchParams();
    if (toNumber) callbackParams.set('to', toNumber);
    if (originalFrom) callbackParams.set('from', originalFrom);
    
    const actionUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-callback?${callbackParams.toString()}`.replace(/&/g, '&amp;');
    
    console.log('Generating voicemail TwiML with action URL:', actionUrl);

    // Out-of-hours: play the user's custom message (if set) as the greeting.
    let greeting = 'Please leave a message after the beep. Press hash when finished.';
    if (closed) {
      const custom = await getOutOfHoursMessage(toNumber);
      greeting = xmlEscape(custom || "We're currently closed. Please leave a message after the beep and we'll get back to you during our opening hours.");
    }

    // Generate TwiML for voicemail recording using Polly.Amy-Neural voice
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">${greeting}</Say>
  <Record
    action="${actionUrl}"
    method="POST"
    maxLength="120"
    finishOnKey="#"
    playBeep="true"
  />
  <Say voice="Polly.Amy-Neural">We did not receive a recording. Goodbye.</Say>
</Response>`;

    return new Response(twiml, {
      headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
    });
  } catch (error) {
    console.error('Error generating Telnyx voicemail TwiML:', error);
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">We're sorry, we couldn't take your message right now. Please try again later. Goodbye.</Say>
  <Hangup/>
</Response>`;
    return new Response(errorTwiml, {
      headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
    });
  }
});
