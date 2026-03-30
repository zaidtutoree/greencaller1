// Function to manually save a recording for inbound calls
// Called by frontend when recording stops or call ends
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
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!telnyxApiKey || !supabaseUrl || !supabaseKey) {
      throw new Error('Missing required environment variables');
    }

    const { callId, userId, fromNumber, toNumber, direction } = await req.json();

    console.log('=== SAVE RECORDING REQUEST ===');
    console.log('Params:', { callId, userId, fromNumber, toNumber, direction });

    if (!callId) {
      throw new Error('callId is required');
    }

    // Fetch recordings for this call from Telnyx
    const recordingsResponse = await fetch(
      `https://api.telnyx.com/v2/recordings?filter[call_control_id]=${encodeURIComponent(callId)}`,
      {
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!recordingsResponse.ok) {
      const errorText = await recordingsResponse.text();
      console.error('Failed to fetch recordings from Telnyx:', errorText);

      // Try alternative endpoint
      const altResponse = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/recordings`,
        {
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!altResponse.ok) {
        throw new Error(`Failed to fetch recordings: ${errorText}`);
      }
    }

    const recordingsData = await recordingsResponse.json();
    console.log('Recordings from Telnyx:', recordingsData);

    const recordings = recordingsData.data || [];

    if (recordings.length === 0) {
      console.log('No recordings found for this call');
      return new Response(
        JSON.stringify({ success: true, message: 'No recordings found', count: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save each recording to call_recordings table
    let savedCount = 0;
    for (const recording of recordings) {
      const recordingUrl = recording.download_urls?.mp3 || recording.recording_urls?.mp3;
      const recordingSid = recording.id || recording.recording_id;
      const recordingDuration = recording.duration_millis
        ? Math.round(recording.duration_millis / 1000)
        : (recording.duration || 0);

      if (!recordingUrl) {
        console.log('Recording has no URL, skipping:', recording);
        continue;
      }

      console.log('Saving recording:', { recordingSid, recordingUrl, recordingDuration });

      // Check if recording already exists
      const checkResponse = await fetch(
        `${supabaseUrl}/rest/v1/call_recordings?recording_sid=eq.${encodeURIComponent(recordingSid)}`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        }
      );

      if (checkResponse.ok) {
        const existing = await checkResponse.json();
        if (existing && existing.length > 0) {
          console.log('Recording already exists, skipping');
          continue;
        }
      }

      // Insert the recording
      const insertResponse = await fetch(`${supabaseUrl}/rest/v1/call_recordings`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          call_sid: callId,
          recording_sid: recordingSid,
          recording_url: recordingUrl,
          duration: recordingDuration,
          from_number: fromNumber || recording.from || 'unknown',
          to_number: toNumber || recording.to || 'unknown',
          direction: direction || 'inbound',
          user_id: userId || null,
        }),
      });

      if (!insertResponse.ok) {
        const errorText = await insertResponse.text();
        console.error('Failed to insert recording:', errorText);
      } else {
        console.log('Recording saved successfully');
        savedCount++;
      }
    }

    console.log('=== SAVE RECORDING COMPLETE ===');
    console.log('Saved', savedCount, 'recordings');

    return new Response(
      JSON.stringify({ success: true, message: `Saved ${savedCount} recordings`, count: savedCount }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in telnyx-save-recording:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
