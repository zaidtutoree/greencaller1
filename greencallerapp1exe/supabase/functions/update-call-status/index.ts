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

    const { callId, altCallId, status, duration, direction, action, userId, fromNumber, toNumber, table } = await req.json();

    console.log('Update call status request:', { callId, altCallId, status, duration, direction, action, table });

    // Support updating call_queue table (for marking abandoned entries)
    if (table === 'call_queue' && callId && status) {
      const queueRes = await fetch(
        `${supabaseUrl}/rest/v1/call_queue?call_sid=eq.${encodeURIComponent(callId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ status }),
        }
      );
      return new Response(
        JSON.stringify({ success: queueRes.ok }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    // Create a new call history record (for outbound calls initiated via WebRTC SDK)
    if (action === 'create' && callId && userId) {
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/call_history`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          call_sid: callId,
          user_id: userId,
          from_number: fromNumber || 'unknown',
          to_number: toNumber || 'unknown',
          direction: direction || 'outbound',
          status: status || 'initiated',
        }),
      });

      if (insertRes.ok) {
        const inserted = await insertRes.json();
        console.log('Created call_history record:', inserted?.[0]?.id);
        return new Response(
          JSON.stringify({ success: true, created: inserted?.[0] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        const errorText = await insertRes.text();
        console.error('Insert failed:', errorText);
      }
    }

    // Build update data
    const updateData: Record<string, any> = {};
    if (status) updateData.status = status;
    if (duration !== undefined) updateData.duration = duration;

    const terminalStatuses = ['missed', 'no-answer', 'busy', 'failed', 'declined', 'voicemail-requested'];

    // First try to update by call_sid — but guard against overwriting terminal statuses
    if (callId) {
      // Check current status before updating
      const checkRes = await fetch(
        `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(callId)}&select=id,status`,
        { headers }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows?.length > 0 && terminalStatuses.includes(rows[0].status)) {
          console.log('Skipping update — call has terminal status:', rows[0].status);
          return new Response(
            JSON.stringify({ success: false, message: 'Call has terminal status' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

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

    // Try altCallId (original WebRTC UUID) if primary callId didn't match
    if (altCallId && altCallId !== callId) {
      // Terminal status guard for altCallId too
      const altCheckRes = await fetch(
        `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(altCallId)}&select=id,status`,
        { headers }
      );
      if (altCheckRes.ok) {
        const altRows = await altCheckRes.json();
        if (altRows?.length > 0 && terminalStatuses.includes(altRows[0].status)) {
          console.log('Skipping altCallId update — terminal status:', altRows[0].status);
        } else if (altRows?.length > 0) {
          const altResponse = await fetch(
            `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(altCallId)}`,
            {
              method: 'PATCH',
              headers: { ...headers, 'Prefer': 'return=representation' },
              body: JSON.stringify(updateData),
            }
          );
          if (altResponse.ok) {
            const updated = await altResponse.json();
            if (updated && updated.length > 0) {
              console.log('Updated call_history by altCallId:', updated[0].id);
              return new Response(
                JSON.stringify({ success: true, updated: updated[0] }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              );
            }
          }
        }
      }
    }

    // Fallback: find recent call by direction and update it
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const searchDir = direction || 'outbound';

    // Only match active statuses — never overwrite missed/no-answer/declined calls
    const activeStatuses = 'status=in.(initiated,ringing,in-progress)';
    const searchUrl = `${supabaseUrl}/rest/v1/call_history?direction=eq.${searchDir}&${activeStatuses}&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`;

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
