import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to query Supabase REST API
async function supabaseQuery(table: string, params: {
    select?: string;
    filters?: Record<string, { op: string; value: string }>;
    order?: string;
    limit?: number;
    single?: boolean;
}) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    let url = `${supabaseUrl}/rest/v1/${table}?`;
    if (params.select) url += `select=${encodeURIComponent(params.select)}&`;
    if (params.filters) {
        for (const [key, { op, value }] of Object.entries(params.filters)) {
            url += `${key}=${op}.${encodeURIComponent(value)}&`;
        }
    }
    if (params.order) url += `order=${encodeURIComponent(params.order)}&`;
    if (params.limit) url += `limit=${params.limit}&`;

    const headers: Record<string, string> = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
    };
    if (params.single) headers['Accept'] = 'application/vnd.pgrst.object+json';

    const response = await fetch(url, { headers });
    if (!response.ok) {
        const text = await response.text();
        return { data: null, error: { message: text } };
    }
    return { data: await response.json(), error: null };
}

// Helper to update Supabase REST API
async function supabaseUpdate(table: string, data: Record<string, any>, filters: Record<string, string>) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    let url = `${supabaseUrl}/rest/v1/${table}?`;
    for (const [key, value] of Object.entries(filters)) {
        url += `${key}=eq.${encodeURIComponent(value)}&`;
    }

    const response = await fetch(url, {
        method: 'PATCH',
        headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        return { error: { message: text } };
    }
    return { error: null };
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
        const SUPABASE_URL = Deno.env.get('SUPABASE_URL');

        if (!TELNYX_API_KEY) {
            throw new Error('Missing Telnyx credentials');
        }

        const { callId, webrtcCallId, toNumber, fromNumber, action } = await req.json();

        console.log('Telnyx send-to-voicemail request:', { callId, webrtcCallId, toNumber, fromNumber, action });

        // Check if the provided callId looks like a valid Telnyx Call Control ID
        const isValidCallControlId = (id: string): boolean => {
            if (!id) return false;
            return id.startsWith('v2:') || id.startsWith('v3:');
        };

        // First, look up the call in the database to get more info
        let callInfo: { call_sid: string; direction: string; status: string } | null = null;

        // Try to find an inbound call (to_number = agent's number, from_number = caller)
        let { data: callData } = await supabaseQuery('call_history', {
            select: 'call_sid,direction,status',
            filters: {
                to_number: { op: 'eq', value: toNumber },
                from_number: { op: 'eq', value: fromNumber },
            },
            order: 'created_at.desc',
            limit: 1,
        });

        console.log('Inbound call lookup result:', callData);

        if (callData && Array.isArray(callData) && callData.length > 0) {
            callInfo = callData[0];
        } else if (callData && !Array.isArray(callData) && callData.call_sid) {
            callInfo = callData;
        }

        // If not found, try outbound call (from_number = agent's number, to_number = customer)
        if (!callInfo) {
            const outboundResult = await supabaseQuery('call_history', {
                select: 'call_sid,direction,status',
                filters: {
                    from_number: { op: 'eq', value: toNumber },
                    to_number: { op: 'eq', value: fromNumber },
                },
                order: 'created_at.desc',
                limit: 1,
            });

            console.log('Outbound call lookup result:', outboundResult);

            if (outboundResult.data && Array.isArray(outboundResult.data) && outboundResult.data.length > 0) {
                callInfo = outboundResult.data[0];
            } else if (outboundResult.data && !Array.isArray(outboundResult.data) && outboundResult.data.call_sid) {
                callInfo = outboundResult.data;
            }
        }

        // If still not found, try a broader search
        if (!callInfo) {
            console.log('Trying broader search by agent number only...');
            const broadResult = await supabaseQuery('call_history', {
                select: 'call_sid,direction,status,from_number,to_number',
                filters: {
                    to_number: { op: 'eq', value: toNumber },
                },
                order: 'created_at.desc',
                limit: 5,
            });

            console.log('Broader search result:', broadResult.data);

            if (broadResult.data && Array.isArray(broadResult.data)) {
                for (const call of broadResult.data) {
                    if (call.call_sid && ['ringing', 'in-progress', 'answered'].includes(call.status)) {
                        callInfo = call;
                        console.log('Found call from broader search:', callInfo);
                        break;
                    }
                }
                if (!callInfo && broadResult.data.length > 0 && broadResult.data[0].call_sid) {
                    callInfo = broadResult.data[0];
                    console.log('Using most recent call from broader search:', callInfo);
                }
            }
        }

        // Determine the PSTN Call Control ID to use
        const pstnCallControlId = isValidCallControlId(callId) ? callId : callInfo?.call_sid || callId;
        const isInboundCall = callInfo?.direction === 'inbound';

        console.log('Call info:', { callInfo, pstnCallControlId, isInboundCall });

        // Check if this is an outbound bridged call by looking for bridge record
        const { data: bridgeData } = await supabaseQuery('telnyx_call_bridges', {
            select: 'webrtc_call_control_id',
            filters: {
                pstn_call_control_id: { op: 'eq', value: pstnCallControlId },
            },
            limit: 1,
        });

        console.log('Bridge lookup result:', bridgeData);

        let webrtcCallControlId: string | null = null;
        if (bridgeData && Array.isArray(bridgeData) && bridgeData.length > 0) {
            webrtcCallControlId = bridgeData[0].webrtc_call_control_id;
        } else if (bridgeData && !Array.isArray(bridgeData) && bridgeData.webrtc_call_control_id) {
            webrtcCallControlId = bridgeData.webrtc_call_control_id;
        }

        // OUTBOUND BRIDGED CALLS: Have a bridge record with webrtcCallControlId
        // These use Call Control API bridging and need special handling
        if (webrtcCallControlId) {
            console.log('Outbound bridged call detected, webrtcCallControlId:', webrtcCallControlId);

            // For outbound bridged calls, voicemail doesn't make sense conceptually
            // (you called them, they can't leave YOU a voicemail)
            // Return a user-friendly message
            return new Response(
                JSON.stringify({
                    success: false,
                    error: 'Send to voicemail is not available for outbound calls. Please end the call normally.',
                    action: 'not_supported',
                    info: 'Voicemail is for receiving messages from callers. On outbound calls you initiated, the other party cannot leave you a voicemail.'
                }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }

        // DECLINE: Mark as declined and try to hang up the PSTN leg directly
        if (action === 'decline') {
            console.log('Decline action - marking call as declined and hanging up PSTN');

            // Mark in call_history as declined/missed
            if (callInfo?.call_sid) {
                await supabaseUpdate('call_history', { status: 'declined' }, { call_sid: callInfo.call_sid });
            }

            // Try to hang up the PSTN call via Telnyx Call Control API
            if (pstnCallControlId && isValidCallControlId(pstnCallControlId)) {
                try {
                    const hangupRes = await fetch(
                        `https://api.telnyx.com/v2/calls/${encodeURIComponent(pstnCallControlId)}/actions/hangup`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${TELNYX_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({}),
                        }
                    );
                    console.log('Telnyx hangup PSTN result:', hangupRes.status);
                } catch (e) {
                    console.error('Error hanging up PSTN via Call Control:', e);
                }
            }

            // Also try to hang up using the TeXML call SID (the parent call)
            if (callInfo?.call_sid && callInfo.call_sid !== pstnCallControlId) {
                try {
                    const hangupRes2 = await fetch(
                        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callInfo.call_sid)}/actions/hangup`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${TELNYX_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({}),
                        }
                    );
                    console.log('Telnyx hangup TeXML call result:', hangupRes2.status);
                } catch (e) {
                    console.error('Error hanging up TeXML call:', e);
                }
            }

            return new Response(
                JSON.stringify({
                    success: true,
                    message: 'Call declined',
                    action: 'declined',
                }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // VOICEMAIL: Use TeXML Call Update API to redirect the PSTN call directly to voicemail.
        // For inbound TeXML calls, callRef.id is a UUID (SIP leg) which the Call Control API
        // doesn't recognize (it expects v2:/v3: format). And callRef.hangup() doesn't work in
        // Electron for unanswered SIP calls.
        // Solution: Use POST /v2/texml/calls/{callSid}/update to redirect the PSTN call
        // to the voicemail TwiML endpoint. This works because callSid IS the TeXML CallSid.
        console.log('Inbound TeXML call - redirecting PSTN call to voicemail via TeXML update');

        const pstnCallSid = callInfo?.call_sid || pstnCallControlId;

        let statusUpdated = false;

        // Step 1: Mark call as voicemail-requested in call_history
        if (callInfo?.call_sid) {
            const result = await supabaseUpdate('call_history', { status: 'voicemail-requested' }, { call_sid: callInfo.call_sid });
            statusUpdated = !result.error;
            console.log('voicemail-requested status update:', statusUpdated ? 'success' : 'failed');
        }

        if (!statusUpdated && toNumber && fromNumber) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
            const updateUrl = `${supabaseUrl}/rest/v1/call_history?to_number=eq.${encodeURIComponent(toNumber)}&from_number=eq.${encodeURIComponent(fromNumber)}&status=in.(ringing,in-progress,answered)&order=created_at.desc&limit=1`;
            const updateRes = await fetch(updateUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                },
                body: JSON.stringify({ status: 'voicemail-requested' }),
            });
            statusUpdated = updateRes.ok;
            console.log('Fallback voicemail-requested update:', statusUpdated ? 'success' : 'failed');
        }

        // Step 2: Redirect the PSTN call to voicemail using TeXML Call Update API
        // This directly interrupts the <Dial> and sends the caller to voicemail
        let redirected = false;

        if (pstnCallSid) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            const voicemailUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(toNumber || '')}&from=${encodeURIComponent(fromNumber || '')}&callSid=${encodeURIComponent(pstnCallSid)}`;

            console.log('Attempting TeXML call update for callSid:', pstnCallSid);

            // Try TeXML Call Update API (POST /v2/texml/calls/{callSid}/update)
            try {
                const updateRes = await fetch(
                    `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(pstnCallSid)}/update`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${TELNYX_API_KEY}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: `Url=${encodeURIComponent(voicemailUrl)}`,
                    }
                );
                console.log('TeXML call update result:', updateRes.status);
                redirected = updateRes.ok;
                if (!redirected) {
                    const errText = await updateRes.text();
                    console.error('TeXML call update failed:', errText);
                }
            } catch (e) {
                console.error('Error with TeXML call update:', e);
            }

            // Fallback: Try Call Control API hangup on the SIP leg
            // If the TeXML update worked, this is harmless. If it didn't, this might help.
            if (!redirected && webrtcCallId) {
                console.log('Fallback: trying Call Control API hangup on SIP leg:', webrtcCallId);
                try {
                    const hangupRes = await fetch(
                        `https://api.telnyx.com/v2/calls/${encodeURIComponent(webrtcCallId)}/actions/hangup`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${TELNYX_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({}),
                        }
                    );
                    console.log('Call Control hangup result:', hangupRes.status);
                    if (hangupRes.ok) redirected = true;
                } catch (e) {
                    console.error('Call Control hangup error:', e);
                }
            }

            // Fallback 2: Try hanging up the PSTN call via Call Control API
            // with the pstn call SID (works if it's a v2:/v3: format ID)
            if (!redirected && isValidCallControlId(pstnCallSid)) {
                console.log('Fallback 2: trying Call Control hangup on PSTN leg:', pstnCallSid);
                try {
                    // Instead of hanging up, try to transfer the PSTN call
                    const hangupRes = await fetch(
                        `https://api.telnyx.com/v2/calls/${encodeURIComponent(pstnCallSid)}/actions/hangup`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${TELNYX_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({}),
                        }
                    );
                    console.log('PSTN Call Control hangup result:', hangupRes.status);
                } catch (e) {
                    console.error('PSTN Call Control hangup error:', e);
                }
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                message: redirected ? 'Call redirected to voicemail' : 'Voicemail requested, frontend will hangup',
                action: 'hangup_for_voicemail',
                statusUpdated,
                redirected,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        console.error('Error sending to voicemail:', error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error.message,
                details: typeof error === 'object' ? JSON.stringify(error) : String(error)
            }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );
    }
});
