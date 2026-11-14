---
name: Recording Implementation
description: How call recording works with direct WebRTC SDK calls — resolving Call Control IDs for the Telnyx recording API
type: project
---

## Recording Architecture

Recording uses the Telnyx Call Control API (`record_start`, `record_pause`, `record_resume`). These endpoints require a valid **Call Control ID** (v3: prefix format). The challenge is that direct WebRTC SDK calls (`client.newCall()`) expose a WebRTC session UUID, NOT a Call Control ID.

### The Problem

When calls are placed via `client.newCall()` (the direct WebRTC approach used because Telnyx webhooks stopped delivering):
- `call.id` = WebRTC UUID (e.g., `1b0c96a5-f80e-48e8-ba5b-fd5ef20c83d2`)
- The SDK does NOT expose `call.call_control_id` or `call.callControlId`
- The Telnyx recording API rejects the UUID with error 90015 "Invalid Call Control ID"
- `GET /v2/calls/{uuid}` and `GET /v2/texml_calls/{uuid}` both return 404

### The Solution: Webhook-to-DB Mapping

WebRTC SDK calls create two Call Control legs on Telnyx's backend:
1. **WebRTC→Telnyx leg** (signaling, ends after setup)
2. **Telnyx→PSTN leg** (stays active, this is what we need for recording)

The `call.initiated` webhook DOES fire for both legs with the real `call_control_id`. We capture the PSTN leg's ID and store it in `call_history`.

### Flow

1. **User places call** → `client.newCall()` → `call_history` created with `call_sid = WebRTC UUID`

2. **`call.initiated` webhook fires** (`telnyx-call-events`):
   - Checks if `payload.to` starts with `+` (phone number = PSTN leg)
   - If PSTN leg: searches `call_history` for recent outbound call matching `to_number`
   - Updates `call_sid` from the WebRTC UUID to the v3: Call Control ID
   - Log: `"PSTN leg detected, mapping call_leg_id to call_control_id: UUID -> v3:..."`

3. **Frontend polls for the resolved ID** (`useTelnyxCall.ts`):
   - When outbound SDK call becomes active and no Call Control ID is available from the SDK
   - Polls every 2 seconds (up to 5 attempts) for a recent outbound `call_history` entry with `call_sid LIKE 'v3:%'`
   - Stores resolved ID in `callState.pstnCallControlId`
   - Log: `"Resolved PSTN Call Control ID from DB: v3:..."`

4. **User presses Record/Pause/Resume**:
   - Frontend sends `callState.pstnCallControlId` (if resolved) or `callState.callId` (UUID fallback)
   - Edge function receives the ID

5. **Edge function resolves Call Control ID** (if UUID received):
   - Try 1: `GET /v2/calls/{uuid}` (usually 404)
   - Try 2: `GET /v2/texml_calls/{uuid}` (usually 404)
   - Try 3: **Query `call_history`** for recent outbound with `call_sid LIKE 'v3:%'` ← this works
   - Uses the resolved v3: ID for the Telnyx recording API

### Key Files

- **`supabase/functions/telnyx-call-events/index.ts`** — `call.initiated` handler maps WebRTC UUID to PSTN Call Control ID in `call_history`
- **`supabase/functions/telnyx-start-recording/index.ts`** — Starts recording. Has 3-step ID resolution (Telnyx API → TeXML API → DB lookup)
- **`supabase/functions/telnyx-pause-recording/index.ts`** — Pauses recording. Same 3-step ID resolution
- **`supabase/functions/telnyx-resume-recording/index.ts`** — Resumes recording. Same 3-step ID resolution
- **`src/hooks/useTelnyxCall.ts`** — Frontend polling logic in the outbound SDK call `"active"` handler. Also `toggleRecording` function that sends the ID

### Important Details

- **Two call legs**: WebRTC SDK calls create two Call Control legs. The WebRTC leg's `call_control_id` returns error "Call has already ended" because it ends after setup. Only the PSTN leg stays active.
- **PSTN leg detection**: In `call.initiated` webhook, `payload.to` starting with `+` indicates the PSTN leg (phone number). The WebRTC leg has `to` = SIP URI.
- **`call_leg_id` ≠ `call.id`**: The webhook's `payload.call_leg_id` is a different UUID from the SDK's `call.id`. Cannot match by UUID — must match by phone numbers and timing.
- **DB lookup pattern**: `call_history?direction=eq.outbound&created_at=gte.{5min_ago}&call_sid=like.v3%3A*&order=created_at.desc&limit=1`
- **Timing**: The frontend polls start 2 seconds after call connects. The webhook usually fires within 1-2 seconds. So by the time the user wants to record (~3+ seconds into call), the ID is available.

### Telnyx API Endpoints Used

- `POST /v2/calls/{call_control_id}/actions/record_start` — Start recording
- `POST /v2/calls/{call_control_id}/actions/record_pause` — Pause recording
- `POST /v2/calls/{call_control_id}/actions/record_resume` — Resume recording
- `GET /v2/calls/{id}` — Lookup call (works with call_control_id, NOT with WebRTC UUID)
- `GET /v2/texml_calls/{id}` — Lookup TeXML call (works with TeXML CallSid)

### Telnyx API Endpoints That DON'T Work

- `GET /v2/calls` (list all) — returns 404, endpoint doesn't exist
- `GET /v2/calls/{webrtc_uuid}` — returns 404, WebRTC UUIDs not recognized
- `GET /v2/texml_calls/{webrtc_uuid}` — returns 404, not a TeXML call

### Deploy Commands

```bash
npx supabase functions deploy telnyx-start-recording
npx supabase functions deploy telnyx-pause-recording
npx supabase functions deploy telnyx-resume-recording
npx supabase functions deploy telnyx-call-events
```
