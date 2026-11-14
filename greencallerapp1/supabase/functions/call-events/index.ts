import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

async function supabaseUpdate(table: string, patch: any, filters: Record<string, string>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  let url = `${supabaseUrl}/rest/v1/${table}?`;
  for (const [k, v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) return { errorText: await res.text() };
  return { errorText: null as string | null };
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

  try {
    const formData = await req.formData();
    const callStatus = formData.get('CallStatus') as string;
    const recordingStatus = formData.get('RecordingStatus');
    const callSid = formData.get('CallSid') as string;
    const callDuration = formData.get('CallDuration') as string;

    console.log('Call event:', { callStatus, recordingStatus, callSid, callDuration });

    // Update duration/status on completion
    if (callStatus === 'completed' && callSid) {
      const duration = parseInt(callDuration || '0');

      // Check if already marked missed
      const { data: existingCall } = await supabaseSelectSingle('call_history', 'status,call_sid', { call_sid: callSid });
      const missedStatuses = ['missed', 'no-answer', 'busy', 'failed'];

      if (existingCall && missedStatuses.includes(existingCall.status)) {
        console.log('Call already marked as missed, skipping update:', existingCall.status);
      } else if (existingCall) {
        const { errorText } = await supabaseUpdate('call_history', { duration, status: 'completed' }, { call_sid: callSid });
        if (errorText) console.error('Error updating call duration:', errorText);
      }
    }

    // Recording completion: store metadata directly (no storage proxy) to keep the function CDN-free
    if (recordingStatus === 'completed') {
      const recordingSid = formData.get('RecordingSid') as string;
      const recordingUrl = formData.get('RecordingUrl') as string;
      const recordingDuration = formData.get('RecordingDuration') as string;

      const url = new URL(req.url);
      const userId = url.searchParams.get('userId');
      const fromNumber = url.searchParams.get('fromNumber');
      const toNumber = url.searchParams.get('toNumber');

      console.log('Recording completed:', { callSid, recordingSid, recordingUrl, userId, fromNumber, toNumber });

      const { errorText } = await supabaseInsert('call_recordings', {
        call_sid: callSid,
        recording_sid: recordingSid,
        recording_url: recordingUrl,
        duration: parseInt(recordingDuration || '0'),
        from_number: fromNumber || 'unknown',
        to_number: toNumber || 'unknown',
        direction: 'outbound',
        user_id: userId || null,
      });

      if (errorText) console.error('Error saving recording:', errorText);
    }

    return new Response(null, { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error('Error processing call event:', error);
    return new Response(null, { status: 500, headers: corsHeaders });
  }
});
