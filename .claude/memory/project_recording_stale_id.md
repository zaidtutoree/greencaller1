---
name: recording-outbound-never-had-a-call-control-id-telnyx-90015
description: "Outbound recording 90015 root cause: SIP connection without webhook issues no Call Control IDs; fixed with a desktop-only Call Control connection + active_calls lookup for on-net calls"
metadata:
  type: project
---

Symptom: `record_start` failed with Telnyx **90015 "Invalid Call Control ID"** on
every outbound call from the exe (inbound worked). Fixed 2026-09-20.

## Real root cause (supersedes the earlier telnyxIDs theory)

The SDK's `call.telnyxIDs` fix was correct code but could never fire: Telnyx sent
`telnyx_leg_id`/`telnyx_session_id` on ringing/media/answer but never
`telnyx_call_control_id`, and no `call.initiated` webhook fired. A credential
connection **without a webhook URL is plain SIP trunking** — Telnyx issues no
Call Control IDs and sends no `call.*` webhooks for its calls. The exe's
credentials sat on the shared "Default Credential Connection 2" (no webhook).

## Fix

- `telnyx-generate-token`: for `deviceType: "web"` only, provision/use
  "Greencaller Desktop (Call Control)" (id 3053154786162509280) with
  `webhook_event_url` → telnyx-call-events, `webhook_api_version "2"`, outbound
  profile attached. Mobile untouched. Connection `user_name` must be alphanumeric.
- Exe cache key bumped to `greencaller_telnyx_creds_v3` to force a re-mint (30-day
  localStorage cache otherwise keeps the old connection).
- On-net calls (own number → own number) have NO PSTN leg and the SDK gets no ids
  at all; `telnyx-start-recording` Pass 0c resolves the inbound TeXML leg via
  `GET /v2/phone_numbers?filter[phone_number]` → `connection_id` →
  `GET /v2/connections/{id}/active_calls` → newest live leg (call_events carried
  no from/to, so it's the "newest" heuristic) → `is_alive` → record_start.
  TeXML Calls list API is CDR-only (ended calls) — useless for live lookup.

## Traps
- The LIVE copy of `telnyx-generate-token` was the expo repo's (30-day TTL). The
  greencaller1 copy had 1-hour TTL; deploying it broke iOS inbound (row expires →
  incoming-call skips mobile endpoint). Restored; both copies identical now.
  **Diff the expo copy before deploying shared functions.** See
  [[project_structure]].
- Exe calls generate-token twice on launch (race) — registrations row may hold a
  username the exe isn't registered as. Unfixed.

Write-up: `greencallerapp1exe/.claude/recording_call_control_id_fix.md`.
Background: [[project_recording_implementation]].
