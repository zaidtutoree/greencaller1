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

        const { callId, toNumber, fromNumber, action: requestAction } = await req.json();

        // action can be "voicemail" (default) or "decline"
        const callAction = requestAction || 'voicemail';
        console.log('Telnyx send-to-voicemail request:', { callId, toNumber, fromNumber, callAction });

        // Check if the provided callId looks like a valid Telnyx Call Control ID
        const isValidCallControlId = (id: string): boolean => {
            if (!id) return false;
            return id.startsWith('v2:') || id.startsWith('v3:');
        };

        // Check if a value looks like a valid UUID (TeXML CallSid format)
        const isValidUUID = (id: string): boolean => {
            if (!id) return false;
            return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        };

        // If we have a valid callId (UUID from SIP headers or Call Control ID),
        // use it directly — skip expensive DB lookups.
        const hasDirectCallId = callId && (isValidUUID(callId) || isValidCallControlId(callId));

        let callInfo: { call_sid: string; direction: string; status: string } | null = null;

        if (hasDirectCallId) {
            console.log('Using callId provided directly from frontend:', callId);
            // Quick lookup just to get direction/status, but don't block on it
            const { data: directLookup } = await supabaseQuery('call_history', {
                select: 'call_sid,direction,status',
                filters: {
                    call_sid: { op: 'eq', value: callId },
                },
                limit: 1,
            });
            if (directLookup && Array.isArray(directLookup) && directLookup.length > 0) {
                callInfo = directLookup[0];
            } else if (directLookup && !Array.isArray(directLookup) && directLookup.call_sid) {
                callInfo = directLookup;
            }
        } else {
            // Fallback: look up the call by phone numbers
            console.log('No direct callId, looking up by phone numbers...');

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
        }

        // Determine the PSTN Call Control ID to use
        const pstnCallControlId = hasDirectCallId ? callId : (callInfo?.call_sid || callId);
        const isInboundCall = callInfo?.direction === 'inbound' || hasDirectCallId;

        console.log('Call info:', { callInfo, pstnCallControlId, isInboundCall, hasDirectCallId });

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

        // INBOUND TeXML CALLS: Use the Telnyx TeXML API to update the live call.
        // The WebRTC SDK's hangup() alone doesn't terminate the TeXML <Dial> operation,
        // so the caller keeps hearing ringback. We must use the TeXML call update API
        // to redirect the PSTN call directly.

        console.log('Inbound TeXML call - using TeXML call update API');

        // Use call_sid from DB, or fall back to the callId passed from frontend
        // (which may be the PSTN CallSid extracted from SIP headers)
        const texmlCallSid = callInfo?.call_sid || (callId && isValidUUID(callId) ? callId : null);
        console.log('TeXML call SID resolved:', texmlCallSid, '(from DB:', callInfo?.call_sid, ', from frontend:', callId, ')');
        let apiUpdated = false;

        if (texmlCallSid) {
            // Update call_history status
            if (callAction === 'voicemail') {
                console.log('Updating call status to voicemail-requested:', texmlCallSid);
                await supabaseUpdate('call_history', { status: 'voicemail-requested' }, { call_sid: texmlCallSid });
            } else {
                console.log('Updating call status to busy (declined):', texmlCallSid);
                await supabaseUpdate('call_history', { status: 'busy' }, { call_sid: texmlCallSid });
            }

            // Use the Telnyx TeXML Call Update API to redirect the live PSTN call.
            // This immediately terminates the <Dial> and routes the caller.
            let updateTexml: string;
            if (callAction === 'voicemail') {
                const voicemailUrl = `${SUPABASE_URL}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(toNumber || '')}&from=${encodeURIComponent(fromNumber || '')}&callSid=${encodeURIComponent(texmlCallSid)}`;
                updateTexml = `<Response><Redirect>${voicemailUrl}</Redirect></Response>`;
            } else {
                // Decline: reject the PSTN call with busy signal
                // Use <Say> + <Hangup> instead of just <Hangup/> as bare Hangup
                // may not properly terminate calls in mid-Dial state
                updateTexml = `<Response><Say>The person you are calling is unavailable.</Say><Hangup/></Response>`;
            }

            console.log('Calling Telnyx TeXML update API for call:', texmlCallSid);

            try {
                const updateRes = await fetch(`https://api.telnyx.com/v2/texml/calls/${texmlCallSid}/update`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${TELNYX_API_KEY}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: `Twiml=${encodeURIComponent(updateTexml)}`,
                });

                const updateBody = await updateRes.text();
                console.log('TeXML update API response:', updateRes.status, updateBody);
                apiUpdated = updateRes.ok;

                if (!updateRes.ok) {
                    console.error('TeXML update API failed, will fall back to WebRTC hangup only');
                }
            } catch (apiErr) {
                console.error('TeXML update API error:', apiErr);
            }
        } else {
            console.log('No call_sid found - cannot update via API, relying on WebRTC hangup');

            // Fallback: try updating status by phone numbers
            if (toNumber && fromNumber) {
                const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
                const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
                const newStatus = callAction === 'voicemail' ? 'voicemail-requested' : 'busy';

                const updateUrl = `${supabaseUrl}/rest/v1/call_history?to_number=eq.${encodeURIComponent(toNumber)}&from_number=eq.${encodeURIComponent(fromNumber)}&status=in.(ringing,in-progress,answered)&order=created_at.desc&limit=1`;

                await fetch(updateUrl, {
                    method: 'PATCH',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal',
                    },
                    body: JSON.stringify({ status: newStatus }),
                });
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                message: callAction === 'voicemail' ? 'Call redirected to voicemail' : 'Call terminated',
                action: callAction,
                apiUpdated,
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
