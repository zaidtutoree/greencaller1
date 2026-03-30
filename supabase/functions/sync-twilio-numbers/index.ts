import "https://deno.land/x/xhr@0.1.0/mod.ts";
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
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!twilioAccountSid || !twilioAuthToken) {
      throw new Error('Twilio credentials not configured');
    }

    console.log('Fetching phone numbers from Twilio...');

    // Fetch phone numbers from Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/IncomingPhoneNumbers.json`;
    
    const response = await fetch(twilioUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Twilio API error:', errorText);
      throw new Error(`Twilio API error: ${errorText}`);
    }

    const twilioData = await response.json();
    console.log('Fetched phone numbers:', twilioData.incoming_phone_numbers?.length || 0);

    // Connect to Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get existing phone numbers from database
    const { data: existingNumbers, error: fetchError } = await supabase
      .from('phone_numbers')
      .select('phone_number');

    if (fetchError) {
      console.error('Error fetching existing numbers:', fetchError);
      throw fetchError;
    }

    const existingPhoneSet = new Set(
      existingNumbers?.map(n => n.phone_number) || []
    );

    // Add new phone numbers that don't exist in database
    const numbersToAdd = twilioData.incoming_phone_numbers
      .filter((num: any) => !existingPhoneSet.has(num.phone_number))
      .map((num: any) => ({
        phone_number: num.phone_number,
        is_active: true,
        provider: 'twilio',
      }));

    if (numbersToAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('phone_numbers')
        .insert(numbersToAdd);

      if (insertError) {
        console.error('Error inserting phone numbers:', insertError);
        throw insertError;
      }

      console.log(`Added ${numbersToAdd.length} new phone numbers`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalFromTwilio: twilioData.incoming_phone_numbers?.length || 0,
        newNumbersAdded: numbersToAdd.length,
        message: numbersToAdd.length > 0 
          ? `Successfully synced ${numbersToAdd.length} new phone numbers`
          : 'All phone numbers are already synced',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in sync-twilio-numbers function:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
