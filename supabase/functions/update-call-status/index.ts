// Update call_history status and duration - bypasses RLS
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const { callId, status, duration, direction } = await req.json();

    console.log('Update call status request:', { callId, status, duration, direction });

    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    // Build update data
    const updateData: Record<string, any> = {};
    if (status) updateData.status = status;
    if (duration !== undefined) updateData.duration = duration;

    // First try to update by call_sid
    if (callId) {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(callId)}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=representation' },
          body: JSON.stringify(updateData),
        }
      );

      if (response.ok) {
        const updated = await response.json();
        if (updated && updated.length > 0) {
          console.log('Updated call_history by call_sid:', updated[0].id);
          return new Response(
            JSON.stringify({ success: true, updated: updated[0] }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // Fallback: find recent call by direction and update it
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const searchDir = direction || 'inbound';

    // Find recent call that's not completed
    const searchUrl = `${supabaseUrl}/rest/v1/call_history?direction=eq.${searchDir}&status=neq.completed&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`;

    const searchRes = await fetch(searchUrl, { headers });

    if (searchRes.ok) {
      const calls = await searchRes.json();
      if (calls && calls.length > 0) {
        const callToUpdate = calls[0];
        console.log('Found call to update:', callToUpdate.id, 'current status:', callToUpdate.status);

        const updateRes = await fetch(
          `${supabaseUrl}/rest/v1/call_history?id=eq.${callToUpdate.id}`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=representation' },
            body: JSON.stringify(updateData),
          }
        );

        if (updateRes.ok) {
          const updated = await updateRes.json();
          console.log('Updated call_history:', updated);
          return new Response(
            JSON.stringify({ success: true, updated: updated[0] }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else {
          const errorText = await updateRes.text();
          console.error('Update failed:', errorText);
        }
      } else {
        console.log('No recent calls found to update');
      }
    }

    return new Response(
      JSON.stringify({ success: false, message: 'No call found to update' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
