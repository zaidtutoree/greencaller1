import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const toNumber = url.searchParams.get('to');
    const fromNumber = url.searchParams.get('from');
    
    // Parse form data from Twilio
    const formData = await req.formData();
    const dialCallStatus = formData.get('DialCallStatus') as string;
    const callSid = formData.get('CallSid') as string;
    
    console.log('Call hangup handler:', { callSid, dialCallStatus, toNumber, fromNumber });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Update missed/no-answer/busy calls in call_history using call_sid
    const missedStatuses = ['no-answer', 'busy', 'failed', 'canceled'];
    if (missedStatuses.includes(dialCallStatus) && callSid) {
      const missedStatus = dialCallStatus === 'busy' ? 'busy' : 'missed';
      console.log('Updating call to missed status by callSid:', { callSid, dialCallStatus, missedStatus });
      
      // Update using call_sid for accurate matching
      const { error: updateError } = await supabase
        .from('call_history')
        .update({ 
          status: missedStatus,
          duration: 0
        })
        .eq('call_sid', callSid);
      
      if (updateError) {
        console.error('Error updating missed call:', updateError);
      } else {
        console.log('Missed call updated successfully for callSid:', callSid);
      }
    }

    // Only offer voicemail for no-answer or failed (timeout scenarios)
    // For busy (user rejected) or completed/canceled, just end the call
    const voicemailStatuses = ['no-answer', 'failed'];
    
    if (voicemailStatuses.includes(dialCallStatus)) {
      console.log('Redirecting to voicemail due to status:', dialCallStatus);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${supabaseUrl}/functions/v1/voicemail-twiml?to=${encodeURIComponent(toNumber || '')}&amp;from=${encodeURIComponent(fromNumber || '')}</Redirect>
</Response>`;
      
      return new Response(twiml, {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // For busy (rejected), completed, or canceled calls - just hang up immediately
    console.log('Call ended, hanging up:', dialCallStatus);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

    return new Response(twiml, {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  } catch (error) {
    console.error('Error in call-hangup handler:', error);
    // Always return valid TwiML to avoid Twilio "application error" message
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
    return new Response(errorTwiml, {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  }
});