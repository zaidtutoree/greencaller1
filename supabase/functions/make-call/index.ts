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
    const twilioPhoneNumber = Deno.env.get('TWILIO_PHONE_NUMBER');

    if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
      throw new Error('Twilio credentials not configured');
    }

    const { toNumber, fromNumber, userId, record } = await req.json();

    if (!toNumber) {
      throw new Error('Phone number is required');
    }

    if (!fromNumber) {
      throw new Error('From number is required');
    }

    // Format phone number to E.164 format
    const formatToE164 = (phone: string): string => {
      // Remove all non-digit characters except leading +
      let cleaned = phone.replace(/[^\d+]/g, '');
      
      // If it starts with 0, assume UK number and replace with +44
      if (cleaned.startsWith('0')) {
        cleaned = '+44' + cleaned.substring(1);
      }
      
      // If it doesn't start with +, add it
      if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
      }
      
      return cleaned;
    };

    const formattedToNumber = formatToE164(toNumber);

    console.log('Initiating call from:', fromNumber, 'to:', formattedToNumber);

    // Create Twilio call
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`;
    
    // Generate unique conference name
    const conferenceName = `call-${Date.now()}-${userId}`;
    
    const supabaseProjectId = Deno.env.get('SUPABASE_URL')?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
    
    const formData = new URLSearchParams();
    formData.append('To', formattedToNumber);
    formData.append('From', fromNumber);
    // Use our TwiML endpoint that creates a conference
    const twimlUrl = `https://${supabaseProjectId}.supabase.co/functions/v1/call-twiml?conferenceName=${conferenceName}`;
    formData.append('Url', twimlUrl);
    formData.append('StatusCallback', `https://${supabaseProjectId}.supabase.co/functions/v1/call-events`);
    formData.append('StatusCallbackMethod', 'POST');
    // Twilio expects multiple StatusCallbackEvent params (not a comma-separated string)
    formData.append('StatusCallbackEvent', 'initiated');
    formData.append('StatusCallbackEvent', 'ringing');
    formData.append('StatusCallbackEvent', 'answered');
    formData.append('StatusCallbackEvent', 'completed');
    // Add recording parameters if requested
    if (record) {
      formData.append('Record', 'true');
      formData.append('RecordingStatusCallback', `https://${supabaseProjectId}.supabase.co/functions/v1/call-events?userId=${userId}&fromNumber=${encodeURIComponent(fromNumber)}&toNumber=${encodeURIComponent(toNumber)}`);
      formData.append('RecordingStatusCallbackEvent', 'completed');
      formData.append('RecordingChannels', 'dual');
    }
    
    const response = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Twilio API error:', errorText);
      throw new Error(`Twilio API error: ${errorText}`);
    }

    const callData = await response.json();
    console.log('Call initiated successfully:', callData);

    // Log call to database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: dbError } = await supabase.from('call_history').insert({
      from_number: fromNumber,
      to_number: toNumber,
      direction: 'outbound',
      user_id: userId,
      status: callData.status,
      duration: 0,
      call_sid: callData.sid,
    });

    if (dbError) {
      console.error('Error logging call to database:', dbError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        callSid: callData.sid,
        conferenceName: conferenceName,
        status: callData.status,
        message: 'Call initiated successfully',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in make-call function:', error);
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
