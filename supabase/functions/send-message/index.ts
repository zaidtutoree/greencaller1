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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { to, message, userId } = await req.json();

    console.log('Sending message:', { to, message, userId });

    // Get user's assigned phone number
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select('phone_number')
      .eq('assigned_to', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (phoneError || !phoneData) {
      console.error('Error finding phone number:', phoneError);
      throw new Error('No active phone number assigned to user');
    }

    const fromNumber = phoneData.phone_number;

    // Send SMS via Twilio
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN')!;

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
    const auth = btoa(`${twilioAccountSid}:${twilioAuthToken}`);

    const twilioResponse = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: fromNumber,
        Body: message,
      }),
    });

    const twilioData = await twilioResponse.json();

    if (!twilioResponse.ok) {
      console.error('Twilio error:', twilioData);
      throw new Error(twilioData.message || 'Failed to send message via Twilio');
    }

    console.log('Message sent via Twilio:', twilioData.sid);

    // Store message in database
    const { error: dbError } = await supabase.from('messages').insert({
      from_number: fromNumber,
      to_number: to,
      message_body: message,
      direction: 'outbound',
      user_id: userId,
      status: 'sent',
    });

    if (dbError) {
      console.error('Error storing message:', dbError);
    }

    return new Response(
      JSON.stringify({ success: true, messageSid: twilioData.sid }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error sending message:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
