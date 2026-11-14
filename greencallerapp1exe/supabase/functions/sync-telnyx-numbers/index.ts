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
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');

    if (!telnyxApiKey) {
      throw new Error('Telnyx API key not configured');
    }

    console.log('Fetching phone numbers from Telnyx...');

    // Fetch phone numbers from Telnyx
    const response = await fetch('https://api.telnyx.com/v2/phone_numbers', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telnyx API error:', errorText);
      throw new Error(`Telnyx API error: ${errorText}`);
    }

    const telnyxData = await response.json();
    const phoneNumbers = telnyxData.data || [];
    console.log('Fetched phone numbers:', phoneNumbers.length);

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
    const numbersToAdd = phoneNumbers
      .filter((num: any) => !existingPhoneSet.has(num.phone_number))
      .map((num: any) => ({
        phone_number: num.phone_number,
        is_active: num.status === 'active',
        provider: 'telnyx',
      }));

    if (numbersToAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('phone_numbers')
        .insert(numbersToAdd);

      if (insertError) {
        console.error('Error inserting phone numbers:', insertError);
        throw insertError;
      }

      console.log(`Added ${numbersToAdd.length} new Telnyx phone numbers`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalFromTelnyx: phoneNumbers.length,
        newNumbersAdded: numbersToAdd.length,
        message: numbersToAdd.length > 0 
          ? `Successfully synced ${numbersToAdd.length} new Telnyx phone numbers`
          : 'All Telnyx phone numbers are already synced',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in sync-telnyx-numbers function:', error);
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
