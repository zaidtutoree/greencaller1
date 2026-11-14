---
name: project_opening_hours
description: Opening Hours settings tab (all users) + out-of-hours voicemail; guarded telnyx-incoming-call integration
metadata: 
  node_type: memory
  type: project
  originSessionId: b0da3a16-9c05-49b7-b356-7e321617cdd2
---

Added 2026-07-07. A 4th tab in the Settings modal ([[project_settings_modal]]): **Opening Hours**. Optional (off by default). When a user enables it, callers who ring their number OUTSIDE the set hours go straight to voicemail with a custom out-of-hours message.

## Data model
Table `public.opening_hours` (migration 20260707100000): user_id PK (FK profiles, one row per user), enabled bool default false, timezone text default 'Europe/London', hours jsonb `{ mon:{open,start,end}, ... }` (keys mon..sun, start/end "HH:MM"), voicemail_message text. RLS: user manages own row. In types.ts (both apps). Frontend upserts directly (RLS). NOTE `hours` is jsonb typed as Json in types → cast `as any` on write, `as unknown as HoursMap` on read.

## UI
`components/OpeningHours.tsx` (shared): enable Switch, timezone Select, per-day open/closed Switch + time inputs, out-of-hours voicemail message textarea, Save (upsert). Tab added to `SettingsModal.tsx` (id "hours"). Available to ALL users (the Settings modal is reachable by every tier).

## Call-flow integration (GUARDED — does nothing unless enabled)
- `telnyx-incoming-call/index.ts`: added module fn `isOutsideHours(oh)` (computes weekday+HH:MM in oh.timezone via Intl.DateTimeFormat en-GB; fails OPEN on error). In the `assigned_to` branch, right AFTER the can_make_calls gate and BEFORE the normal 'ringing' call_history insert: query `opening_hours` for the user; if `enabled && isOutsideHours` → insert call_history status 'missed' + `<Redirect>` to `telnyx-voicemail-twiml?...&closed=1`. No row / enabled=false → completely unchanged normal flow (SIP dial etc.).
- `telnyx-voicemail-twiml/index.ts`: reads `closed=1`; when set, `getOutOfHoursMessage(to)` looks up phone_numbers.assigned_to → opening_hours.voicemail_message and uses it (xmlEscape'd) as the `<Say>` greeting before `<Record>` (fallback default closed message). Normal voicemail path unchanged.

Both deployed + tested. Verified end-to-end 2026-07-07 by POSTing a simulated TeXML webhook (form-urlencoded From/To/CallSid) to telnyx-incoming-call → returns the `&closed=1` voicemail Redirect when outside hours. Both apps tsc clean.

BUG FIXED (2026-07-07): `supabaseQuery()` in telnyx-incoming-call returns `{ data, error }`, NOT the array — must destructure `const { data: ohRows } = await supabaseQuery(...)`. First version wrote `const ohRows = await supabaseQuery(...)` so `Array.isArray(ohRows)` was false and the opening-hours branch was silently skipped (calls rang normally). The isOutsideHours logic itself was always correct (probe-verified: Tue 16:44 with tue end 16:00 → outside=true).

NOT pushed to GitHub / not in exe rebuild yet.
