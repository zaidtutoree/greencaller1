---
name: Call Queue Implementation
description: How the department call queue works — caller detection, hangup cleanup, and Take Call pickup flow
type: project
---

## Call Queue Architecture

When a caller dials a department number, they enter a hold music queue. Agents see them in the Switchboard and can click "Take Call" to connect.

### Key Files

- **`supabase/functions/telnyx-incoming-call/index.ts`** — Handles incoming calls to department numbers. Inserts a `call_queue` entry with `status: 'waiting'` and `call_sid` (TeXML CallSid). Returns TeXML `<Say>` + `<Redirect>` to hold music.
- **`supabase/functions/telnyx-hold-music/index.ts`** — Plays hold music in a Gather+Redirect loop (~33s per cycle). Each iteration: updates `updated_at` heartbeat, checks if agent picked up (status='picked_up'), checks if abandoned/completed. If picked up, returns `<Dial><Sip>` to transfer caller to agent.
- **`supabase/functions/verify-queue-calls/index.ts`** — Checks if queued calls are still active via `GET /v2/calls/{callSid}` on Telnyx API. Returns 404 = caller hung up. Uses `checkOnly` param: when true, only returns results without updating DB.
- **`supabase/functions/telnyx-call-events/index.ts`** — Handles TeXML status callbacks (form-urlencoded). Updates `call_queue` status on call completion. Distinguishes waiting callers (marks as 'abandoned') from connected callers (marks as 'completed').
- **`src/components/Switchboard.tsx`** — Displays queue, handles Take Call. Polls every 2 seconds.
- **`src/pages/EnterprisePlatform.tsx`** — Fetches queue count for sidebar badge.

### Caller Hangup Detection (Auto-removal from queue)

**Problem solved:** Telnyx Call Control webhooks stopped delivering `call.hangup` events. Needed alternative detection.

**Solution:** Two-layer approach:

1. **Telnyx API verification (primary):** `Switchboard.fetchQueuedCalls` runs every 2 seconds. For queued calls older than 5 seconds, it calls `verify-queue-calls` edge function with `checkOnly: true`. The function does `GET /v2/calls/{callSid}` — if 404, the call is gone. Returns list of abandoned call_sids. Frontend removes them from displayed list (does NOT update DB to avoid blocking Take Call).

2. **Hold music heartbeat (backup):** The hold music Gather+Redirect loop updates `updated_at` every ~33 seconds. This provides a secondary staleness indicator if needed.

**Important:** The 5-second grace period prevents false positives — new calls may briefly return 404 from Telnyx before being registered.

### Take Call Flow

When agent clicks "Take Call":

1. **No status check, no API verify** — if the caller is showing in the queue UI, just proceed. The polling verify already handles removing hung-up callers from the UI.
2. Shows "Connecting..." toast.
3. Calls `onPickupCall` with `{ phoneNumber, conferenceName, callSid, queueId }`.
4. The pickup handler (in `useTelnyxCall.ts` or `useCallProvider.ts`) updates queue status to `'picked_up'`.
5. Hold music function detects `status='picked_up'` on next loop (~3-33 seconds).
6. Returns `<Dial><Sip>` TeXML to transfer caller to agent's SIP URI.
7. Agent receives incoming SIP call, answers, audio connects.
8. Hold music function updates queue status to `'connected'`.

**Why no status check on Take Call:** The polling verify uses `checkOnly:true` (no DB update). If we checked DB status, false positives from the verify would block legitimate pickups. The verify only removes from the UI list — if the entry is visible, clicking Take Call should always proceed.

### Database: `call_queue` Table

Key columns:
- `call_sid` (TEXT, unique) — TeXML CallSid (UUID format, NOT Call Control ID)
- `from_number`, `to_number` — Caller and department numbers
- `department_id` — Which department
- `status` — CHECK: 'waiting', 'ringing', 'picked_up', 'abandoned', 'connected', 'completed'
- `picked_up_by` (UUID) — Agent who picked up
- `picked_up_at`, `connected_at` — Timestamps
- `updated_at` — Heartbeat from hold music loop
- Realtime enabled via `supabase_realtime` publication

### Known Constraints

- **Telnyx `GET /v2/calls` (list all) does NOT exist** — returns 404. Only individual call lookup `GET /v2/calls/{id}` works.
- **TeXML CallSid ≠ Call Control ID** — TeXML uses UUID format. Call Control uses `v2:`/`v3:` prefix. The individual lookup endpoint accepts TeXML CallSids.
- **Telnyx Call Control webhooks are unreliable** — `call.answered` and `call.hangup` events stopped delivering. This is why outbound calls use direct WebRTC SDK `client.newCall()` instead of webhook-based bridging.
- **RLS on `call_queue`** — Frontend Supabase client cannot update `call_queue` directly. All status updates must go through edge functions using `SUPABASE_SERVICE_ROLE_KEY`.
- **`verify-queue-calls` must have `verify_jwt = false`** in config.toml and be deployed with `--no-verify-jwt`.

### Outbound Calls (Separate from Queue)

Outbound calls bypass the queue entirely. They use `client.newCall()` directly from the TelnyxRTC WebRTC SDK in the browser. The `telnyx-make-call` edge function is called with `setupOnly: true` to ensure credential connection has outbound voice profile. Call history is logged via `update-call-status` edge function with `action: 'create'`.

### Deploying Edge Functions

```bash
cd greencallerapp1
npx supabase functions deploy verify-queue-calls --no-verify-jwt
npx supabase functions deploy telnyx-hold-music
npx supabase functions deploy telnyx-incoming-call
npx supabase functions deploy telnyx-call-events
```

Frontend deploys automatically via Netlify when pushed to GitHub.
