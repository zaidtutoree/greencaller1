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

    const formData = await req.formData();
    const from = formData.get('From') as string;
    const to = formData.get('To') as string;
    const body = formData.get('Body') as string;
    const messageSid = formData.get('MessageSid') as string;

    console.log('Received message:', { from, to, body, messageSid });

    // Find the user assigned to this phone number
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select('assigned_to')
      .eq('phone_number', to)
      .eq('is_active', true)
      .maybeSingle();

    if (phoneError) {
      console.error('Error finding phone number:', phoneError);
    }

    // Store the message in the database
    const { error: dbError } = await supabase.from('messages').insert({
      from_number: from,
      to_number: to,
      message_body: body,
      direction: 'inbound',
      user_id: phoneData?.assigned_to || null,
      status: 'received',
    });

    if (dbError) {
      console.error('Error storing message:', dbError);
    }

    // Return empty TwiML response (no auto-reply)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;

    return new Response(twiml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/xml',
      },
    });
  } catch (error) {
    console.error('Error processing message:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
