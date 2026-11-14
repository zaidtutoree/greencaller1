import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Direct Supabase API helpers (no CDN dependencies)
function supabaseHeaders() {
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  } as Record<string, string>;
}

async function supabaseSelectSingle(table: string, select: string, filters: Record<string, string>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  let url = `${supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&`;
  for (const [k, v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;

  const res = await fetch(url, {
    headers: {
      ...supabaseHeaders(),
      Accept: 'application/vnd.pgrst.object+json',
    },
  });

  if (!res.ok) return { data: null as any, errorText: await res.text() };
  return { data: await res.json(), errorText: null as string | null };
}

async function supabaseInsert(table: string, row: any) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) return { errorText: await res.text() };
  return { errorText: null as string | null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Always return "Thank you. Goodbye." TwiML response
  const thankYouResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Thank you for your message. Goodbye.</Say>
  <Hangup/>
</Response>`;

  try {
    const formData = await req.formData();
    const recordingUrl = formData.get('RecordingUrl') as string;
    const recordingSid = formData.get('RecordingSid') as string;
    const recordingDuration = formData.get('RecordingDuration');
    const telnyxFrom = formData.get('From') as string;
    const callSid = formData.get('CallSid') as string;

    const url = new URL(req.url);
    let to = url.searchParams.get('to');

    // Use the original caller's number if passed in URL
    const originalFrom = url.searchParams.get('from');
    const from = originalFrom || telnyxFrom;

    // Normalize phone number - try multiple formats
    let toNormalized = to?.trim() || '';
    if (toNormalized && !toNormalized.startsWith('+')) {
      toNormalized = '+' + toNormalized;
    }

    console.log('Telnyx voicemail callback:', { from, to, toNormalized, recordingSid, recordingUrl, duration: recordingDuration, callSid });

    // If no recording URL or it's empty, just return thank you
    if (!recordingUrl || !toNormalized) {
      console.log('No recording URL or to number - returning thank you response');
      return new Response(thankYouResponse, {
        headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
      });
    }

    // Find the user assigned to this phone number - try with + prefix first
    let { data: phoneData, errorText: phoneError } = await supabaseSelectSingle(
      'phone_numbers',
      'assigned_to',
      { phone_number: toNormalized }
    );

    // If not found, try without + prefix
    if (!phoneData?.assigned_to && toNormalized.startsWith('+')) {
      const toWithoutPlus = toNormalized.substring(1);
      console.log('Trying phone number without + prefix:', toWithoutPlus);
      const result = await supabaseSelectSingle(
        'phone_numbers',
        'assigned_to',
        { phone_number: toWithoutPlus }
      );
      phoneData = result.data;
      phoneError = result.errorText;
    }

    if (phoneError || !phoneData?.assigned_to) {
      console.error('No user found for phone number:', toNormalized, phoneError);
      return new Response(thankYouResponse, {
        headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
      });
    }

    console.log('Found user for phone number:', phoneData.assigned_to);

    // Save voicemail to database immediately with Telnyx's recording URL
    // This is fast because we're not downloading/uploading the recording
    const { errorText } = await supabaseInsert('voicemails', {
      user_id: phoneData.assigned_to,
      from_number: from,
      to_number: toNormalized,
      recording_url: recordingUrl, // Use Telnyx URL directly for fast response
      recording_sid: recordingSid || callSid,
      duration: parseInt(recordingDuration as string) || 0,
      status: 'new',
    });

    if (errorText) {
      console.error('Error saving voicemail:', errorText);
    } else {
      console.log('Voicemail saved successfully for user:', phoneData.assigned_to);
    }

    // Return thank you response immediately
    return new Response(thankYouResponse, {
      headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
    });

  } catch (error) {
    console.error('Error processing Telnyx voicemail:', error);
    // Still return thank you even on error
    return new Response(thankYouResponse, {
      headers: { ...corsHeaders, 'Content-Type': 'application/xml' },
    });
  }
});
