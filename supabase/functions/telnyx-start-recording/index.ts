// Version 4 - Use Call Control API for both inbound and outbound, store call_control_id
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to check if a string is a valid UUID (TeXML CallSid format)
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Helper: is a v3:/v2: Call Control id still a LIVE call? Used to skip stale,
// already-ended call_sids when resolving a recording target by phone-digit
// match. Without this, when the same two numbers call repeatedly, the digit
// match can grab an OLD ended call's call_control_id, and record_start then
// fails the liveness gate with 409 "Call has already ended". Returns false on
// any error so callers treat unknown as not-recordable.
async function isCallAlive(ccId: string, telnyxApiKey: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telnyx.com/v2/calls/${ccId}`, {
      headers: { Authorization: `Bearer ${telnyxApiKey}` },
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d?.data?.is_alive === true;
  } catch {
    return false;
  }
}

// Best-effort debug line to app_logs (edge console logs aren't queryable via
// tooling). TEMP — remove after recording diagnosis.
async function recDebug(message: string) {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/app_logs`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'edge-start-recording', level: 'log', message }),
    });
  } catch (_e) { /* ignore */ }
}

// Helper to update call_history call_sid to the call_control_id (so recording webhook lookup works)
async function updateCallSidToControlId(originalCallSid: string, callControlId: string, fromNumber?: string, toNumber?: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    console.log('Supabase not configured, skipping call_history update');
    return;
  }

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // First try: Update by exact call_sid match
    const url1 = `${supabaseUrl}/rest/v1/call_history?call_sid=eq.${encodeURIComponent(originalCallSid)}`;
    const response1 = await fetch(url1, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ call_sid: callControlId }),
    });

    if (response1.ok) {
      const updated = await response1.json();
      if (updated && updated.length > 0) {
        console.log('Updated call_history call_sid from', originalCallSid, 'to', callControlId);
        return;
      }
    }

    // Second try: Find most recent inbound call and update it
    console.log('No exact match found, looking for recent inbound call...');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const searchUrl = `${supabaseUrl}/rest/v1/call_history?direction=eq.inbound&created_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=created_at.desc&limit=1`;
    const searchRes = await fetch(searchUrl, { headers });

    if (searchRes.ok) {
      const calls = await searchRes.json();
      if (calls && calls.length > 0) {
        const callId = calls[0].id;
        console.log('Found recent inbound call:', callId, 'with call_sid:', calls[0].call_sid);

        // Update this call's call_sid
        const updateUrl = `${supabaseUrl}/rest/v1/call_history?id=eq.${callId}`;
        const updateRes = await fetch(updateUrl, {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ call_sid: callControlId }),
        });

        if (updateRes.ok) {
          console.log('Updated recent inbound call call_sid to:', callControlId);
        } else {
          console.log('Failed to update recent inbound call:', await updateRes.text());
        }
      } else {
        console.log('No recent inbound calls found');
      }
    }
  } catch (err) {
    console.error('Error updating call_history:', err);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const telnyxApiKey = Deno.env.get('TELNYX_API_KEY');

    if (!telnyxApiKey) {
      throw new Error('Telnyx API key not configured');
    }

    const { callId, userId, fromNumber, toNumber } = await req.json();

    if (!callId) {
      throw new Error('Call ID is required');
    }

    console.log('Starting recording for Telnyx call:', { callId, userId, fromNumber, toNumber });

    // Write a recording-attribution hint so the BEFORE-INSERT trigger on
    // call_recordings can point the recording at the user who pressed Record
    // (rather than blindly picking the outbound caller). Direction-agnostic:
    // the trigger matches by from/to phone-digit suffix regardless of who's
    // calling whom. See .claude/OUTBOUND_METHOD.md §G' for the architecture.
    if (userId && (fromNumber || toNumber)) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const normalize = (n: string | undefined) => (n || '').replace(/\D/g, '').slice(-9);
        const hintBody = {
          user_id: userId,
          call_sid: callId,
          from_digits: normalize(fromNumber) || null,
          to_digits: normalize(toNumber) || null,
        };
        await fetch(`${supabaseUrl}/rest/v1/recording_attribution_hints`, {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(hintBody),
        });
        console.log('Wrote recording_attribution_hint:', hintBody);
      } catch (e) {
        console.log('Failed to write recording_attribution_hint (non-fatal):', e);
      }
    }

    // Determine the call type:
    // - Call Control IDs start with v2: or v3: (outbound calls OR newer TeXML format)
    // - TeXML CallSids are UUIDs (older inbound calls)
    const isCallControlId = callId.startsWith('v2:') || callId.startsWith('v3:');
    const isTexmlCallSid = isValidUUID(callId);

    console.log('Call ID analysis:', { callId, isCallControlId, isTexmlCallSid });

    let callControlId = callId;
    let originalCallId = callId;

    // A caller-supplied v2:/v3: id is NOT automatically trustworthy. The client
    // resolves the PSTN leg by polling call_history for the most recent outbound
    // `v3:` row, and a brand-new call's row still holds its WebRTC UUID until the
    // `call.initiated` webhook rewrites it — so a call placed within the previous
    // minute can hand us ITS (now dead) id. Sending that to Telnyx returns
    // 90015 "Invalid Call Control ID". Verify liveness and, if it's dead, fall
    // through to the same resolution passes a UUID would take.
    let providedIdUsable = isCallControlId;
    if (isCallControlId) {
      providedIdUsable = await isCallAlive(callId, telnyxApiKey);
      if (!providedIdUsable) {
        console.log('Supplied Call Control ID is not a live call, re-resolving:', callId);
        await recDebug(`Supplied ccId not alive, re-resolving: ${callId}`);
      }
    }

    // Pass 0: the live leg parked by telnyx-incoming-call at setup time. This is
    // the authoritative source — the TeXML webhook carries the real v3: CallSid
    // for the leg that is actually up, which neither the WebRTC SDK nor
    // call_history reliably has. Everything below stays as a fallback.
    if (!providedIdUsable) {
      try {
        const url = Deno.env.get('SUPABASE_URL')!;
        const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const digits = (n?: string) => (n || '').replace(/\D/g, '').slice(-9);
        const toDigits = digits(toNumber);
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        // The recording target is the leg we dialled OUT to, so match on the
        // called party's digits. Newest first — a live call is the most recent.
        const legUrl =
          `${url}/rest/v1/live_call_legs?select=call_sid,created_at` +
          `&to_digits=eq.${encodeURIComponent(toDigits)}` +
          `&created_at=gte.${encodeURIComponent(tenMinAgo)}` +
          `&order=created_at.desc&limit=5`;

        const legRes = await fetch(legUrl, {
          headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
        });
        if (legRes.ok) {
          const legs = await legRes.json();
          console.log('live_call_legs candidates:', legs);
          for (const leg of legs || []) {
            if (!leg?.call_sid) continue;
            if (await isCallAlive(leg.call_sid, telnyxApiKey)) {
              callControlId = leg.call_sid;
              providedIdUsable = true;
              console.log('Resolved Call Control ID from live_call_legs:', callControlId);
              await recDebug(`Resolved from live_call_legs: ${callControlId}`);
              break;
            }
          }
        } else {
          console.log('live_call_legs lookup returned:', legRes.status, await legRes.text());
        }
      } catch (e) {
        console.log('live_call_legs lookup failed (non-fatal):', e);
      }
    }

    // Pass 0b: internal (on-net) calls. When one of our numbers dials another
    // of our numbers, Telnyx never creates a PSTN leg: the call lands straight
    // on the destination DID's TeXML app, so no call.initiated fires and the
    // WebRTC SDK gets no telnyx_call_control_id. The only recordable leg is the
    // inbound TeXML call, which the TeXML Calls API can find by from/to; we
    // then verify it is still up before using it.
    if (!providedIdUsable) {
      try {
        const toE164 = (n?: string): string | null => {
          const d = (n || '').replace(/\D/g, '');
          if (!d) return null;
          if ((n || '').trim().startsWith('+') || d.startsWith('44')) return '+' + d;
          if (d.startsWith('0')) return '+44' + d.slice(1);
          return '+' + d;
        };
        // TeXML AccountSid is the Telnyx account id that arrives on every
        // TeXML webhook (AccountSid); override via secret if it ever changes.
        const accountSid = Deno.env.get('TELNYX_TEXML_ACCOUNT_SID') || '6f45c7f5-8eca-4da0-9d15-0cbd979f3c7f';
        const to = toE164(toNumber);
        const from = toE164(fromNumber);
        if (to) {
          const qs = new URLSearchParams({ To: to, PageSize: '10' });
          if (from) qs.set('From', from);
          const res = await fetch(`https://api.telnyx.com/v2/texml/Accounts/${accountSid}/Calls?${qs.toString()}`, {
            headers: { Authorization: `Bearer ${telnyxApiKey}`, Accept: 'application/json' },
          });
          if (res.ok) {
            const data = await res.json();
            const calls: any[] = Array.isArray(data?.calls) ? data.calls : Array.isArray(data?.data) ? data.data : [];
            calls.sort((a, b) => Date.parse(b?.start_time || b?.date_created || 0) - Date.parse(a?.start_time || a?.date_created || 0));
            console.log('TeXML calls candidates:', calls.map((c) => ({ sid: c?.sid || c?.call_sid, status: c?.status, from: c?.from, to: c?.to, start: c?.start_time })));
            for (const c of calls) {
              const sid: string | undefined = c?.sid || c?.call_sid;
              if (!sid || !(sid.startsWith('v3:') || sid.startsWith('v2:'))) continue;
              if (c?.status && ['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(c.status)) continue;
              if (await isCallAlive(sid, telnyxApiKey)) {
                callControlId = sid;
                providedIdUsable = true;
                console.log('Resolved Call Control ID from TeXML Calls API (on-net call):', callControlId);
                await recDebug(`Resolved from TeXML Calls API: ${callControlId}`);
                break;
              }
            }
          } else {
            console.log('TeXML Calls API lookup returned:', res.status, (await res.text()).substring(0, 300));
          }
        }
      } catch (e) {
        console.log('TeXML Calls API lookup failed (non-fatal):', e);
      }
    }

    // Pass 0c: on-net calls, real-time. The TeXML Calls list above is CDR-like
    // (it only shows ended calls), so for a call that is up right now ask the
    // destination number's connection for its ACTIVE calls, then confirm each
    // candidate's from/to via its leg's call events before using it.
    if (!providedIdUsable) {
      try {
        const last9 = (n?: string) => (n || '').replace(/[^0-9]/g, '').slice(-9);
        const toL9 = last9(toNumber);
        const fromL9 = last9(fromNumber);
        const tx = { Authorization: `Bearer ${telnyxApiKey}`, Accept: 'application/json' };
        const toE164 = (() => {
          const d = (toNumber || '').replace(/[^0-9]/g, '');
          if (!d) return null;
          if ((toNumber || '').trim().startsWith('+') || d.startsWith('44')) return '+' + d;
          if (d.startsWith('0')) return '+44' + d.slice(1);
          return '+' + d;
        })();

        // Which connection answers the dialled number? (its TeXML app)
        let connectionId: string | null = Deno.env.get('TELNYX_TEXML_CONNECTION_ID') || null;
        if (!connectionId && toE164) {
          const pn = await fetch(`https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(toE164)}`, { headers: tx });
          if (pn.ok) {
            const pj = await pn.json();
            connectionId = pj?.data?.[0]?.connection_id || null;
            console.log('Destination number connection lookup:', { toE164, connectionId });
          } else {
            console.log('phone_numbers lookup returned:', pn.status, (await pn.text()).substring(0, 200));
          }
        }

        if (connectionId) {
          const ac = await fetch(`https://api.telnyx.com/v2/connections/${connectionId}/active_calls?page[size]=20`, { headers: tx });
          if (ac.ok) {
            const aj = await ac.json();
            const active: any[] = Array.isArray(aj?.data) ? aj.data : [];
            active.sort((a, b) => (a?.call_duration ?? 0) - (b?.call_duration ?? 0)); // newest first
            console.log('Active calls on destination connection:', active.map((c) => ({ ccid: c?.call_control_id, leg: c?.call_leg_id, dur: c?.call_duration })));

            let fallback: string | null = null;
            for (const c of active) {
              const ccid: string | undefined = c?.call_control_id;
              const leg: string | undefined = c?.call_leg_id;
              if (!ccid) continue;

              // Confirm from/to via the leg's events (call.initiated carries them).
              let matched = false;
              let sawNumbers = false;
              if (leg) {
                const ev = await fetch(`https://api.telnyx.com/v2/call_events?filter[leg_id]=${encodeURIComponent(leg)}&page[size]=10`, { headers: tx });
                if (ev.ok) {
                  const ej = await ev.json();
                  const events: any[] = Array.isArray(ej?.data) ? ej.data : [];
                  for (const e of events) {
                    const m = e?.metadata || e?.payload || {};
                    const evFrom = m?.from ?? m?.From;
                    const evTo = m?.to ?? m?.To;
                    if (evFrom || evTo) {
                      sawNumbers = true;
                      if (last9(evTo) === toL9 && (!fromL9 || last9(evFrom) === fromL9)) { matched = true; break; }
                    }
                  }
                  console.log('Leg events check:', { leg, events: events.length, sawNumbers, matched, sample: events[0] ? { name: events[0]?.name, keys: Object.keys(events[0]?.metadata || {}) } : null });
                } else {
                  console.log('call_events lookup returned:', ev.status, (await ev.text()).substring(0, 200));
                }
              }

              if (matched && await isCallAlive(ccid, telnyxApiKey)) {
                callControlId = ccid;
                providedIdUsable = true;
                console.log('Resolved Call Control ID from active_calls (from/to confirmed):', callControlId);
                await recDebug(`Resolved from active_calls (confirmed): ${callControlId}`);
                break;
              }
              // No numbers available to confirm: remember the newest live call as a last resort.
              if (!sawNumbers && !fallback && (c?.call_duration ?? 999) <= 600) fallback = ccid;
            }

            if (!providedIdUsable && fallback && await isCallAlive(fallback, telnyxApiKey)) {
              callControlId = fallback;
              providedIdUsable = true;
              console.log('Resolved Call Control ID from active_calls (newest, unconfirmed):', callControlId);
              await recDebug(`Resolved from active_calls (unconfirmed newest): ${callControlId}`);
            }
          } else {
            console.log('active_calls lookup returned:', ac.status, (await ac.text()).substring(0, 200));
          }
        }
      } catch (e) {
        console.log('active_calls lookup failed (non-fatal):', e);
      }
    }

    // Resolve whenever we cannot trust what we were given: a UUID (WebRTC SDK
    // call or TeXML CallSid), or a stale Call Control ID.
    if (!providedIdUsable) {
      console.log('Looking up Call Control ID for UUID:', callId);

      let found = false;

      // Tries 1 and 2 only make sense for a UUID. Re-querying a dead v2:/v3: id
      // just hands back itself, which is precisely what we're recovering from.
      if (isTexmlCallSid) {
      // Try 1: Call Control API - the UUID might be a call_leg_id
      try {
        const resp = await fetch(`https://api.telnyx.com/v2/calls/${callId}`, {
          headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.data?.call_control_id) {
            callControlId = data.data.call_control_id;
            console.log('Found Call Control ID via calls API:', callControlId);
            await updateCallSidToControlId(callId, callControlId);
            found = true;
          }
        } else {
          console.log('Calls API lookup returned:', resp.status);
        }
      } catch (e) {
        console.log('Calls API lookup failed:', e);
      }

      // Try 2: TeXML API
      if (!found) {
        try {
          const resp = await fetch(`https://api.telnyx.com/v2/texml_calls/${callId}`, {
            headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.data?.call_control_id) {
              callControlId = data.data.call_control_id;
              console.log('Found Call Control ID via TeXML API:', callControlId);
              await updateCallSidToControlId(callId, callControlId);
              found = true;
            }
          } else {
            console.log('TeXML API lookup returned:', resp.status);
          }
        } catch (e) {
          console.log('TeXML API lookup failed:', e);
        }
      }

      } // end UUID-only lookups

      // Try 3: Look up the PSTN leg's Call Control ID from call_history
      // The call.initiated webhook stores the v3: ID by mapping via to_number
      if (!found) {
        try {
          const supabaseUrlInner = Deno.env.get('SUPABASE_URL')!;
          const supabaseKeyInner = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
          console.log('Env check - URL set:', !!supabaseUrlInner, 'Key length:', supabaseKeyInner?.length || 0);

          // Get the 10 most recent calls — no time/direction filter for debug
          const searchUrl = `${supabaseUrlInner}/rest/v1/call_history?order=created_at.desc&limit=10&select=call_sid,from_number,to_number,direction,created_at,status`;

          console.log('DB lookup URL:', searchUrl);
          const searchRes = await fetch(searchUrl, {
            headers: {
              'apikey': supabaseKeyInner,
              'Authorization': `Bearer ${supabaseKeyInner}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
          });
          console.log('DB lookup response status:', searchRes.status);
          const rawText = await searchRes.clone().text();
          console.log('DB lookup raw response:', rawText.substring(0, 500));
          if (searchRes.ok) {
            const rows = await searchRes.json();
            console.log('DB lookup result rows:', rows);

            if (Array.isArray(rows) && rows.length > 0) {
              console.log('Total rows returned:', rows.length);
              // Normalize numbers to digits-only for comparison
              const normalizeNum = (n: string | undefined) => (n || '').replace(/[^0-9]/g, '');
              const targetDigits = normalizeNum(toNumber);
              const targetLast9 = targetDigits.slice(-9);

              // Pass 1: prefer outbound rows with matching digits AND v3: call_sid
              for (const row of rows) {
                if (row.direction !== 'outbound') continue;
                const rowDigits = normalizeNum(row.to_number);
                const rowLast9 = rowDigits.slice(-9);
                const sidMatches = row.call_sid && (row.call_sid.startsWith('v2:') || row.call_sid.startsWith('v3:'));
                if (sidMatches && rowLast9 === targetLast9 && await isCallAlive(row.call_sid, telnyxApiKey)) {
                  callControlId = row.call_sid;
                  console.log('Found PSTN Call Control ID (matched digits, live):', callControlId);
                  found = true;
                  break;
                }
              }

              // Pass 2: any recent outbound v3: call_sid (caller may have called multiple)
              if (!found) {
                for (const row of rows) {
                  if (row.direction !== 'outbound') continue;
                  if (row.call_sid && (row.call_sid.startsWith('v2:') || row.call_sid.startsWith('v3:'))
                      && await isCallAlive(row.call_sid, telnyxApiKey)) {
                    callControlId = row.call_sid;
                    console.log('Found PSTN Call Control ID (most recent live v3):', callControlId);
                    found = true;
                    break;
                  }
                }
              }

              // Pass 3: look for INBOUND v3: rows matching the call's
              // from/to numbers. For SDK-direct outbound calls from web,
              // there is NO outbound v3: row — Telnyx assigns the Call
              // Control ID server-side when the call routes through the
              // destination DID's inbound webhook. handleTeXMLIncoming
              // inserts a row with direction='inbound', user_id=receiver,
              // and call_sid=v3:..., which is the bridged-leg's ID we can
              // use for recording (Telnyx records both sides of a bridge).
              if (!found) {
                const fromDigits = normalizeNum(fromNumber);
                const fromLast9 = fromDigits.slice(-9);
                for (const row of rows) {
                  if (row.direction !== 'inbound') continue;
                  const sidMatches = row.call_sid && (row.call_sid.startsWith('v2:') || row.call_sid.startsWith('v3:'));
                  if (!sidMatches) continue;
                  const rowToLast9 = normalizeNum(row.to_number).slice(-9);
                  const rowFromLast9 = normalizeNum(row.from_number).slice(-9);
                  if (rowToLast9 === targetLast9 && rowFromLast9 === fromLast9
                      && await isCallAlive(row.call_sid, telnyxApiKey)) {
                    callControlId = row.call_sid;
                    console.log('Found PSTN Call Control ID via inbound bridged-leg row (live):', callControlId);
                    found = true;
                    break;
                  }
                }
              }

              if (!found) {
                console.log('No matching v3: call_sid found. Target digits:', targetLast9);
                console.log('All rows:', JSON.stringify(rows, null, 2));
              }
            } else {
              console.log('No call_history rows found in last hour at all');
            }
          } else {
            console.log('DB lookup HTTP error:', searchRes.status, await searchRes.text());
          }
        } catch (e) {
          console.log('DB lookup for PSTN Call Control ID failed:', e);
        }
      }

      if (!found) {
        console.log('Could not resolve Call Control ID, using original:', callId);
      }
    } else if (isCallControlId) {
      // For v3: format IDs (newer TeXML or inbound calls), we need to look up the call
      // to find the correct PSTN call_control_id that will be used in recording webhook
      console.log('Looking up call info for Call Control ID:', callId);

      // First try to get the call info from Call Control API
      const callInfoResponse = await fetch(`https://api.telnyx.com/v2/calls/${callId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (callInfoResponse.ok) {
        const callInfo = await callInfoResponse.json();
        console.log('Call Control call info:', callInfo);

        // Check if this call has a different call_control_id we should use
        const resolvedId = callInfo.data?.call_control_id;
        if (resolvedId && resolvedId !== callId) {
          console.log('Resolved to different Call Control ID:', resolvedId);
          callControlId = resolvedId;
          // Update call_history to use the resolved ID
          await updateCallSidToControlId(callId, callControlId);
        }
      } else {
        // Call Control API lookup failed - the call might be TeXML-originated
        // Try the TeXML calls endpoint as fallback
        console.log('Call Control lookup failed, trying TeXML endpoint...');

        // For TeXML calls with v3: IDs, we need to update call_history
        // so the recording webhook can find it
        // The webhook will send the same call_control_id we use for recording
        // So we just need to ensure call_history has this ID
        await updateCallSidToControlId(callId, callId);
      }
    }

    // Now use the Call Control API with the resolved call_control_id
    console.log('Using Call Control API for recording with ID:', callControlId);
    console.log('Original callId was TeXML:', isTexmlCallSid, 'Call Control:', isCallControlId);
    await recDebug(`[rec-DEBUG] callId=${callId} isCCID=${isCallControlId} isUUID=${isTexmlCallSid} resolved=${callControlId} resolvedChanged=${callControlId !== originalCallId}`);

    // Verify the resolved Call Control ID is still active before trying to
    // record on it. Without this, when a stale v3: from an already-ended call
    // gets picked up (e.g. via /v2/calls/{uuid} lookup, or via a call_history
    // row that's no longer live), Telnyx rejects with 90018 "Call has already
    // ended". Surface that as a clean, recoverable error instead.
    if (callControlId && (callControlId.startsWith('v2:') || callControlId.startsWith('v3:'))) {
      try {
        const aliveResp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}`, {
          headers: { 'Authorization': `Bearer ${telnyxApiKey}` },
        });
        if (aliveResp.ok) {
          const aliveData = await aliveResp.json();
          const isAlive = aliveData?.data?.is_alive;
          console.log('Call liveness check:', { callControlId, isAlive });
          if (isAlive === false) {
            await recDebug(`[rec-DEBUG] 409 resolved call not alive ccid=${callControlId} (original callId=${callId})`);
            return new Response(
              JSON.stringify({
                success: false,
                error: 'Call has already ended — start a new call before recording',
                callEnded: true,
              }),
              { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        } else {
          console.log('Liveness check HTTP error:', aliveResp.status, await aliveResp.text());
        }
      } catch (e) {
        console.log('Liveness check failed (continuing):', e);
      }
    }

    const apiUrl = `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`;
    const supabaseUrl = Deno.env.get('SUPABASE_URL');

    // Include webhook URL explicitly for TeXML calls
    // This ensures recording.saved webhook goes to our handler
    const requestBody: Record<string, any> = {
      format: 'mp3',
      channels: 'dual',
    };

    // NOTE: TeXML calls reject client_state (90017). Recorder attribution is
    // handled in telnyx-call-events recording.saved by looking up the matching
    // outbound call_history row by from/to phone digits instead.

    // For inbound/TeXML calls, specify the callback URL explicitly
    if (supabaseUrl) {
      requestBody.status_callback_url = `${supabaseUrl}/functions/v1/telnyx-call-events`;
    }

    console.log('Recording API request:', { apiUrl, requestBody });

    const recordResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!recordResponse.ok) {
      const errorText = await recordResponse.text();
      console.error('Telnyx recording API error:', errorText);
      await recDebug(`[rec-DEBUG] record_start FAILED status=${recordResponse.status} ccid=${callControlId} body=${errorText.substring(0, 220)}`);
      throw new Error(`Failed to start recording: ${errorText}`);
    }

    const result = await recordResponse.json();
    console.log('Recording started successfully:', result);
    await recDebug(`[rec-DEBUG] record_start OK ccid=${callControlId}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Recording started successfully',
        callControlId: callControlId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in telnyx-start-recording function:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
