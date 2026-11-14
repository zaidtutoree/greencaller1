import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Simple JWT creation for Twilio
async function createTwilioJWT(accountSid: string, apiKey: string, apiSecret: string, identity: string) {
  const header = { cty: "twilio-fpa;v=1", typ: "JWT", alg: "HS256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    jti: `${apiKey}-${now}`,
    iss: apiKey,
    sub: accountSid,
    exp: now + 3600,
    grants: {
      identity: identity,
      voice: {
        incoming: { allow: true },
        outgoing: {
          application_sid: Deno.env.get('TWILIO_TWIML_APP_SID')
        }
      }
    }
  };

  const base64url = (obj: any) => {
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };

  const segments = [
    base64url(header),
    base64url(payload)
  ];

  const signingInput = segments.join('.');
  
  const encoder = new TextEncoder();
  const key = encoder.encode(apiSecret);
  const data = encoder.encode(signingInput);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const signatureArray = Array.from(new Uint8Array(signature));
  const signatureBase64 = btoa(String.fromCharCode(...signatureArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${signingInput}.${signatureBase64}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { queueId, userId } = await req.json();
    
    console.log('Pickup call request:', { queueId, userId });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get queue item (accept both 'waiting' and 'ringing' status)
    const { data: queueItem, error: queueError } = await supabase
      .from('call_queue')
      .select('*')
      .eq('id', queueId)
      .in('status', ['waiting', 'ringing'])
      .single();

    if (queueError || !queueItem) {
      console.log('Queue lookup result:', { queueItem, queueError });
      return new Response(JSON.stringify({ error: 'Call not found or already picked up' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update queue status
    const pickedUpAt = new Date().toISOString();
    await supabase
      .from('call_queue')
      .update({
        status: 'picked_up',
        picked_up_by: userId,
        picked_up_at: pickedUpAt
      })
      .eq('id', queueId);

    // Calculate wait time in seconds
    const waitTimeSeconds = Math.round(
      (new Date(pickedUpAt).getTime() - new Date(queueItem.created_at).getTime()) / 1000
    );

    // Insert into call_history for stats tracking
    const { error: historyError } = await supabase
      .from('call_history')
      .insert({
        from_number: queueItem.from_number,
        to_number: queueItem.to_number,
        direction: 'inbound',
        status: 'answered',
        duration: waitTimeSeconds, // Store wait time as duration for now
        user_id: userId
      });

    if (historyError) {
      console.error('Error inserting call history:', historyError);
    }

    // Generate Twilio token directly
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioApiKey = Deno.env.get('TWILIO_API_KEY');
    const twilioApiSecret = Deno.env.get('TWILIO_API_SECRET');

    if (!twilioAccountSid || !twilioApiKey || !twilioApiSecret) {
      throw new Error('Twilio credentials not configured');
    }

    const token = await createTwilioJWT(twilioAccountSid, twilioApiKey, twilioApiSecret, userId);

    // Generate conference name from call_sid
    const conferenceName = `dept-${queueItem.department_id}-${queueItem.call_sid}`;

    console.log('Pickup successful:', { conferenceName, userId });

    return new Response(JSON.stringify({ 
      success: true,
      conferenceName,
      token
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in pickup-call:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
