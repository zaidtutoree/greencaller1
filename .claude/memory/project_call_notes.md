---
name: project_call_notes
description: "Per-call notes feature (premium/enterprise) — data model, where the button lives, and the Notes tab"
metadata: 
  node_type: memory
  type: project
  originSessionId: 691bf9f5-ad08-48fc-9130-af6115fda34b
---

Added 2026-06-12. Note-taking during calls for **premium + enterprise** accounts, with a Notes tab.

## Data model
Table `public.call_notes` (migration `supabase/migrations/20260612000000_add_call_notes.sql`, applied to project wofpxloehneavpoiqpal):
columns: id, user_id (FK profiles), `call_ref` (stable CLIENT-side id), call_history_id (nullable), phone_number, contact_name, direction, duration, note, created_at, updated_at. `UNIQUE(user_id, call_ref)`, RLS = own rows (+admin), updated_at trigger.

**Why call_ref instead of call_sid:** the backend swaps `call_history.call_sid` mid-call (WebRTC UUID → PSTN Control ID), so notes are keyed by a stable id minted in the UI (`crypto.randomUUID()`) when the call goes active. See [[project_recording_implementation]] for the call_sid churn.

## Frontend (shared between web + exe — keep in sync, see [[project_structure]])
- `hooks/useCallNotes.ts` — `getCallNote`, `saveCallNote` (upsert on user_id+call_ref; empty note deletes), `useCallNotes(userId)` list hook (realtime + update/delete).
- `hooks/useCallNoteController.ts` — owns per-call `callRef` + `direction`; pages call `markOutbound()`/`markInbound()` from their make-call/answer/pickup handlers (keeps call hooks untouched) and `openNotes()` snapshots live caller info.
- `components/CallNoteDialog.tsx` — the editor (autosaves on close). Takes live `duration` as its own prop (not in the stable session).
- `components/CallNotes.tsx` — the Notes tab: cards with direction icon, name/number, time, duration, note; inline edit + delete.
- Note button (NotebookPen) added to `ActiveCallPanel` + `ActiveCallModal` headers, gated `accountType === premium|enterprise`.
- Wired into Dashboard (route `/dashboard/notes` + AppSidebar item, requiresAccount premium) and EnterprisePlatform (tab `notes` in MainSidebar + TAB_TITLES + renderContent).

## Native PiP note action (exe only)
The native PiP window (see [[project_exe_taskbar_icon_and_pip]]) has a note button shown only when `canNote` is true; pressing it sends `pip-action: 'note'` → main.ts brings the app forward + closes PiP + forwards to renderer → `useCallPip` onNote → restores app and calls `notes.openNotes()`.

Gating note: enterprise users are always premium-or-above so canNote=true there; Dashboard derives it from accountType.

## Notes from Call History (added 2026-10-04)
Each Call History row (premium/enterprise) has a Note / Add note button
(`CallHistory.tsx`) that opens the same `CallNoteDialog`. Linking rule in
`findNoteForHistoryCall()` (`useCallNotes.ts`): a note made during the call has a
random `call_ref` and no `call_history_id`, so it is matched by the other party's
last-9 digits within ±10 min of the row's created_at; a note written from history is
keyed `call_ref = hist:<call_history.id>` and saves `call_history_id`. Re-opening a
row edits the matched note rather than creating a second. `CallNoteSession` gained
optional `callHistoryId` + `whenLabel`; `saveCallNote` accepts `callHistoryId`.
