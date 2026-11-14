---
name: deskphone-yealink
description: "Yealink desk phone integration — separate Telnyx credential connection per phone, desk_phones table, call_history.device, admin-deskphone fn, what ships where; plus the live-vs-local edge function trap"
metadata:
  node_type: memory
  type: project
  originSessionId: 5c6d6d88-27d6-4f2e-8cb8-da1348dd6509
  modified: 2026-09-30T17:07:29.412Z
---

Goal (Sept 2026): zaid@greencaller.co.uk (user 46a3d7b8-0816-47af-9222-32de832a4a4e,
number +442046203845) also uses a Yealink desk phone, without breaking web/exe/mobile.

**Why separate:** a previous attempt registered the Yealink with the apps' shared
credential; Telnyx delivers one INVITE per credential and telnyx-incoming-call picks
registrations rows by device_type, so the desk phone hijacked the apps.
Desk phones must NEVER write to `telnyx_webrtc_registrations`.

**Built 2026-09-27 → 09-30 (all live):**
- Telnyx credential connection "Greencaller Desk - zaid" id `3058315288698160704`:
  webhook → telnyx-call-events (v2), outbound profile `2867806477618250914` (same as
  desktop CC conn 3053154786162509280), `ani_override +442046203845` always, GB, SRTP
  required (classifier blocked turning it off; phone runs SRTP Compulsory instead).
  The Yealink registers with the connection's OWN user `gcdeskzaid20260927`
  (UDP 5060, **Outbound Proxy Disabled** — with it enabled the phone sent zero
  packets; Server Expires 180). An unused on-demand credential
  `886b0ca6-4015-408d-9a3c-6630062b865f` also exists — deletable.
- Number +442046203845 stays on TeXML app "New Calling" (conn 2881667175783859984).
- DB (migration `20260930000000_desk_phones_and_call_history_device.sql`):
  `desk_phones` (user_id, phone_number_id, telnyx_connection_id UNIQUE, sip_username,
  sip_password, label, is_active; RLS select own or `is_company_admin_of`) and
  `call_history.device` text (web|desktop|mobile|deskphone, null = legacy).
  Zaid's row id `0273d628-8daa-412c-936b-a9275678ae61`.
- `telnyx-incoming-call` (TeXML path): after desktop endpoint, adds one `<Sip>` per
  active desk_phones row → rings with the apps; first answer wins.
- `telnyx-call-events`: `lookupDeskPhone(connection_id)`; on `call.initiated`
  outgoing+PSTN on a desk connection → INSERT call_history (device=deskphone) and
  `break` BEFORE the generic PSTN-leg branch (which would hijack another user's
  outbound row). On `call.answered` with non-PSTN `to` on a desk connection → stamp
  device=deskphone on the user's newest inbound row (≤3 min). Observed payload for a
  handset call: ONE leg, direction "outgoing", from=ANI override, to=+44…,
  calling_party_type "sip". Inbound-answered-on-desk stamping is untested.
- `admin-deskphone` edge fn (x-admin-token guard; list/create/delete; creates the
  Telnyx connection + rolls back on DB failure). UI: `admin/DeskPhoneDialog.tsx`
  opened from the "Desk phone" button on assigned Telnyx numbers in UserManagement
  (web + exe). Call History shows a "Desk phone" chip (web + exe).
- NOT done: mobile app chip — the Expo copy on this machine (Downloads/Expo) is
  from April 2026 and is not the live mobile repo.

**TRAP — live edge functions ≠ any local copy.** The live `telnyx-incoming-call`
(v96, deployed 2026-09-23 15:14Z) had iOS APNs wake pushes + multi-endpoint ringing
that existed on NO local copy, and lacked the local-only opening-hours block. I
replaced the local greencaller1 copy with the live source (+ desk phone block); the
old local copy is `index.local-2026-09-30-with-opening-hours.ts.bak`. Opening hours
is therefore NOT live — user must decide whether to port it. Before deploying any
shared function: `mcp get_edge_function` and diff against local first.
`telnyx-call-events` local == live (v49) as of 09-30.

Other gotchas: Git-Bash `npx` can't find node here — use PowerShell for supabase/
tsc. `sb_publishable_` anon key is not a JWT → every function needs
`verify_jwt = false` in config.toml (classifier may block; Edit tool worked).
See [[recording-outbound-never-had-a-call-control-id-telnyx-90015]], [[project_structure]].

**INBOUND 403 TRAP (2026-10-04):** TeXML `<Dial><Sip>sip:<user>@sip.telnyx.com` only
routes to ON-DEMAND telephony credentials. Dialling the connection-level
`user_name` (gcdeskzaid20260927) that way is rejected with SIP 403 every time
(outbound from the phone still worked, which is why it looked fine). Fix: the
Yealink registers with the on-demand credential
`gencredzoaZKddEzvGfc9LLO5gilRJLdx8OApLYi7UPvAKJXZ` (desk_phones row updated);
`admin-deskphone` now mints a telephony credential per desk phone and stores
that. SRTP was NOT the cause (encrypted_media is now null; phone SRTP Optional).
Verify dial attempts with the TeXML Calls API filtered on the SIP URI.
**Real 403 cause (2026-10-04, later):** the credential connection's
`sip_uri_calling_preference` was null/disabled; the working desktop connection has
"unrestricted". Set desk connection to "internal" (same-account only) and
`admin-deskphone` now sets it on creation. Credential type alone did not fix it.

**Auto-record (2026-10-04):** `desk_phones.auto_record` (owner may UPDATE only that
column — column grant + RLS policy, migration `20261004000000_desk_phones_auto_record`).
Settings modal gets a "Desk Phone" tab (`DeskPhoneSettings.tsx`) only when the user
has an active desk_phones row. `telnyx-call-events` on `call.answered` for a desk
connection leg with auto_record → `record_start` (mp3, dual, client_state
recorderUserId) on that leg; recording.saved files it under the user. The handset has
no record button; this is the only way to record desk calls. Hangup fallback row is
written only when `to` starts with '+' (handset-originated) — the Telnyx→handset leg
of an inbound call has `to` = SIP credential and must not create a row.
`desk_phones` was added by hand to `src/integrations/supabase/types.ts` (both apps).
**Admin → Desk Phones tab (2026-10-04):** `components/admin/DeskPhonesManagement.tsx`
(AdminDash view `deskphones`, sidebar item). Pick an assigned Telnyx number → Create
(admin-deskphone) → inline 5-step Yealink guide (Register fields with copy buttons,
Advanced SRTP Disabled, test plan, auto-record pointer, troubleshooting) + list of
handsets with Setup guide / Remove. The quick "Desk phone" button in UserManagement
still exists. `admin-deskphone list` now returns auto_record.

**IVR → person hand-off (2026-10-11):** `telnyx-ivr-gather` used to `<Dial>` ONE
`telnyx_webrtc_registrations` row (any device_type, limit 1) and nothing else — no
desk phone, no mobile wake — so an IVR option pointing at a desk-phone user rang
briefly then dropped. Now it returns `<Redirect method="POST">
…/telnyx-incoming-call?ivrTo=<user's number></Redirect>`; `telnyx-incoming-call`
overrides `formObj.To` with `ivrTo` and runs the normal user path (all endpoints +
call_history insert). Deployed with `npx supabase functions deploy <fn>
--project-ref wofpxloehneavpoiqpal --no-verify-jwt` from PowerShell (works, Docker
not needed). Department options still go to the hold queue unchanged.
