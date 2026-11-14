import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!TELNYX_API_KEY) {
      throw new Error('Missing TELNYX_API_KEY');
    }

    const { callControlId, targetNumber, targetId, targetType, userId } = await req.json();

    console.log('Telnyx transfer call request:', { callControlId, targetNumber, targetId, targetType, userId });

    if (!targetNumber) {
      throw new Error('targetNumber is required');
    }

    // Normalize target number to E.164
    let normalizedTarget = targetNumber.replace(/[\s\-()]/g, '');
    if (!normalizedTarget.startsWith('+')) {
      if (normalizedTarget.length === 10) {
        normalizedTarget = '+1' + normalizedTarget;
      } else if (normalizedTarget.length === 11 && normalizedTarget.startsWith('1')) {
        normalizedTarget = '+' + normalizedTarget;
      } else {
        normalizedTarget = '+' + normalizedTarget;
      }
    }

    // For department queue calls, the caller is in a TeXML call
    // We need to find the active call in call_queue and redirect that call
    // Only attempt this for RECENT queue calls (within last 10 minutes) to avoid stale entries
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && userId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      
      // Find the active call this agent picked up (only recent ones - within 10 minutes)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: activeCall } = await supabase
        .from('call_queue')
        .select('call_sid, from_number, to_number')
        .eq('picked_up_by', userId)
        .eq('status', 'picked_up')
        .gte('picked_up_at', tenMinutesAgo)
        .order('picked_up_at', { ascending: false })
        .limit(1)
        .single();

      if (activeCall?.call_sid) {
        console.log('Found active queue call to transfer:', activeCall);
        
        // For TeXML calls, use the TeXML update endpoint to redirect the caller
        // The Telnyx API expects a URL that returns TwiML, not raw TwiML in the body
        const texmlUpdateUrl = `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(activeCall.call_sid)}/update`;
        
        // Build the URL for our TeXML generator function
        let transferTexmlUrl: string;
        
        if (targetType === 'department') {
          transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=department&targetId=${targetId}&targetNumber=${encodeURIComponent(normalizedTarget)}`;
        } else {
          // For user transfers, check for SIP credentials
          const { data: registration } = await supabase
            .from('telnyx_webrtc_registrations')
            .select('sip_username')
            .eq('user_id', targetId)
            .single();
          
          if (registration?.sip_username) {
            transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=user&sipUsername=${encodeURIComponent(registration.sip_username)}`;
          } else {
            transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=user&targetNumber=${encodeURIComponent(normalizedTarget)}`;
          }
        }

        console.log('Updating TeXML call with URL redirect:', { url: texmlUpdateUrl, transferUrl: transferTexmlUrl });

        const updateResponse = await fetch(texmlUpdateUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ Url: transferTexmlUrl, Method: 'POST' }),
        });

        if (!updateResponse.ok) {
          const errorText = await updateResponse.text();
          console.error('TeXML update failed:', errorText);
          // Don't throw here - fall through to Call Control API for direct calls
          console.log('TeXML update failed, falling back to Call Control API');
        } else {
          const updateData = await updateResponse.json();
          console.log('TeXML call updated successfully:', updateData);

          // Update the call queue status
          await supabase
            .from('call_queue')
            .update({ status: 'transferred' })
            .eq('call_sid', activeCall.call_sid);

          return new Response(
            JSON.stringify({
              success: true,
              message: `Call transferred to ${normalizedTarget}`,
              data: updateData,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }
      } else {
        console.log('No recent queue call found for user, checking call_history for a recent inbound TeXML callSid');

        // Direct-to-user inbound calls (not queued) still record callSid in call_history.
        // Use that as the TeXML call identifier so we don't depend on the WebRTC UUID.
        const { data: recentHistoryCall } = await supabase
          .from('call_history')
          .select('call_sid, from_number, to_number, created_at, status')
          .eq('user_id', userId)
          .eq('direction', 'inbound')
          .gte('created_at', tenMinutesAgo)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (recentHistoryCall?.call_sid && recentHistoryCall.call_sid.startsWith('v3:')) {
          console.log('Found recent inbound call in call_history to transfer:', recentHistoryCall);

          const texmlUpdateUrl = `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(recentHistoryCall.call_sid)}/update`;

          let transferTexmlUrl: string;
          if (targetType === 'department') {
            transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=department&targetId=${targetId}&targetNumber=${encodeURIComponent(normalizedTarget)}`;
          } else {
            const { data: registration } = await supabase
              .from('telnyx_webrtc_registrations')
              .select('sip_username')
              .eq('user_id', targetId)
              .single();

            if (registration?.sip_username) {
              transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=user&sipUsername=${encodeURIComponent(registration.sip_username)}`;
            } else {
              transferTexmlUrl = `${SUPABASE_URL}/functions/v1/telnyx-transfer-texml?targetType=user&targetNumber=${encodeURIComponent(normalizedTarget)}`;
            }
          }

          console.log('Updating TeXML call (from call_history) with URL redirect:', { url: texmlUpdateUrl, transferUrl: transferTexmlUrl });

          const updateResponse = await fetch(texmlUpdateUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${TELNYX_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ Url: transferTexmlUrl, Method: 'POST' }),
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('TeXML update (from call_history) failed:', errorText);
            console.log('TeXML update (from call_history) failed, falling back to Call Control API');
          } else {
            const updateData = await updateResponse.json();
            console.log('TeXML call (from call_history) updated successfully:', updateData);

            return new Response(
              JSON.stringify({
                success: true,
                message: `Call transferred to ${normalizedTarget}`,
                data: updateData,
              }),
              {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
          }
        } else {
          console.log('No recent inbound call found in call_history, will try Call Control API');
        }
      }
    }

    // Fallback: If we have a call control ID, try Call Control API transfer
    if (callControlId) {
      const transferUrl = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`;

      const transferPayload = {
        to: normalizedTarget,
      };

      console.log('Initiating Telnyx Call Control transfer:', { url: transferUrl, payload: transferPayload });

      const transferResponse = await fetch(transferUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(transferPayload),
      });

      if (!transferResponse.ok) {
        const errorText = await transferResponse.text();
        console.error('Telnyx transfer failed:', errorText);
        throw new Error(`Telnyx transfer failed: ${errorText}`);
      }

      const transferData = await transferResponse.json();
      console.log('Telnyx transfer successful:', transferData);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Call transferred to ${normalizedTarget}`,
          data: transferData,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    throw new Error('No valid call found to transfer');
  } catch (error: unknown) {
    console.error('Error transferring call:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
