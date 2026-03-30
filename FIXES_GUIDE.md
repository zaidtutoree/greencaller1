# Fixes Guide: Switchboard Queue, Decline, Voicemail & IVR

Use this guide to fix the same issues in the web app codebase. All fixes relate to Telnyx TeXML call handling with Supabase backend.

---

## 1. Switchboard Tab Badge Shows Queue Count in Real-Time (Even When on Another Tab)

### Problem
The switchboard tab icon only showed the yellow badge with waiting caller count when the user clicked on the switchboard tab. It didn't update in real-time when on another tab.

### Root Cause
The queue count was only fetched when the switchboard tab was active/clicked. Supabase Realtime subscriptions alone were unreliable for catching all INSERT/UPDATE/DELETE events on the `call_queue` table.

### Fix

#### A. Enable Supabase Realtime for `call_queue` table
Run this SQL on your Supabase database:
```sql
ALTER TABLE call_queue REPLICA IDENTITY FULL;
```
This is required for Supabase Realtime to fire events on UPDATE and DELETE (not just INSERT).

#### B. Add polling fallback alongside Realtime subscription
In the parent component that renders the tab bar (e.g., `EnterprisePlatform.tsx`), add a 2-second polling interval that fetches the queue count regardless of which tab is active:

```typescript
// Extract fetchQueueCount as a useCallback so it can be called from both
// the Realtime subscription handler AND the polling interval
const fetchQueueCount = useCallback(async () => {
  // Get all department IDs for the user's company
  const { data } = await supabase
    .from('call_queue')
    .select('id', { count: 'exact' })
    .in('department_id', departmentIds)
    .in('status', ['ringing', 'waiting']);

  setQueueCount(data?.length || 0);
}, [departmentIds]);

// Poll every 2 seconds as fallback (Realtime can miss events)
useEffect(() => {
  fetchQueueCount(); // Initial fetch
  const interval = setInterval(fetchQueueCount, 2000);
  return () => clearInterval(interval);
}, [fetchQueueCount]);

// ALSO keep the Realtime subscription for instant updates
useEffect(() => {
  const channel = supabase
    .channel('queue-badge')
    .on('postgres_changes', {
      event: '*', // Listen to ALL events (INSERT, UPDATE, DELETE)
      schema: 'public',
      table: 'call_queue',
    }, () => {
      fetchQueueCount(); // Re-fetch on any change
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}, [fetchQueueCount]);
```

#### C. Show toast notification when queue count increases
```typescript
const prevQueueCountRef = useRef(0);

// Inside fetchQueueCount, after getting the new count:
if (newCount > prevQueueCountRef.current) {
  toast({
    title: 'New caller in queue',
    description: `${newCount} caller(s) waiting in department queue`,
  });
}
prevQueueCountRef.current = newCount;
```

---

## 2. Queue Entries Persist After Caller Hangs Up (Badge Stays Forever)

### Problem
When a caller hangs up before being picked up, their entry stays in `call_queue` with status `ringing` or `waiting`. The yellow badge never clears.

### Root Cause
No backend code was updating the `call_queue` status when the caller disconnected. The queue cleanup only happened on the agent side, not when the PSTN caller hung up.

### Fix — Update `call_queue` status in ALL call termination paths:

#### A. In the call hangup webhook handler (`call-hangup` or equivalent)
When a caller hangs up, mark their queue entry as `abandoned`:
```typescript
// When processing a call hangup event:
if (callSid) {
  await supabase
    .from('call_queue')
    .update({ status: 'abandoned' })
    .eq('call_sid', callSid)
    .in('status', ['ringing', 'waiting']);
}
```

#### B. In the TeXML status callback handler
When a call reaches a terminal status (completed, busy, no-answer, failed), update the queue:
```typescript
const terminalStatuses = ['completed', 'busy', 'no-answer', 'failed'];
if (terminalStatuses.includes(status)) {
  const queueStatus = (status === 'completed') ? 'completed' : 'abandoned';
  await supabase
    .from('call_queue')
    .update({ status: queueStatus })
    .eq('call_sid', callSid);
}
```

#### C. In the Call Control `call.hangup` event handler
Same pattern — check if voicemail-requested first (don't overwrite), then update queue:
```typescript
async function handleCallHangup(payload) {
  const callControlId = payload.call_control_id;

  // Check if voicemail-requested — don't overwrite
  const { data: currentCall } = await supabase
    .from('call_history')
    .select('status')
    .eq('call_sid', callControlId)
    .single();

  if (currentCall?.status === 'voicemail-requested') {
    console.log('Call is voicemail-requested, skipping status update');
    return;
  }

  // Update call_history status
  await supabase
    .from('call_history')
    .update({ status, duration })
    .eq('call_sid', callControlId);

  // Mark call_queue entry as abandoned/completed
  const queueStatus = (status === 'completed') ? 'completed' : 'abandoned';
  await supabase
    .from('call_queue')
    .update({ status: queueStatus })
    .eq('call_sid', callControlId);
}
```

#### D. Add pre-check in the "Take Call" / "Pick Up" button
Before connecting the agent, verify the caller is still waiting:
```typescript
const handleTakeCall = async (queuedCall) => {
  // Verify caller is still waiting before attempting pickup
  const { data: freshEntry } = await supabase
    .from('call_queue')
    .select('status')
    .eq('id', queuedCall.id)
    .single();

  if (!freshEntry || (freshEntry.status !== 'waiting' && freshEntry.status !== 'ringing')) {
    // Remove stale entry from local state
    setQueuedCalls(prev => prev.filter(c => c.id !== queuedCall.id));
    toast({
      title: 'Caller hung up',
      description: 'The caller is no longer waiting',
    });
    return;
  }

  // Proceed with pickup...
};
```

#### E. Add polling in Switchboard component too
The switchboard component that displays queued callers should also poll every 2 seconds:
```typescript
useEffect(() => {
  fetchQueuedCalls(); // Initial
  const interval = setInterval(fetchQueuedCalls, 2000);
  return () => clearInterval(interval);
}, [fetchQueuedCalls]);
```

---

## 3. Decline Button Doesn't Stop Caller From Ringing

### Problem
Clicking "Decline" on the incoming call modal dismisses the modal, but the caller's phone keeps ringing.

### Root Cause
`callRef.hangup()` on the WebRTC SDK only terminates the SIP/WebRTC leg. For TeXML inbound calls, the PSTN leg (the actual phone call) is a separate call controlled by Telnyx's TeXML engine. Hanging up the SIP leg doesn't hang up the PSTN leg — the `<Dial>` action URL fires instead.

### Fix
Create a backend edge function that hangs up the PSTN call via the Telnyx Call Control API:

#### Frontend (decline handler):
```typescript
const declineIncomingCall = async () => {
  const pstnId = extractPstnCallControlId(incomingCall.call) || callState.pstnCallControlId;
  const callRef = incomingCall.call;

  // Clear UI immediately
  setIncomingCall({ isIncoming: false, ... });

  // Call backend to hang up the PSTN leg
  await supabase.functions.invoke('telnyx-send-to-voicemail', {
    body: {
      callId: pstnId || null,
      webrtcCallId: callRef?.id || null,
      toNumber: assignedNumber,
      fromNumber: incomingCall.phoneNumber,
      action: 'decline',  // <-- This tells the backend to DECLINE, not voicemail
    },
  });

  // Also try hanging up the WebRTC leg locally
  try { callRef?.hangup(); } catch {}
};
```

#### Backend edge function (decline handler):
```typescript
if (action === 'decline') {
  // Mark as declined in call_history
  if (callInfo?.call_sid) {
    await supabaseUpdate('call_history', { status: 'declined' }, { call_sid: callInfo.call_sid });
  }

  // Hang up the PSTN call via Telnyx Call Control API
  if (pstnCallControlId && isValidCallControlId(pstnCallControlId)) {
    await fetch(
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
  }

  // Also try hanging up using the TeXML call SID
  if (callInfo?.call_sid && callInfo.call_sid !== pstnCallControlId) {
    await fetch(
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
  }

  return { success: true, action: 'declined' };
}
```

---

## 4. Send-to-Voicemail Button Doesn't Work (Caller Keeps Ringing or Gets Hung Up)

### Problem
Clicking "Send to Voicemail" either:
- Does nothing (caller keeps ringing), OR
- Hangs up on the caller entirely instead of playing "Please leave a message after the beep"

### Root Cause — Multiple issues:

1. **`callRef.hangup()` doesn't work in Electron** for unanswered SIP calls
2. **Call Control API hangup doesn't work for TeXML SIP legs** because `callRef.id` is a UUID, but the Call Control API expects `v2:`/`v3:` prefixed IDs
3. **Race condition**: The TeXML statusCallback overwrites `voicemail-requested` status before the voicemail action URL can read it
4. **Wrong approach**: Hanging up the entire PSTN call instead of just redirecting it to voicemail

### Fix — Use TeXML Call Update API

The correct approach is to use Telnyx's TeXML Call Update API to redirect the PSTN call directly to the voicemail TwiML endpoint. This bypasses the SIP leg entirely.

#### Backend edge function (voicemail handler):
```typescript
// Step 1: Mark call as voicemail-requested in call_history
// This is important so other handlers don't overwrite the status
if (callInfo?.call_sid) {
  await supabaseUpdate('call_history',
    { status: 'voicemail-requested' },
    { call_sid: callInfo.call_sid }
  );
}

// Step 2: Use TeXML Call Update API to redirect PSTN call to voicemail
// This is the KEY fix — it directly sends the caller to voicemail
const pstnCallSid = callInfo?.call_sid; // The TeXML CallSid (UUID format)
const voicemailUrl = `${SUPABASE_URL}/functions/v1/telnyx-voicemail-twiml?to=${encodeURIComponent(toNumber)}&from=${encodeURIComponent(fromNumber)}&callSid=${encodeURIComponent(pstnCallSid)}`;

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

// Fallback: Try Call Control API hangup on the SIP leg
if (!updateRes.ok && webrtcCallId) {
  await fetch(
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
}
```

#### Voicemail TwiML endpoint (`telnyx-voicemail-twiml`):
This endpoint returns TeXML that plays a voicemail prompt and records the caller's message:
```typescript
// CRITICAL: Check if voicemail was explicitly requested BEFORE checking DialCallStatus
// This prevents the race condition where statusCallback sets DialCallStatus to 'canceled'
const voicemailRequested = await wasVoicemailRequested(callSid);

if (voicemailRequested) {
  // Route to voicemail regardless of DialCallStatus
  // Fall through to voicemail recording logic below
} else if (dialCallStatus === 'completed') {
  // Call was answered and completed normally — don't go to voicemail
  return xmlResponse('<Response><Hangup/></Response>');
} else if (dialCallStatus === 'canceled') {
  // Call was canceled — hang up
  return xmlResponse('<Response><Hangup/></Response>');
}

// Generate voicemail TwiML
return xmlResponse(`
<Response>
  <Say voice="Polly.Amy-Neural">Please leave a message after the beep. Press hash when finished.</Say>
  <Record action="${callbackUrl}" method="POST" maxLength="120" finishOnKey="#" playBeep="true" />
  <Say voice="Polly.Amy-Neural">We did not receive a recording. Goodbye.</Say>
</Response>
`);
```

#### Race condition fix in status callbacks:
In BOTH the `handleCallHangup` and `handleTeXMLStatusCallback` handlers, check for voicemail-requested before overwriting:
```typescript
// Before updating call_history status, check if voicemail was requested
const { data: currentCall } = await supabase
  .from('call_history')
  .select('status')
  .eq('call_sid', callSid)
  .single();

if (currentCall?.status === 'voicemail-requested') {
  console.log('Call is voicemail-requested, skipping status update');
  return; // Don't overwrite — the voicemail handler needs to read this
}
```

---

## 5. IVR Hold Music Returns "Application Error"

### Problem
When calling the IVR number and pressing a digit to route to a department, the caller hears "please wait while we connect you" then after 5 seconds hears "we're sorry, an application error has occurred". But calling the department number directly works fine.

### Root Cause
The `telnyx-hold-music` edge function had two issues:
1. **No try-catch wrapper** — any unhandled error caused a 500 response, which Telnyx interprets as "application error"
2. **Used `Accept: application/vnd.pgrst.object+json`** header for PostgREST queries — this returns a 406 error if the query returns 0 or 2+ rows instead of exactly 1

### Fix

#### A. Wrap entire function in try-catch that always returns valid TeXML:
```typescript
serve(async (req) => {
  try {
    // ... existing logic ...
  } catch (error) {
    console.error('Hold music error:', error);
    // ALWAYS return valid TeXML even on error
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural">Please continue to hold.</Say>
  <Pause length="3"/>
  <Redirect>${supabaseUrl}/functions/v1/telnyx-hold-music</Redirect>
</Response>`,
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }
});
```

#### B. Remove `application/vnd.pgrst.object+json` header, handle arrays:
```typescript
// BEFORE (broken for 0 or 2+ results):
const queueResponse = await fetch(url, {
  headers: {
    ...
    'Accept': 'application/vnd.pgrst.object+json', // DON'T USE THIS
  },
});
const queueData = await queueResponse.json();

// AFTER (works for any number of results):
const queueResponse = await fetch(url, {
  headers: {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Cache-Control': 'no-cache',
  },
});
const queueArr = await queueResponse.json();
const queueData = Array.isArray(queueArr) && queueArr.length > 0 ? queueArr[0] : null;
```

#### C. Add abandoned/completed check to stop hold music loop:
```typescript
if (queueData?.status === 'abandoned' || queueData?.status === 'completed') {
  console.log('Call queue status is terminal:', queueData.status);
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    { headers: { 'Content-Type': 'application/xml' } }
  );
}
```

---

## Summary of Key Telnyx TeXML Concepts

1. **TeXML CallSid vs Call Control ID**: TeXML calls use UUID-format CallSids. Call Control API uses `v2:`/`v3:` prefixed IDs. They are NOT interchangeable for API calls.

2. **TeXML Call Update API**: `POST /v2/texml/calls/{callSid}/update` with `Url=...` body redirects an in-progress TeXML call to new TwiML. This is the reliable way to redirect a caller (e.g., to voicemail).

3. **`<Dial>` action URL**: When a `<Dial>` verb ends (timeout, hangup, busy), Telnyx fetches the action URL. The `DialCallStatus` parameter tells you what happened. Use this for voicemail routing.

4. **Supabase Realtime requires `REPLICA IDENTITY FULL`**: Without this, UPDATE and DELETE events won't fire. Run `ALTER TABLE call_queue REPLICA IDENTITY FULL;` on any table you subscribe to.

5. **Always return valid TeXML**: If your TeXML endpoint returns a non-200 status or invalid XML, Telnyx plays "an application error has occurred". Always wrap in try-catch and return fallback TeXML.

6. **PostgREST `application/vnd.pgrst.object+json`**: This header makes PostgREST return a single JSON object instead of an array. But it returns 406 if 0 or 2+ rows match. Avoid it — use regular array responses and take `[0]`.
