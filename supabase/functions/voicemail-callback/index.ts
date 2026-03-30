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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const formData = await req.formData();
    const recordingUrl = formData.get('RecordingUrl') as string;
    const recordingSid = formData.get('RecordingSid') as string;
    const recordingDuration = formData.get('RecordingDuration');
    const twilioFrom = formData.get('From') as string;
    
    const url = new URL(req.url);
    let to = url.searchParams.get('to');
    
    // Use the original caller's number if passed in URL (for mid-call voicemail redirect)
    // Otherwise fall back to Twilio's From header
    const originalFrom = url.searchParams.get('from');
    const from = originalFrom || twilioFrom;
    
    // Normalize phone number - trim whitespace and ensure + prefix
    if (to) {
      to = to.trim();
      if (!to.startsWith('+')) {
        to = '+' + to;
      }
    }

    console.log('Voicemail received:', { from, to, recordingSid, duration: recordingDuration });

    if (!recordingUrl || !recordingSid || !to) {
      throw new Error('Missing required recording data');
    }

    // Find the user assigned to this phone number
    const { data: phoneData } = await supabase
      .from('phone_numbers')
      .select('assigned_to')
      .eq('phone_number', to)
      .single();

    if (!phoneData?.assigned_to) {
      console.error('No user found for phone number:', to);
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
        headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
      });
    }

    // Download recording from Twilio with authentication
    const twilioRecordingUrl = `${recordingUrl}.mp3`;
    console.log('Downloading recording from:', twilioRecordingUrl);
    
    const authHeader = btoa(`${twilioAccountSid}:${twilioAuthToken}`);
    const recordingResponse = await fetch(twilioRecordingUrl, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
      },
    });

    if (!recordingResponse.ok) {
      console.error('Failed to download recording:', recordingResponse.status, await recordingResponse.text());
      throw new Error('Failed to download recording from Twilio');
    }

    const recordingBlob = await recordingResponse.arrayBuffer();
    console.log('Recording downloaded, size:', recordingBlob.byteLength);

    // Upload to Supabase Storage
    const fileName = `voicemails/${phoneData.assigned_to}/${recordingSid}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('call-recordings')
      .upload(fileName, recordingBlob, {
        contentType: 'audio/mpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('Error uploading to storage:', uploadError);
      throw uploadError;
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('call-recordings')
      .getPublicUrl(fileName);

    const publicRecordingUrl = publicUrlData.publicUrl;
    console.log('Recording uploaded to:', publicRecordingUrl);

    // Save voicemail to database with public URL
    const { error } = await supabase
      .from('voicemails')
      .insert({
        user_id: phoneData.assigned_to,
        from_number: from,
        to_number: to,
        recording_url: publicRecordingUrl,
        recording_sid: recordingSid,
        duration: parseInt(recordingDuration as string) || 0,
        status: 'new',
      });

    if (error) {
      console.error('Error saving voicemail:', error);
      throw error;
    }

    console.log('Voicemail saved successfully');

    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  } catch (error) {
    console.error('Error processing voicemail:', error);
    // MUST return 200 with valid TwiML to avoid Twilio "application error" message
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thank you. Goodbye.</Say></Response>', {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    });
  }
});