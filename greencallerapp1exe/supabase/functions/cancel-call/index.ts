import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!twilioAccountSid || !twilioAuthToken) {
      throw new Error('Twilio credentials not configured');
    }

    const { callSid } = await req.json();
    if (!callSid) {
      throw new Error('callSid is required');
    }

    console.log('Canceling call:', callSid);

    // Update the call status to 'canceled' or 'completed' to stop ringing
    const cancelUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls/${callSid}.json`;
    const auth = 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`);

    const response = await fetch(cancelUrl, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'canceled' }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Twilio cancel call error:', errText);
      
      // If call is already completed or doesn't exist, that's fine
      if (errText.includes('is not in-progress') || errText.includes('not found')) {
        console.log('Call already ended or not found, treating as success');
        return new Response(JSON.stringify({ success: true, message: 'Call already ended' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      throw new Error(`Failed to cancel call: ${errText}`);
    }

    const result = await response.json();
    console.log('Call canceled successfully:', result.status);

    return new Response(JSON.stringify({ success: true, status: result.status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error canceling call:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
