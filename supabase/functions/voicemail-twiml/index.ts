import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  console.log('Voicemail TwiML handler called, method:', req.method);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const toNumber = url.searchParams.get('to');
    // Get original caller number if passed (for mid-call voicemail redirect)
    const originalFrom = url.searchParams.get('from');
    
    console.log('Voicemail TwiML params:', { toNumber, originalFrom });
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) {
      console.error('SUPABASE_URL not configured');
      throw new Error('SUPABASE_URL not configured');
    }
    
    // Build callback URL with both to and original from numbers
    const callbackParams = new URLSearchParams();
    if (toNumber) callbackParams.set('to', toNumber);
    if (originalFrom) callbackParams.set('from', originalFrom);
    
    console.log('Generating voicemail TwiML with callback URL:', `${supabaseUrl}/functions/v1/voicemail-callback?${callbackParams.toString()}`);
    
    // Generate TwiML for voicemail recording
    // URL encode the callback params and escape for XML
    const actionUrl = `${supabaseUrl}/functions/v1/voicemail-callback?${callbackParams.toString()}`.replace(/&/g, '&amp;');
    const transcribeUrl = `${supabaseUrl}/functions/v1/voicemail-transcription`;
    
    console.log('Action URL:', actionUrl);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Please leave a message after the beep. Press hash when finished.</Say>
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
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/xml',
      },
    });
  } catch (error) {
    console.error('Error generating voicemail TwiML:', error);
    // Always return valid TwiML even on error to avoid Twilio "application error" message
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">We're sorry, we couldn't take your message right now. Please try again later. Goodbye.</Say>
  <Hangup/>
</Response>`;
    return new Response(errorTwiml, {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  }
});
