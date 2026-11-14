import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── APNs VoIP push (inlined to avoid edge-function shared-folder issues) ─────
const TEXT_ENCODER = new TextEncoder();
let cachedJwt: { token: string; expires: number } | null = null;

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? TEXT_ENCODER.encode(input) : new Uint8Array(input);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importApnsKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function getApnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expires > now + 60) return cachedJwt.token;

  const keyPem = Deno.env.get('APNS_AUTH_KEY');
  const keyId = Deno.env.get('APNS_KEY_ID');
  const teamId = Deno.env.get('APNS_TEAM_ID');
  if (!keyPem || !keyId || !teamId) {
    throw new Error('APNS env vars missing (APNS_AUTH_KEY, APNS_KEY_ID, APNS_TEAM_ID)');
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = base64UrlEncode(JSON.stringify({ iss: teamId, iat: now }));
  const signingInput = `${header}.${claims}`;

  const key = await importApnsKey(keyPem);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    TEXT_ENCODER.encode(signingInput)
  );
  const token = `${signingInput}.${base64UrlEncode(sig)}`;
  cachedJwt = { token, expires: now + 50 * 60 };
  return token;
}

async function sendVoIPPush(opts: {
  deviceToken: string;
  environment: 'sandbox' | 'production';
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; body: string; apnsId?: string }> {
  const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.greencaller.app';
  const jwt = await getApnsJwt();
  const host = opts.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  const url = `${host}/3/device/${opts.deviceToken}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${jwt}`,
      'apns-topic': `${bundleId}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.payload),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: await res.text(),
    apnsId: res.headers.get('apns-id') || undefined,
  };
}
// ──────────────────────────────────────────────────────────────────────────────

// Wake an iOS device by sending a VoIP push directly to APNs.
// Returns true if push was attempted (regardless of APNs response).
async function wakeIOSDevice(userId: string, callContext: {
  callSid: string;
  fromNumber: string;
  toNumber: string;
  callerName?: string;
}): Promise<boolean> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Look up the most recent iOS push token for this user
    // Guard: only wake a phone that still holds a live mobile credential. A
    // device_tokens row can outlive the login that created it (logout never
    // used to delete it), and a push alone makes CallKit ring — so without this
    // check a logged-out or re-assigned iPhone kept ringing for the old
    // account's number. Mirrors the mobile-endpoint expiry check below.
    const regGuardUrl = `${supabaseUrl}/rest/v1/telnyx_webrtc_registrations?user_id=eq.${encodeURIComponent(userId)}&device_type=eq.mobile&select=expires_at&limit=1`;
    const regGuardRes = await fetch(regGuardUrl, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
    });
    if (regGuardRes.ok) {
      const regRows = await regGuardRes.json();
      const reg = Array.isArray(regRows) && regRows.length > 0 ? regRows[0] : null;
      const regExpired = !!(reg?.expires_at && new Date(reg.expires_at).getTime() < Date.now());
      if (!reg || regExpired) {
        console.log('[wakeIOS] No live mobile registration for user, skipping push:', userId);
        return false;
      }
    }

    const tokenUrl = `${supabaseUrl}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(userId)}&platform=eq.ios&order=updated_at.desc&limit=1`;
    const tokenRes = await fetch(tokenUrl, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
    });

    if (!tokenRes.ok) {
      console.log('[wakeIOS] device_tokens query failed:', await tokenRes.text());
      return false;
    }

    const tokens = await tokenRes.json();
    if (!tokens || tokens.length === 0) {
      console.log('[wakeIOS] No iOS device token registered for user:', userId);
      return false;
    }

    const { token, environment } = tokens[0];
    console.log('[wakeIOS] Sending VoIP push, env:', environment, 'token:', token.substring(0, 16) + '...');

    const payload = {
      uuid: callContext.callSid,
      handle: callContext.fromNumber,
      caller_name: callContext.callerName || callContext.fromNumber,
      from: callContext.fromNumber,
      to: callContext.toNumber,
      call_sid: callContext.callSid,
      // Telnyx SDK looks at metadata.voice_sdk_id when processing the push payload
      metadata: {
        voice_sdk_id: callContext.callSid,
        caller_id_number: callContext.fromNumber,
        caller_id_name: callContext.callerName || callContext.fromNumber,
      },
    };

    const result = await sendVoIPPush({
      deviceToken: token,
      environment: (environment === 'sandbox' ? 'sandbox' : 'production'),
      payload,
    });

    console.log('[wakeIOS] APNs response:', {
      ok: result.ok,
      status: result.status,
      body: result.body || '(empty)',
      apnsId: result.apnsId,
    });

    // TEMP DEBUG (remove after background-push diagnosis): edge console logs
    // aren't queryable via tooling, so persist the APNs result to app_logs.
    try {
      await fetch(`${supabaseUrl}/rest/v1/app_logs`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: 'edge-wakeIOS',
          level: result.ok ? 'log' : 'error',
          message: `[wakeIOS-DEBUG] APNs status=${result.status} ok=${result.ok} env=${environment} tokenPrefix=${token.substring(0, 12)} apnsId=${result.apnsId || ''} body=${(result.body || '(empty)').substring(0, 200)}`,
        }),
      });
    } catch (e) {
      console.log('[wakeIOS] debug app_logs insert failed:', e);
    }

    if (!result.ok && result.status === 410) {
      // 410 Gone = token is no longer valid; remove it so we don't retry
      console.log('[wakeIOS] Token invalidated by APNs, deleting');
      await fetch(
        `${supabaseUrl}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(userId)}&token=eq.${encodeURIComponent(token)}`,
        {
          method: 'DELETE',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        }
      );
    }

    return result.ok;
  } catch (e) {
    console.log('[wakeIOS] error:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Send a STANDARD APNs alert push (not VoIP) to a specific device. Used for
// queue alerts so the user sees a lockscreen banner when someone is waiting,
// even when the app is backgrounded or terminated.
async function sendAlertPush(opts: {
  deviceToken: string;
  environment: 'sandbox' | 'production';
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.greencaller.app';
  const jwt = await getApnsJwt();
  const host = opts.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

  const res = await fetch(`${host}/3/device/${opts.deviceToken}`, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${jwt}`,
      // No .voip suffix — alert pushes use the bundle ID as the topic
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts.payload),
  });

  return { ok: res.ok, status: res.status, body: await res.text() };
}

// Send a queue-waiting alert push to every iOS member of a department whose
// device has registered an alert token. Best-effort: errors per-device are
// logged but don't fail the call. Returns the number of pushes attempted.
async function sendQueueAlertToDept(deptId: string, callerNumber: string): Promise<number> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1. Department members
    const membersRes = await fetch(
      `${supabaseUrl}/rest/v1/department_members?department_id=eq.${encodeURIComponent(deptId)}&select=user_id`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    if (!membersRes.ok) {
      console.log('[queueAlert] department_members query failed:', await membersRes.text());
      return 0;
    }
    const members: Array<{ user_id: string }> = await membersRes.json();
    console.log('[queueAlert] dept members found:', members.length, 'for deptId:', deptId);
    if (!members.length) {
      console.log('[queueAlert] No department members for deptId:', deptId);
      return 0;
    }

    // 2. For each member, find their alert token and push
    let attempted = 0;
    let tokensFound = 0;
    for (const m of members) {
      try {
        const tokenRes = await fetch(
          `${supabaseUrl}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(m.user_id)}&platform=eq.ios_alert&order=updated_at.desc&limit=1`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        if (!tokenRes.ok) {
          console.log('[queueAlert] token query failed for user', m.user_id, ':', await tokenRes.text());
          continue;
        }
        const tokens: Array<{ token: string; environment: string }> = await tokenRes.json();
        if (!tokens.length) {
          console.log('[queueAlert] No ios_alert token saved for user', m.user_id, '— rebuild + open app needed');
          continue;
        }
        tokensFound++;

        const { token, environment } = tokens[0];
        const env: 'sandbox' | 'production' = environment === 'sandbox' ? 'sandbox' : 'production';

        const result = await sendAlertPush({
          deviceToken: token,
          environment: env,
          payload: {
            aps: {
              alert: {
                title: 'Greencaller',
                body: `${callerNumber} is waiting in the queue`,
              },
              sound: 'default',
              'thread-id': `queue-${deptId}`,
              // time-sensitive bypasses iOS Focus modes and forces immediate
              // delivery rather than batched/throttled delivery — needed when
              // the app has been backgrounded for a while and iOS would
              // otherwise consider it "low value".
              'interruption-level': 'time-sensitive',
              'relevance-score': 1.0,
            },
            // Custom data so the app can route to the queue tab if user taps the banner
            queueDeptId: deptId,
            from: callerNumber,
          },
        });
        attempted++;
        console.log('[queueAlert] APNs response for user', m.user_id, ':', {
          ok: result.ok, status: result.status, body: result.body || '(empty)',
        });
      } catch (e) {
        console.log('[queueAlert] per-member error:', e instanceof Error ? e.message : String(e));
      }
    }
    return attempted;
  } catch (e) {
    console.log('[queueAlert] outer error:', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

// Helper to make Supabase REST API calls without the client library
async function supabaseQuery(table: string, params: {
  select?: string;
  filters?: Record<string, string>;
  single?: boolean;
}) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let url = `${supabaseUrl}/rest/v1/${table}?`;
  if (params.select) url += `select=${encodeURIComponent(params.select)}&`;
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      url += `${key}=eq.${encodeURIComponent(value)}&`;
    }
  }

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

async function supabaseInsert(table: string, data: Record<string, any>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
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

async function supabaseUpsert(table: string, data: Record<string, any>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
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
    const contentType = req.headers.get('content-type') || '';
    console.log('Incoming request content-type:', contentType);

    // Handle both JSON (Call Control) and form-urlencoded (TeXML) formats
    if (contentType.includes('application/x-www-form-urlencoded')) {
      // TeXML webhook format
      const formData = await req.formData();
      const formObj: Record<string, string> = {};
      formData.forEach((value, key) => {
        formObj[key] = value.toString();
      });
      console.log('TeXML webhook received:', formObj);

      // Check for recording webhook (TeXML format)
      // Recording webhooks have RecordingUrl or RecordingSid
      if (formObj.RecordingUrl || formObj.RecordingSid) {
        console.log('=== TEXML RECORDING WEBHOOK RECEIVED ===');
        return await handleTeXMLRecording(formObj);
      }

      // Check for call status callback (TeXML format).
      // Telnyx sends CallStatus on BOTH the initial inbound ringing webhook
      // AND post-call progress events — we MUST gate this branch on a
      // TERMINAL CallStatus value, otherwise the initial "ringing" webhook
      // gets routed here, returns empty TeXML, and Telnyx hangs up the
      // caller after a brief auto-answer (the "internal call closes
      // immediately" bug).
      const terminalCallStatuses = new Set([
        'completed', 'busy', 'no-answer', 'noanswer', 'failed', 'canceled',
      ]);
      if (
        formObj.CallStatus &&
        formObj.CallSid &&
        terminalCallStatuses.has(formObj.CallStatus.toLowerCase())
      ) {
        console.log('=== TEXML STATUS CALLBACK ===', formObj.CallStatus);
        return await handleTeXMLStatusCallback(formObj);
      }

      // Telnyx TeXML webhooks don't always include CallStatus/Direction.
      // If we have the basic call fields, treat it as an inbound call and return TeXML to route it.
      if (formObj.From && formObj.To && formObj.CallSid) {
        // IVR hand-off: telnyx-ivr-gather <Redirect>s here with ?ivrTo=<user's
        // number> after the caller picks a person. Route exactly as if the
        // caller had dialled that user's number directly (all endpoints ring).
        const ivrTo = new URL(req.url).searchParams.get('ivrTo');
        if (ivrTo) {
          console.log('IVR hand-off: overriding To', formObj.To, '->', ivrTo);
          formObj.To = ivrTo;
        }
        return await handleTeXMLIncoming(formObj);
      }

      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { ...corsHeaders, 'Content-Type': 'application/xml' } }
      );
    } else {
      // Call Control JSON format
      const body = await req.json();
      const eventType = body.data?.event_type;
      const payload = body.data?.payload;

      console.log('Telnyx Call Control webhook:', { eventType, payload });

      if (eventType === 'call.initiated' && payload?.direction === 'incoming') {
        return await handleIncomingCall(payload);
      }

      if (eventType === 'call.answered') {
        return await handleCallAnswered(payload);
      }

      if (eventType === 'call.hangup') {
        return await handleCallHangup(payload);
      }

      // Handle recording.saved event for TeXML calls
      if (eventType === 'call.recording.saved') {
        console.log('Recording saved event received in telnyx-incoming-call');
        return await handleRecordingSaved(payload);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error handling Telnyx incoming call:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function handleTeXMLIncoming(formData: Record<string, string>) {
  const from = formData.From;
  const to = formData.To;
  const callSid = formData.CallSid;

  console.log('TeXML incoming call:', { from, to, callSid });

  // Query phone numbers to find who it's assigned to
  const { data: phoneData, error: phoneError } = await supabaseQuery('phone_numbers', {
    select: 'id,assigned_to,is_active,company_name',
    filters: { phone_number: to, provider: 'telnyx' },
    single: true,
  });

  console.log('Phone number lookup:', { phoneData, phoneError });

  if (phoneError || !phoneData || !phoneData.is_active) {
    console.log('Phone number not found or not active, rejecting call');
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Check if phone is assigned to a specific user first
  if (phoneData.assigned_to) {
    const userId = phoneData.assigned_to;
    console.log('Routing TeXML call to user:', userId);

    // Fire the iOS VoIP push as EARLY as possible — its delivery typically
    // takes 1-3s and we don't need it to complete before doing the DB work
    // below (callback-leg check, call_history insert, desktop SIP lookup).
    // We await this promise later, just before deciding whether to wait
    // for SIP registration. Wrapped in an IIFE with try/catch so it can't
    // throw an unhandled rejection.
    // DISABLED 2026-09-09 — superseded by the fire-and-forget telnyx-wake-ios
    // dispatch further down. `wakeIOSDevice` is left defined but unused so this is
    // a one-line revert if needed.
    //
    // WHY: iOS must report a CallKit call for EVERY VoIP push it receives, and
    // plugins/withVoIP.js calls reportNewIncomingCall() unconditionally with a
    // freshly generated NSUUID (our payload's `uuid` is a "v3:…" CallSid, never a
    // valid NSUUID, so it is always substituted). There is no dedup guard — so N
    // pushes for one phone call produce N separate CallKit calls. Observed live
    // 2026-09-09 20:07: our inline push, our telnyx-wake-ios push and Telnyx's own
    // push all landed; the call rang, but answering one CallKit call left another
    // that iOS then ended — logs show "CallKit end pressed" with no
    // "answer pressed" at all, and the caller was dropped to voicemail.
    //
    // Exactly ONE wake source must fire per call until withVoIP.js derives a stable
    // UUID from the PSTN CallSid and skips duplicate reports (then redundant wake
    // sources become safe again).
    //
    // Returning false here also skips the registration poll below, which is gated on
    // `pushFired`. That poll has never once succeeded in the logs (always
    // "registered=false waitedMs≈1420 maxWait=1200") while calls connected anyway,
    // so it was ~1.4s of pure latency on a webhook that must return fast
    // (.claude/BACKGROUND_ANSWER_CONNECT.md §2).
    // RE-ENABLED 2026-09-09 after empirical testing contradicted the plan to run a
    // single wake source:
    //   all three sources (20:07)  -> app woke
    //   Telnyx push only  (20:41)  -> app did NOT wake
    //   our wake push only (21:02, 21:08, incl. a fresh install) -> app did NOT wake
    // Both single-source configs had APNs return 200 with an apns-id, and app_logs
    // show nothing at all at those timestamps. No mechanism is known for why one
    // push alone fails to wake while several succeed — but the measurements are
    // unambiguous and the working configuration is restored until it is understood.
    //
    // COST: multiple pushes mean multiple CallKit reports for one call (withVoIP.js
    // reports unconditionally with a generated NSUUID and has no dedup). Observed
    // 2026-09-09 20:07 — END on uuid ca7fb1f1 and ANSWER on uuid a2a77257 eleven ms
    // apart; the END handler tore the call down first and the caller went to
    // voicemail. That is a real bug, but it cost one call in five, whereas a single
    // wake source costs every call.
    //
    // PROPER FIX (needs a native build): derive the CallKit UUID from the PSTN
    // CallSid in plugins/withVoIP.js and skip reportNewIncomingCall when that UUID is
    // already active. Redundant wake sources then become harmless and this whole
    // trade-off disappears.
    const earlyMobileSipUsername = Deno.env.get('TELNYX_SIP_USERNAME');
    const pushPromise: Promise<boolean> = (async () => {
      if (!earlyMobileSipUsername) return false;
      try {
        return await wakeIOSDevice(userId, {
          callSid,
          fromNumber: from,
          toNumber: to,
          callerName: from,
        });
      } catch (e) {
        console.log('[wakeIOS] error in early push:', e);
        return false;
      }
    })();

    // Check if this is a callback leg of an outbound SDK call
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    let skipTeXMLInsert = false;
    try {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
      const checkUrl = `${supabaseUrl}/rest/v1/call_history?select=id&user_id=eq.${encodeURIComponent(userId)}&direction=eq.outbound&status=eq.connecting&created_at=gte.${encodeURIComponent(thirtySecondsAgo)}&limit=1`;
      const recentOutboundRes = await fetch(checkUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (recentOutboundRes.ok) {
        const recentOutbound = await recentOutboundRes.json();
        if (recentOutbound && recentOutbound.length > 0) {
          console.log('Skipping TeXML call_history insert — callback leg of active outbound call');
          skipTeXMLInsert = true;
        }
      }
    } catch (e) {
      console.log('Outbound check failed (non-fatal), proceeding with insert:', e);
    }

    if (!skipTeXMLInsert) {
      // Record the inbound call
      await supabaseInsert('call_history', {
        user_id: userId,
        from_number: from,
        to_number: to,
        direction: 'inbound',
        status: 'ringing',
        duration: 0,
        call_sid: callSid,
      });
    }

    // Get the desktop's per-session SIP credentials with freshness check.
    // Now filtered by device_type='web' since the table holds one row per
    // (user_id, device_type) — we don't want this to accidentally pick up
    // the mobile row.
    const { data: regData } = await supabaseQuery('telnyx_webrtc_registrations', {
      select: 'sip_username,updated_at,expires_at',
      filters: { user_id: userId, device_type: 'web' },
      single: true,
    });

    // Mobile SIP: prefer the per-user credential from telnyx_webrtc_registrations
    // (device_type='mobile'). Falls back to the legacy shared TELNYX_SIP_USERNAME
    // env var only if the user hasn't yet been provisioned with a per-user
    // mobile credential — necessary so existing installs keep working until
    // they next launch the updated app and call telnyx-generate-token.
    const { data: mobileRegData } = await supabaseQuery('telnyx_webrtc_registrations', {
      select: 'sip_username,updated_at,expires_at',
      filters: { user_id: userId, device_type: 'mobile' },
      single: true,
    });

    let mobileSipUsername: string | undefined;
    if (mobileRegData?.sip_username) {
      const mExpiresAt = mobileRegData.expires_at ? new Date(mobileRegData.expires_at).getTime() : 0;
      const now = Date.now();
      const mIsExpired = mExpiresAt && mExpiresAt < now;
      // Be lenient with mobile: VoIP push wakes the device on demand,
      // so we don't need a recent SIP REGISTER like desktop does.
      // Only reject if the credential is hard-expired.
      if (!mIsExpired) {
        mobileSipUsername = mobileRegData.sip_username;
        console.log('Using per-user mobile SIP credential for user:', userId, 'username:', mobileSipUsername.substring(0, 12) + '...');
      } else {
        console.log('Per-user mobile SIP credential is expired for user:', userId, '- skipping mobile endpoint');
      }
    } else {
      console.log('No per-user mobile SIP credential for user:', userId, '- skipping mobile endpoint');
    }
    // DELIBERATELY no fallback to TELNYX_SIP_USERNAME env var. That shared
    // credential causes cross-user routing: when an app briefly registers
    // with the shared credential (e.g. during the "No userId" race in
    // CallContext, or a fresh install before per-user provisioning), an
    // INVITE for ANY user routed to that shared credential lands on
    // whoever was last registered. Skip the mobile endpoint entirely if
    // the called user has no valid per-user mobile credential — the call
    // falls through to their web endpoint (if registered) or voicemail.

    // Wake the iOS device via our own APNs VoIP push (telnyx-wake-ios).
    //
    // Telnyx stopped sending its own VoIP push around 2026-07-02 — verified in app_logs:
    // the last payload carrying Telnyx's real `metadata.rtc_ip` is 2026-07-02, and after
    // that background calls only worked while our wake push existed. Without a push, iOS
    // never wakes the app, the <Sip> INVITE below hits a suspended socket, and the caller
    // rings out to voicemail.
    //
    // FIRE AND FORGET — DO NOT `await` THIS.
    // See .claude/BACKGROUND_ANSWER_CONNECT.md §2: this webhook must return its TeXML
    // fast. If it is slow (~8-10s) Telnyx times the webhook out, never dials, and there
    // is no call at all. The push is dispatched here and the response ignored; the wake
    // function logs its own APNs status under [wakeIOS]. A failure there can never
    // delay or break this webhook.
    //
    // Fired as early as possible so the device has the longest possible head start
    // within the TeXML <Dial timeout="60"> window.
    // DISABLED 2026-09-09 — see the CallKit-duplication note above. Exactly ONE wake
    // source may fire per call, and Telnyx's own push was chosen as that source: it
    // recovered on 2026-09-07 (real `VSDK1…` payloads observed again after
    // TELNYX_CONNECTION_ID was pinned to Default Credential Connection 2) and it
    // carries the genuine voice_sdk_id, so the SDK can drive a proper attach_call
    // reconnect — which our push cannot, having no real voice_sdk_id.
    //
    // RE-ENABLED 2026-09-09. Ours is the wake source we want to depend on: Telnyx's
    // own push died silently on 2026-07-02 and stayed dead until 2026-09-07 with no
    // error anywhere — two months of inbound calls going to voicemail. Ours logs an
    // APNs status code on every call, so the same failure would be visible within
    // one call instead of two months.
    //
    // REQUIRES the iOS push credential to be CLEARED from the Telnyx credential
    // connection (3041757718164539203), otherwise Telnyx pushes too, two CallKit
    // calls are reported for one phone call, and answering one leaves another that
    // iOS ends — the answer-then-voicemail bug.
    //   PATCH https://api.telnyx.com/v2/credential_connections/3041757718164539203
    //   {"ios_push_credential_id": null}
    // Leave android_push_credential_id alone.
    //
    // Set WAKE_IOS_ENABLED=false to disable ours again (e.g. to hand the job back to
    // Telnyx's push after re-attaching its credential).
    const WAKE_IOS_ENABLED = Deno.env.get('WAKE_IOS_ENABLED') !== 'false';
    if (WAKE_IOS_ENABLED) {
      try {
        const wakeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-wake-ios`;
        void fetch(wakeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
          body: JSON.stringify({ userId, callSid, fromNumber: from, toNumber: to, callerName: from }),
        }).catch((e) => console.log('[wake] dispatch error (non-fatal):', e?.message || String(e)));
        console.log('[wake] iOS wake push dispatched (not awaited) for user:', userId);
      } catch (e) {
        console.log('[wake] dispatch threw (non-fatal):', e instanceof Error ? e.message : String(e));
      }
    } else {
      console.log('[wake] iOS wake push disabled (WAKE_IOS_ENABLED not set) — relying on Telnyx push');
    }

    // Android mirror of the above (2026-09-23). telnyx-wake-android sends a
    // high-priority FCM data message to the user's platform='android' token;
    // the app's background task posts the full-screen incoming-call notification
    // and the app logs in with attach_call to collect the parked INVITE. Same
    // fire-and-forget contract: nothing here waits on it or can slow the TeXML
    // response. 404 (no Android token) is the normal outcome for iOS-only users.
    // Set WAKE_ANDROID_ENABLED=false to rely on Telnyx's own FCM push alone.
    const WAKE_ANDROID_ENABLED = Deno.env.get('WAKE_ANDROID_ENABLED') !== 'false';
    if (WAKE_ANDROID_ENABLED) {
      try {
        const wakeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-wake-android`;
        void fetch(wakeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
          body: JSON.stringify({ userId, callSid, fromNumber: from, toNumber: to, callerName: from }),
        }).catch((e) => console.log('[wake] android dispatch error (non-fatal):', e?.message || String(e)));
        console.log('[wake] Android wake push dispatched (not awaited) for user:', userId);
      } catch (e) {
        console.log('[wake] android dispatch threw (non-fatal):', e instanceof Error ? e.message : String(e));
      }
    }

    // Build list of SIP endpoints to dial simultaneously
    const sipEndpoints: string[] = [];

    if (regData?.sip_username) {
      // Check if desktop registration is fresh (updated within last 3 minutes)
      const updatedAt = regData.updated_at ? new Date(regData.updated_at).getTime() : 0;
      const now = Date.now();
      const secondsSinceUpdate = (now - updatedAt) / 1000;
      const expiresAt = regData.expires_at ? new Date(regData.expires_at).getTime() : 0;
      const isExpired = expiresAt && expiresAt < now;
      const isStale = secondsSinceUpdate > 180 || isExpired;

      console.log('Desktop registration check:', {
        userId,
        sipUsername: regData.sip_username,
        secondsSinceUpdate: Math.round(secondsSinceUpdate),
        isExpired,
        isStale,
      });

      if (!isStale) {
        // Desktop registration is fresh — add it as an endpoint
        const desktopSipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
        const desktopSipUriWithHeaders = `${desktopSipUri}?X-PSTN-Call-Sid=${encodeURIComponent(callSid)}&amp;X-To-Number=${encodeURIComponent(to)}`;
        sipEndpoints.push(desktopSipUriWithHeaders);
        console.log('Added desktop SIP endpoint:', regData.sip_username);
      } else {
        console.log('Desktop SIP registration is stale, skipping desktop endpoint');
      }
    } else {
      console.log('No desktop SIP registration found for user');
    }

    // Desk phones (Yealink etc.) live on their OWN Telnyx credential connection
    // per phone — see desk_phones. They are deliberately NOT in
    // telnyx_webrtc_registrations, so nothing above can pick them up. A physical
    // phone keeps its own SIP registration alive, so no freshness check: if the
    // row is active we ring it alongside the apps and the first to answer wins.
    // Fully guarded — a user with no desk phone is unaffected.
    try {
      const { data: deskRows } = await supabaseQuery('desk_phones', {
        select: 'sip_username',
        filters: { user_id: userId, is_active: 'true' },
      });
      for (const desk of (Array.isArray(deskRows) ? deskRows : [])) {
        if (!desk?.sip_username) continue;
        if (sipEndpoints.some(uri => uri.includes(desk.sip_username))) continue;
        const deskSipUri = `sip:${desk.sip_username}@sip.telnyx.com?X-PSTN-Call-Sid=${encodeURIComponent(callSid)}&amp;X-To-Number=${encodeURIComponent(to)}`;
        sipEndpoints.push(deskSipUri);
        console.log('Added desk phone SIP endpoint:', desk.sip_username);
      }
    } catch (e) {
      console.log('desk_phones lookup failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }

    // Always add mobile SIP if configured (mobile foreground service keeps WebSocket alive)
    if (mobileSipUsername) {
      const mobileSipUri = `sip:${mobileSipUsername}@sip.telnyx.com`;
      const mobileSipUriWithHeaders = `${mobileSipUri}?X-PSTN-Call-Sid=${encodeURIComponent(callSid)}&amp;X-To-Number=${encodeURIComponent(to)}`;
      // Only add if different from desktop endpoint (avoid duplicate ringing)
      if (!sipEndpoints.some(uri => uri.includes(mobileSipUsername))) {
        sipEndpoints.push(mobileSipUriWithHeaders);
        console.log('Added mobile SIP endpoint:', mobileSipUsername);
      }

      // Await the push that we kicked off earlier (in parallel with DB work).
      // By the time we reach this point, the push has typically been propagating
      // for 1-2s already, so the device is partway-to-fully woken up.
      const pushFired = await pushPromise;
      console.log('[telnyx-incoming-call] iOS push fired:', pushFired);

      // Wait for THIS user's mobile device to wake from the push and re-register
      // before Telnyx dials, so the TeXML <Sip> INVITE doesn't race the reconnect
      // (a dead socket → dial fails → notification shows but never reaches the
      // call screen). We watch the user's OWN mobile row in
      // telnyx_webrtc_registrations: the app upserts it with a fresh updated_at the
      // moment it wakes and fetches its per-user credential (immediately before it
      // SIP-REGISTERs). Exit as soon as updated_at is newer than the baseline read
      // above — a warm/fast wake proceeds in ~1-2s; a cold launch gets the ~5-6s it
      // needs. (The previous poll hit a hardcoded credential-connection id that
      // never reflected per-user gencred… credentials, so it always timed out.)
      if (pushFired) {
        const baselineUpdatedAt = mobileRegData?.updated_at
          ? new Date(mobileRegData.updated_at).getTime()
          : 0;
        const startTime = Date.now();
        // CRITICAL: this whole block must finish FAST. telnyx-incoming-call is a
        // TeXML webhook — Telnyx waits for the <Dial> response, and only AFTER it
        // dials the SIP credential does Telnyx send ITS OWN VoIP push (the one that
        // actually shows the CallKit notification and carries the real
        // voice_sdk_id). If we stall here, Telnyx times the webhook out, never
        // dials, never pushes → NO incoming-call notification at all. A long
        // registration wait (6-8s) broke exactly this. Keep the ceiling small; the
        // device is woken by Telnyx's push regardless of registration state, and
        // the 1s <Pause> in the TeXML covers the reconnect gap.
        const maxWait = 1200;
        let registered = false;

        while (Date.now() - startTime < maxWait) {
          try {
            const { data: freshReg } = await supabaseQuery('telnyx_webrtc_registrations', {
              select: 'updated_at',
              filters: { user_id: userId, device_type: 'mobile' },
              single: true,
            });
            const freshUpdatedAt = freshReg?.updated_at
              ? new Date(freshReg.updated_at).getTime()
              : 0;
            if (freshUpdatedAt > baselineUpdatedAt) {
              registered = true;
              console.log('[telnyx-incoming-call] mobile re-registered after',
                Date.now() - startTime, 'ms');
              break;
            }
          } catch (e) {
            console.log('[telnyx-incoming-call] registration probe error:', e);
          }
          await new Promise((r) => setTimeout(r, 250));
        }

        if (!registered) {
          console.log('[telnyx-incoming-call] proceeding without fresh registration after',
            Date.now() - startTime, 'ms');
        }

        // TEMP DEBUG (remove after diagnosis): did the per-user mobile registration
        // refresh (early-exit) or did we hit the ceiling? Edge console logs aren't
        // queryable, so mirror it to app_logs.
        try {
          const dbgUrl = Deno.env.get('SUPABASE_URL');
          const dbgKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
          if (dbgUrl && dbgKey) {
            await fetch(`${dbgUrl}/rest/v1/app_logs`, {
              method: 'POST',
              headers: { apikey: dbgKey, Authorization: `Bearer ${dbgKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session_id: 'edge-incoming-call',
                level: registered ? 'log' : 'error',
                message: `[reg-poll-DEBUG] registered=${registered} waitedMs=${Date.now() - startTime} maxWait=${maxWait} mobileSip=${mobileSipUsername}`,
              }),
            });
          }
        } catch (_e) { /* best-effort */ }
      }
    }

    console.log('Total SIP endpoints to dial simultaneously:', sipEndpoints.length);

    if (sipEndpoints.length > 0) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const voicemailActionUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(to)}&amp;from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(callSid)}`;
      const statusCallbackUrl = `${supabaseUrl}/functions/v1/telnyx-incoming-call`;

      // Build <Sip> elements for all endpoints — they ring simultaneously
      // First to answer wins, the rest are cancelled
      const sipElements = sipEndpoints.map(uri => `    <Sip>${uri}</Sip>`).join('\n');

      console.log('Dialing', sipEndpoints.length, 'endpoints simultaneously');

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}" timeout="60" answerOnBridge="false" action="${voicemailActionUrl}" statusCallback="${statusCallbackUrl}" statusCallbackEvent="initiated answered completed">
${sipElements}
  </Dial>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    } else {
      console.log('No SIP endpoints available, routing to voicemail');
      await supabaseUpdate('call_history', { status: 'missed' }, { call_sid: callSid });

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const voicemailUrl = `${supabaseUrl}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(to)}&amp;from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(callSid)}`;

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${voicemailUrl}</Redirect>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  // First, check if this phone number is assigned to a department
  // If so, skip IVR and route directly to the department queue
  const { data: deptData, error: deptError } = await supabaseQuery('departments', {
    select: 'id,name,company_name',
    filters: { phone_number_id: phoneData.id },
    single: true,
  });

  console.log('Department lookup:', { deptData, deptError });

  if (deptData) {
    console.log('Phone number assigned to department:', deptData.name, '- routing directly (skipping IVR)');

    // Get IVR voice setting for this company (just for the voice, not the menu)
    const { data: ivrVoice } = await supabaseQuery('ivr_configurations', {
      select: 'voice',
      filters: { company_name: deptData.company_name },
      single: true,
    });
    const voiceName = ivrVoice?.voice || 'Polly.Amy-Neural';

    // Escape department name for XML
    const escapedDeptName = deptData.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Insert into call queue
    await supabaseInsert('call_queue', {
      call_sid: callSid,
      from_number: from,
      to_number: to,
      company_name: deptData.company_name,
      department_id: deptData.id,
      status: 'waiting',
    });

    // Send a lockscreen-capable alert push to every iOS department member.
    // The in-app QUEUE MONITOR handles foreground via notifee; this push
    // handles backgrounded/locked/terminated devices where JS isn't running.
    //
    // Wrapped in EdgeRuntime.waitUntil so Supabase keeps the function alive
    // until APNs has accepted the push — without this, the runtime can
    // tear down as soon as we return the TeXML response below, killing
    // the in-flight fetch to api.push.apple.com and the user never sees
    // the notification when the app was already in background at queue time.
    const queuePushTask = sendQueueAlertToDept(deptData.id, from)
      .then((n) => console.log('[queueAlert] pushes attempted:', n))
      .catch((e) => console.log('[queueAlert] dispatch error:', e instanceof Error ? e.message : String(e)));
    try {
      // @ts-ignore — EdgeRuntime is provided by the Supabase Deno runtime
      if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
        // @ts-ignore
        EdgeRuntime.waitUntil(queuePushTask);
      }
    } catch {}

    // Hold music URL that passes callSid for pickup detection
    const holdMusicUrl = `${supabaseUrl}/functions/v1/telnyx-hold-music?callSid=${encodeURIComponent(callSid)}`;

    console.log('Playing hold music for caller, call_sid:', callSid);

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">Thank you for calling ${escapedDeptName}. Please hold while we connect you with an available representative.</Say>
  <Redirect>${holdMusicUrl}</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Check if there's an IVR configuration for this phone number
  const { data: ivrByPhone } = await supabaseQuery('ivr_configurations', {
    select: 'id,greeting_message,voice,company_name',
    filters: { phone_number_id: phoneData.id },
    single: true,
  });

  console.log('IVR lookup by phone_number_id:', ivrByPhone ? 'found' : 'not found');

  if (ivrByPhone) {
    console.log('IVR configuration found for phone, generating IVR menu inline');

    // Fetch menu options separately
    let menuOptions: any[] = [];
    if (ivrByPhone.id) {
      const ivrConfigId = ivrByPhone.id;
      const optionsUrl = `${supabaseUrl}/rest/v1/ivr_menu_options?ivr_config_id=eq.${ivrConfigId}&select=digit,label,department_id`;
      const optionsRes = await fetch(optionsUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (optionsRes.ok) {
        menuOptions = await optionsRes.json();
      }
    }

    console.log('IVR config:', ivrByPhone);
    console.log('Menu options:', menuOptions);

    const voiceName = ivrByPhone.voice || 'Polly.Amy-Neural';

    if (!menuOptions || menuOptions.length === 0) {
      // No menu options, send to voicemail
      console.log('No IVR menu options, sending to voicemail');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">I'm sorry, no one is available at the moment. Please leave a message after the tone.</Say>
  <Record maxLength="120" />
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }

    // Build menu message
    let menuMessage = (ivrByPhone.greeting_message || 'Thank you for calling.') + ' ';
    menuOptions.forEach((option: any) => {
      menuMessage += `Press ${option.digit} for ${option.label}. `;
    });

    // Generate Gather URL for digit collection - use &amp; for XML escaping
    const gatherUrl = `${supabaseUrl}/functions/v1/telnyx-ivr-gather?phoneNumberId=${encodeURIComponent(phoneData.id)}&amp;companyName=${encodeURIComponent(ivrByPhone.company_name || '')}&amp;ivrConfigId=${encodeURIComponent(ivrByPhone.id || '')}`;

    console.log('Returning IVR menu with Gather URL:', gatherUrl);

    // Escape special XML characters in the menu message
    const escapedMenuMessage = menuMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="10">
    <Say voice="${voiceName}">${escapedMenuMessage}</Say>
  </Gather>
  <Say voice="${voiceName}">We didn't receive a selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Also check if company_name on phone has an IVR config
  if (phoneData.company_name) {
    const { data: ivrByCompanyName } = await supabaseQuery('ivr_configurations', {
      select: 'id,greeting_message,voice,company_name',
      filters: { company_name: phoneData.company_name },
      single: true,
    });

    console.log('IVR lookup by phone company_name:', ivrByCompanyName ? 'found' : 'not found');

    if (ivrByCompanyName) {
      console.log('IVR configuration found via phone company_name, generating IVR menu inline');

      // Fetch menu options
      let menuOptions: any[] = [];
      const ivrConfigId = ivrByCompanyName.id;
      const optionsUrl = `${supabaseUrl}/rest/v1/ivr_menu_options?ivr_config_id=eq.${ivrConfigId}&select=digit,label,department_id`;
      const optionsRes = await fetch(optionsUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (optionsRes.ok) {
        menuOptions = await optionsRes.json();
      }

      console.log('Company name IVR menu options:', menuOptions);

      const voiceName = ivrByCompanyName?.voice || 'Polly.Amy-Neural';

      if (!menuOptions || menuOptions.length === 0) {
        console.log('No IVR menu options configured');
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voiceName}">I'm sorry, no one is available at the moment. Goodbye.</Say>
  <Hangup/>
</Response>`,
          { headers: { 'Content-Type': 'application/xml' } }
        );
      }

      // Build menu message
      let menuMessage = (ivrByCompanyName?.greeting_message || 'Thank you for calling.') + ' ';
      menuOptions.forEach((option: any) => {
        menuMessage += `Press ${option.digit} for ${option.label}. `;
      });

      // Escape special XML characters in the menu message
      const escapedMenuMessage = menuMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const gatherUrl = `${supabaseUrl}/functions/v1/telnyx-ivr-gather?phoneNumberId=${encodeURIComponent(phoneData.id)}&amp;companyName=${encodeURIComponent(phoneData.company_name)}&amp;ivrConfigId=${encodeURIComponent(ivrConfigId)}`;

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="10">
    <Say voice="${voiceName}">${escapedMenuMessage}</Say>
  </Gather>
  <Say voice="${voiceName}">We didn't receive a selection. Goodbye.</Say>
  <Hangup/>
</Response>`,
        { headers: { 'Content-Type': 'application/xml' } }
      );
    }
  }

  // No user, department, or IVR assignment - reject
  console.log('Phone number not assigned to user, department, or IVR - rejecting');
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}

async function handleIncomingCall(payload: any) {
  const toNumber = payload?.to;
  const fromNumber = payload?.from;
  const callControlId = payload?.call_control_id;
  const telnyxApiKey = Deno.env.get('TELNYX_API_KEY')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  console.log('Incoming Telnyx call:', { from: fromNumber, to: toNumber, callControlId });

  const { data: phoneData, error: phoneError } = await supabaseQuery('phone_numbers', {
    select: 'id,assigned_to,is_active,company_name',
    filters: { phone_number: toNumber, provider: 'telnyx' },
    single: true,
  });

  console.log('Phone number lookup:', { phoneData, phoneError });

  if (phoneError || !phoneData || !phoneData.is_active) {
    console.log('Phone number not found or not active, rejecting call');
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cause: 'USER_BUSY' }),
    });
    return new Response(JSON.stringify({ handled: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (phoneData.assigned_to) {
    const userId = phoneData.assigned_to;
    console.log('Routing Telnyx call to user:', userId);

    // Check if this is a callback leg of an outbound SDK call.
    // If user has a recent outbound call with status 'connecting' (preliminary record),
    // this incoming event is the callback leg — skip creating a duplicate inbound record.
    let skipInsert = false;
    try {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
      const checkUrl = `${supabaseUrl}/rest/v1/call_history?select=id&user_id=eq.${encodeURIComponent(userId)}&direction=eq.outbound&status=eq.connecting&created_at=gte.${encodeURIComponent(thirtySecondsAgo)}&limit=1`;
      const recentOutboundRes = await fetch(checkUrl, {
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (recentOutboundRes.ok) {
        const recentOutbound = await recentOutboundRes.json();
        if (recentOutbound && recentOutbound.length > 0) {
          console.log('Skipping call_history insert — callback leg of active outbound call');
          skipInsert = true;
        }
      }
    } catch (e) {
      console.log('Outbound check failed (non-fatal), proceeding with insert:', e);
    }

    if (!skipInsert) {
      await supabaseInsert('call_history', {
        user_id: userId,
        from_number: fromNumber,
        to_number: toNumber,
        direction: 'inbound',
        status: 'ringing',
        duration: 0,
        call_sid: callControlId,
      });
    }

    const { data: regData } = await supabaseQuery('telnyx_webrtc_registrations', {
      select: 'sip_username',
      filters: { user_id: userId },
      single: true,
    });

    if (regData?.sip_username) {
      console.log('Found user SIP registration:', regData.sip_username);
      const sipUri = `sip:${regData.sip_username}@sip.telnyx.com`;
      console.log('Transferring to SIP URI:', sipUri);

      const transferResponse = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: sipUri,
          from: fromNumber,
          caller_id_number: fromNumber,
          caller_id_name: fromNumber,
          webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call`,
          client_state: btoa(JSON.stringify({ userId, fromNumber, toNumber, originalCallControlId: callControlId })),
          custom_headers: [
            { name: 'X-Original-Caller', value: fromNumber },
          ],
        }),
      });

      if (!transferResponse.ok) {
        const errorText = await transferResponse.text();
        console.error('Transfer to WebRTC error:', errorText);
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call` }),
        });
      } else {
        console.log('Call transferred to WebRTC client');
      }
    } else {
      console.log('No SIP registration found, looking up credentials...');
      const credsResponse = await fetch('https://api.telnyx.com/v2/telephony_credentials', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
      });

      if (credsResponse.ok) {
        const credsData = await credsResponse.json();
        const userCred = credsData.data?.find((c: any) => c.name === `lovable-user-${userId}`);

        if (userCred?.sip_username) {
          console.log('Found user creds in Telnyx:', userCred.sip_username);
          // NOTE: do NOT upsert the registrations row here. This fallback
          // path only knows the sip_username, not the telnyx_credential_id
          // or device_type. Writing a partial row corrupts the data state
          // (sip_username drifts away from telnyx_credential_id, so the
          // generate-token "delete previous credential" logic later targets
          // the wrong credential and leaks orphans). The app's own
          // `telnyx-generate-token` call will refresh the row with a
          // consistent set of fields the next time the client launches.
          const sipUri = `sip:${userCred.sip_username}@sip.telnyx.com`;
          await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: sipUri,
              from: fromNumber,
              caller_id_number: fromNumber,
              caller_id_name: fromNumber,
              webhook_url: `${supabaseUrl}/functions/v1/telnyx-incoming-call`,
              custom_headers: [
                { name: 'X-Original-Caller', value: fromNumber },
              ],
            }),
          });
        } else {
          console.log('User has no WebRTC credentials, rejecting call');
          await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${telnyxApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cause: 'USER_BUSY' }),
          });
        }
      }
    }
  }

  return new Response(JSON.stringify({ handled: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCallAnswered(payload: any) {
  const callControlId = payload?.call_control_id;
  const clientState = payload?.client_state;

  console.log('Call answered event:', { callControlId });

  await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: callControlId });

  if (clientState) {
    try {
      const state = JSON.parse(atob(clientState));
      if (state.originalCallControlId) {
        await supabaseUpdate('call_history', { status: 'in-progress' }, { call_sid: state.originalCallControlId });
      }
    } catch (e) {
      console.error('Error parsing client state:', e);
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCallHangup(payload: any) {
  const callControlId = payload?.call_control_id;
  const hangupCause = payload?.hangup_cause;
  const duration = payload?.duration_seconds || 0;

  console.log('Call hangup:', { callControlId, hangupCause, duration });

  let status = 'completed';
  if (hangupCause === 'originator_cancel') {
    const { data: callData } = await supabaseQuery('call_history', {
      select: 'status',
      filters: { call_sid: callControlId },
      single: true,
    });
    if (callData?.status === 'ringing') status = 'missed';
  } else if (hangupCause === 'user_busy') {
    status = 'busy';
  } else if (hangupCause === 'no_answer' || hangupCause === 'timeout') {
    status = 'no-answer';
  }

  await supabaseUpdate('call_history', { status, duration: Math.round(duration) }, { call_sid: callControlId });

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRecordingSaved(payload: any) {
  console.log('=== RECORDING SAVED (telnyx-incoming-call) ===');
  console.log('Full payload:', JSON.stringify(payload, null, 2));

  const callControlId = payload?.call_control_id;
  const recordingUrl = payload?.recording_urls?.mp3;
  const recordingSid = payload?.recording_id;
  const recordingDuration = payload?.recording_duration_ms ? Math.round(payload.recording_duration_ms / 1000) : 0;
  const payloadFrom = payload?.from;
  const payloadTo = payload?.to;

  console.log('Extracted:', { callControlId, recordingUrl, recordingSid, payloadFrom, payloadTo });

  if (!recordingUrl || !recordingSid) {
    console.log('Missing recording URL or SID, skipping');
    return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Try to find the call in call_history
  let { data: callData } = await supabaseQuery('call_history', {
    select: '*',
    filters: { call_sid: callControlId },
    single: true,
  });
  console.log('Primary lookup:', callData ? 'found' : 'not found');

  // Fallback: find the most recent call (any direction) within 5 minutes.
  // The recording.saved event fires when the call ends, so the latest call
  // in call_history is almost certainly the one that was being recorded.
  if (!callData) {
    console.log('Trying fallback lookup (any direction)...');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=*&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      console.log('Fallback result:', fallbackData?.length || 0, 'records');
      if (fallbackData && fallbackData.length > 0) {
        callData = fallbackData[0];
      }
    }
  }

  // Use payload data as fallback for from/to
  const fromNumber = callData?.from_number || payloadFrom || 'unknown';
  const toNumber = callData?.to_number || payloadTo || 'unknown';
  const direction = callData?.direction || 'inbound';
  const userId = callData?.user_id || null;

  console.log('Inserting recording with:', { callControlId, fromNumber, toNumber, direction, userId });
  const insertResult = await supabaseInsert('call_recordings', {
    call_sid: callControlId,
    recording_sid: recordingSid,
    recording_url: recordingUrl,
    duration: recordingDuration,
    from_number: fromNumber,
    to_number: toNumber,
    direction: direction,
    user_id: userId,
  });

  if (insertResult.error) {
    console.error('INSERT FAILED:', insertResult.error);
  } else {
    console.log('=== RECORDING SAVED SUCCESSFULLY ===');
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

// Handle TeXML recording webhook (form-urlencoded format)
async function handleTeXMLRecording(formObj: Record<string, string>) {
  console.log('=== TEXML RECORDING HANDLER ===');
  console.log('Form data:', formObj);

  // TeXML recording webhook fields (Twilio/Telnyx TeXML format)
  const recordingUrl = formObj.RecordingUrl;
  const recordingSid = formObj.RecordingSid || formObj.RecordingId;
  const callSid = formObj.CallSid;
  const recordingDuration = parseInt(formObj.RecordingDuration || '0', 10);
  const fromNumber = formObj.From || 'unknown';
  const toNumber = formObj.To || 'unknown';

  console.log('Extracted:', { recordingUrl, recordingSid, callSid, recordingDuration, fromNumber, toNumber });

  if (!recordingUrl) {
    console.log('No recording URL, skipping');
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Try to find the call in call_history
  let callData: any = null;
  if (callSid) {
    const result = await supabaseQuery('call_history', {
      select: '*',
      filters: { call_sid: callSid },
      single: true,
    });
    callData = result.data;
    console.log('Lookup by CallSid:', callData ? 'found' : 'not found');
  }

  // Fallback: find most recent inbound call
  if (!callData) {
    console.log('Trying fallback lookup...');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=*&direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      console.log('Fallback result:', fallbackData?.length || 0, 'records');
      if (fallbackData && fallbackData.length > 0) {
        callData = fallbackData[0];
      }
    }
  }

  // Use call data or form data for the recording
  const finalFrom = callData?.from_number || fromNumber;
  const finalTo = callData?.to_number || toNumber;
  const direction = callData?.direction || 'inbound';
  const userId = callData?.user_id || null;

  console.log('Inserting TeXML recording:', { callSid, finalFrom, finalTo, direction, userId });

  const insertResult = await supabaseInsert('call_recordings', {
    call_sid: callSid || 'texml-' + Date.now(),
    recording_sid: recordingSid || 'rec-' + Date.now(),
    recording_url: recordingUrl,
    duration: recordingDuration,
    from_number: finalFrom,
    to_number: finalTo,
    direction: direction,
    user_id: userId,
  });

  if (insertResult.error) {
    console.error('INSERT FAILED:', insertResult.error);
  } else {
    console.log('=== TEXML RECORDING SAVED SUCCESSFULLY ===');
  }

  // Return empty TeXML response
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}

// Handle TeXML status callback (form-urlencoded format)
// Updates call_history with status and duration
async function handleTeXMLStatusCallback(formObj: Record<string, string>) {
  const callSid = formObj.CallSid;
  const callStatus = formObj.CallStatus?.toLowerCase();
  const callDuration = parseInt(formObj.CallDuration || formObj.Duration || '0', 10);
  const dialCallStatus = formObj.DialCallStatus?.toLowerCase();

  console.log('TeXML status callback:', { callSid, callStatus, callDuration, dialCallStatus });

  if (!callSid) {
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Map TeXML status to our status values
  let status = 'completed';
  const statusToCheck = dialCallStatus || callStatus;

  switch (statusToCheck) {
    case 'in-progress':
    case 'answered':
      status = 'answered';
      break;
    case 'completed':
      status = 'completed';
      break;
    case 'busy':
      status = 'busy';
      break;
    case 'no-answer':
    case 'noanswer':
      status = 'no-answer';
      break;
    case 'failed':
    case 'canceled':
      status = 'failed';
      break;
    case 'ringing':
      status = 'ringing';
      break;
    default:
      status = statusToCheck || 'completed';
  }

  // Clean up call_queue when the caller hangs up or the call ends
  if (callSid && (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer')) {
    console.log('Cleaning up call_queue for ended call:', callSid);
    const cleanupResult = await supabaseUpdate('call_queue',
      { status: 'abandoned', abandoned_at: new Date().toISOString() },
      { call_sid: callSid, status: 'waiting' }
    );
    // Also clean up 'ringing' status entries
    await supabaseUpdate('call_queue',
      { status: 'abandoned', abandoned_at: new Date().toISOString() },
      { call_sid: callSid, status: 'ringing' }
    );
    if (cleanupResult.error) {
      console.log('Queue cleanup note:', cleanupResult.error.message);
    } else {
      console.log('Queue entry cleaned up successfully');
    }
  }

  console.log('Updating call_history:', { callSid, status, duration: callDuration });

  // Update by CallSid
  const updateResult = await supabaseUpdate('call_history',
    { status, duration: callDuration },
    { call_sid: callSid }
  );

  if (updateResult.error) {
    console.log('Update by call_sid failed, trying fallback...');

    // Fallback: find recent inbound call and update it
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const fallbackRes = await fetch(
      `${supabaseUrl}/rest/v1/call_history?select=id&direction=eq.inbound&status=eq.ringing&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );

    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      if (fallbackData && fallbackData.length > 0) {
        const callId = fallbackData[0].id;
        console.log('Found call via fallback, updating:', callId);

        await fetch(
          `${supabaseUrl}/rest/v1/call_history?id=eq.${callId}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ status, duration: callDuration, call_sid: callSid }),
          }
        );
      }
    }
  } else {
    console.log('Call history updated successfully');
  }

  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}
