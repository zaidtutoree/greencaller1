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

    const { conferenceName } = await req.json();
    if (!conferenceName) throw new Error('conferenceName is required');

    // Find the conference by friendly name
    const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}`;
    const auth = 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`);

    const listRes = await fetch(listUrl, {
      headers: { Authorization: auth },
    });
    if (!listRes.ok) {
      const errText = await listRes.text();
      console.error('Twilio list conferences error:', errText);
      throw new Error('Failed to find conference');
    }
    const listData = await listRes.json();
    const conference = listData.conferences?.[0];
    if (!conference) {
      return new Response(JSON.stringify({ success: true, message: 'Conference already ended' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // End the conference
    const endUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Conferences/${conference.sid}.json`;
    const endRes = await fetch(endUrl, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }),
    });

    if (!endRes.ok) {
      const errText = await endRes.text();
      console.error('Twilio end conference error:', errText);
      
      // If conference is not found (already ended), treat as success
      if (errText.includes('20404') || errText.includes('not found')) {
        console.log('Conference already ended, treating as success');
        return new Response(JSON.stringify({ success: true, message: 'Conference already ended' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      throw new Error('Failed to end conference');
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error ending conference:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
