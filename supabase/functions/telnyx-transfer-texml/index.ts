import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Parse incoming TeXML webhook data (Telnyx sends form data when calling this URL)
    const contentType = req.headers.get('content-type') || '';
    let callSid = '';
    let fromNumber = '';
    
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      callSid = formData.get('CallSid')?.toString() || '';
      fromNumber = formData.get('From')?.toString() || '';
    }
    
    const url = new URL(req.url);
    const targetType = url.searchParams.get('targetType');
    const targetId = url.searchParams.get('targetId');
    const targetNumber = url.searchParams.get('targetNumber');
    const sipUsername = url.searchParams.get('sipUsername');
    // Allow passing callSid and fromNumber in query params as fallback
    callSid = callSid || url.searchParams.get('callSid') || '';
    fromNumber = fromNumber || url.searchParams.get('fromNumber') || '';

    console.log('Transfer TeXML request:', { targetType, targetId, targetNumber, sipUsername, callSid, fromNumber });

    let twiml: string;

    if (targetType === 'department' && targetId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      
      // Get department details
      const { data: dept } = await supabase
        .from('departments')
        .select('id, name, company_name')
        .eq('id', targetId)
        .single();

      if (!dept) {
        console.error('Department not found:', targetId);
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">I'm sorry, this department is not available. Goodbye.</Say>
  <Hangup/>
</Response>`;
      } else {
        // Insert transferred call into call_queue for the target department
        if (callSid) {
          const { error: queueError } = await supabase
            .from('call_queue')
            .upsert({
              call_sid: callSid,
              from_number: fromNumber || 'Unknown',
              to_number: targetNumber || 'Unknown',
              department_id: targetId,
              company_name: dept.company_name,
              status: 'waiting',
            }, { onConflict: 'call_sid' });

          if (queueError) {
            console.error('Failed to add transferred call to queue:', queueError);
          } else {
            console.log('Transferred call added to queue:', { callSid, department: dept.name });
          }
        }

        // Redirect caller to hold music which will poll for agent pickup
        const holdMusicUrl = `${SUPABASE_URL}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;
        
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">You are being transferred to ${dept.name}. Please hold while we connect you.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`;
      }
    } else if (sipUsername) {
      // Dial the user's SIP endpoint directly
      const sipUri = `sip:${sipUsername}@sip.telnyx.com`;
      twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="60">
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`;
    } else if (targetNumber) {
      // Dial the phone number directly
      twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="60">
    <Number>${targetNumber}</Number>
  </Dial>
</Response>`;
    } else {
      throw new Error('Invalid transfer parameters');
    }

    console.log('Returning TeXML:', twiml);

    return new Response(twiml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml',
      },
    });
  } catch (error: unknown) {
    console.error('Error generating transfer TeXML:', error);
    
    // Return a TwiML hangup response on error
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Transfer failed. Please try again.</Say>
  <Hangup/>
</Response>`;

    return new Response(errorTwiml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml',
      },
    });
  }
});