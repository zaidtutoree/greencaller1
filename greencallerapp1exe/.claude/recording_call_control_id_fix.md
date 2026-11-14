# Recording: Telnyx 90015 "Invalid Call Control ID" — root cause and fix (2026-09-20)

## Symptom

Pressing **Record** in the exe on an outbound call always failed with

```
telnyx-start-recording: Failed to start recording:
{ "errors": [ { "code": "90015", "title": "Invalid Call Control ID" } ] }
```

Inbound recording worked. Every attempted fix on the frontend (reading
`call.telnyxIDs`, `call.options.telnyxCallControlId`, polling `call_history`
for a `v3:` id, the `call.initiated` webhook mapping) made no difference.

## Diagnosis

A temporary relay was added to `src/hooks/useTelnyxCall.ts` that wrote every
`telnyx_rtc.ringing / media / answer` signalling message, the `telnyxIDs`
snapshot at call-active, and the id sent on Record into `app_logs`
(session `exe-rec-diag`). One real call showed the whole story:

```
[sdk] telnyx_rtc.ringing  ccid=-  leg=464cf99c-…  sess=464ceb78-…
[sdk] telnyx_rtc.media    ccid=-  …
[sdk] telnyx_rtc.answer   ccid=-  …
[active] telnyxIDs={"telnyxSessionId":…,"telnyxLegId":…}   <- no telnyxCallControlId
[record] sending=c51a07c1-… (WebRTC UUID)
```

Telnyx sent `telnyx_leg_id` and `telnyx_session_id` but **never
`telnyx_call_control_id`**, and no `call.initiated` webhook fired for the
outbound leg. So there was nothing the SDK, the DB poll, or the edge function
could ever find.

### Root cause

The exe's SIP credential lived on the shared credential connection
("Default Credential Connection 2"), which has **no webhook URL**. Telnyx's
SIP-connection docs: *"When setting a webhook url, it treats the call type as
programmable and not SIP trunking."* Without a webhook the connection is plain
SIP trunking: no Call Control IDs are issued for its calls, no `call.*`
webhooks are sent, and the SDK never receives `telnyx_call_control_id`.
Outbound recording had been structurally impossible, not a timing bug.

(Inbound worked because that leg is created by the destination number's TeXML
app, and `telnyx-incoming-call` passes its CallSid to the SIP endpoint as the
`X-PSTN-Call-Sid` header.)

## Fix 1 — desktop-only Call Control connection (`telnyx-generate-token`)

For `deviceType: "web"` only, the function now provisions and uses a dedicated
credential connection **"Greencaller Desktop (Call Control)"**
(id `3053154786162509280`) with:

- `webhook_event_url` / `webhook_event_failover_url` -> `telnyx-call-events`
- `webhook_api_version: "2"`, `webhook_timeout_secs: 25`
- the outbound voice profile attached (`outbound.outbound_voice_profile_id`)

It is found by name (or pinned with a `TELNYX_WEB_CONNECTION_ID` secret),
created if missing, and its webhook/profile are re-patched if they drift. If
creation fails it falls back to the old shared connection. **Mobile
(`deviceType: "mobile"`) is untouched**: same connection and code path as
before, so the iOS background-call flow is unaffected.

Gotcha hit on the way: Telnyx rejects a connection `user_name` containing
underscores ("Must contain only letters and numbers"); it is now `gcweb<ts>`.

With the webhook in place, on an external call:

- `call.initiated` fires for the PSTN leg -> `telnyx-call-events` rewrites the
  outbound `call_history.call_sid` from the WebRTC UUID to the `v3:` id
  (existing handler);
- the exe's poll picks it up as `pstnCallControlId` and sends it on Record;
- `telnyx_rtc.answer` now also carries `telnyx_call_control_id`.

### Forcing the exe to re-mint

The exe caches SIP credentials in `localStorage` for 30 days, so a server-side
change alone does nothing until the cache lapses. The cache key was bumped
(`greencaller_telnyx_creds_v1` -> `..._v3`) to force one re-mint on next
launch. Do the same whenever desktop credentials must move connection.

### Regression caught and reverted during the work

The copy of `telnyx-generate-token` that was live came from the **expo repo**
(`Greencallerexpoapp/expo/supabase/functions/`) with a **30-day** credential
TTL; the greencaller1 copy still had **1 hour**. The first deploy from
greencaller1 shipped the 1-hour TTL for ~10 minutes. With a 1-hour TTL the
`telnyx_webrtc_registrations` row expires, `telnyx-incoming-call` skips the
mobile endpoint and inbound mobile calls go straight to voicemail. The 30-day
TTL is restored and both repo copies are now identical. **Diff the expo copy
before deploying any shared function from greencaller1.**

## Fix 2 — internal (on-net) calls (`telnyx-start-recording`)

Calling one Greencaller number from another (e.g. 02046203844 -> 02046203845)
still failed after Fix 1. Telnyx routes on-net calls straight into the
destination number's TeXML app: no PSTN leg, no `call.initiated`, and the SDK
gets **no** Telnyx ids at all (`telnyxIDs={}`). The only recordable leg is the
inbound TeXML call, which only the receiver knows (`X-PSTN-Call-Sid`).

Two resolution passes were added before the existing fallbacks:

- **Pass 0b — TeXML Calls API** (`GET /v2/texml/Accounts/{sid}/Calls?From&To`).
  Turned out to be CDR-like: it only lists *ended* calls. Left in as a cheap
  extra fallback; it will not resolve a live call.
- **Pass 0c — active calls (this is what works).**
  1. `GET /v2/phone_numbers?filter[phone_number]=<to E.164>` -> the destination
     number's `connection_id` (its TeXML app).
  2. `GET /v2/connections/{connection_id}/active_calls` -> live legs, newest
     first (`call_duration` ascending).
  3. For each leg, `GET /v2/call_events?filter[leg_id]=...` to confirm from/to.
     In practice the events carried no from/to (`sawNumbers=false`), so the
     function falls back to the **newest live call on that connection**
     (<= 10 min old), verified with `GET /v2/calls/{id}` `is_alive`.
  4. `record_start` on that leg.

Known limitation: with two simultaneous internal calls into the *same* number
the "newest" heuristic could pick the wrong leg. If that matters, match
`call_duration` against the exe's `call_history.created_at`, or find a
from/to source (the TeXML webhook to `telnyx-incoming-call` carries the
caller's WebRTC id as `SipHeader_X-RTC-CALLID`, but that function is deployed
from the expo repo and must not be touched from here).

Recorder attribution needs nothing extra: `telnyx-start-recording` writes a
`recording_attribution_hints` row (user + from/to digits) and a BEFORE-INSERT
trigger on `call_recordings` uses it, direction-agnostic.

## Verified

- External call, exe -> mobile: `record_start OK` (twice).
- Internal call, exe -> other Greencaller number answered on the phone:
  `Resolved from active_calls (unconfirmed newest)` -> `record_start OK` (twice).
- Inbound recording unchanged.

## Deployed / changed

| What | Where | Note |
|---|---|---|
| `telnyx-generate-token` v38 | `greencaller1/supabase/functions/` **and** expo copy (identical) | desktop CC connection, 30-day TTL kept |
| `telnyx-start-recording` v57 | `greencaller1/supabase/functions/` | Pass 0b + 0c; expo copy is an older lineage, left alone |
| `src/hooks/useTelnyxCall.ts` | `greencallerapp1exe` | cache key `_v3`; `recDiag` relay + `telnyx.socket.message` listener (TEMP, remove) |
| Telnyx | account | new credential connection "Greencaller Desktop (Call Control)" |

Not deployed / not touched: `telnyx-incoming-call` (iOS wake lives there).

## Cleanup still to do

- Remove the `recDiag` helper, the `telnyx.socket.message` listener and the
  `[active]` / `[record]` relay lines from `useTelnyxCall.ts`, then rebuild.
- Remove `recDebug` from `telnyx-start-recording` (it was already there as a
  TEMP aid) once nobody needs `app_logs` for this.
- Sync `useTelnyxCall.ts` to `greencallerapp1/src/`: the web app copy is from
  July and has none of the `telnyxIDs` / poll-scoping / cache-key changes.
- Separate bug noticed: the exe calls `telnyx-generate-token` **twice** on
  launch (~130 ms apart); the registrations row keeps whichever finished last,
  which may not be the credential the exe registered with, so
  `telnyx-incoming-call` can dial a username nobody is registered as.

## Useful diagnostics

```sql
-- what the SDK saw and what was sent on Record (needs the TEMP relay)
select ts, session_id, message from app_logs
where session_id in ('exe-rec-diag','edge-start-recording')
order by ts desc limit 30;
```

`telnyx-debug-credentials` (GET, anon key) lists credential connections;
Telnyx `active_calls` and `GET /v2/calls/{id}` are the live-call sources.
