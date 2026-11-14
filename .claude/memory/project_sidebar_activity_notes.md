---
name: project_sidebar_activity_notes
description: "Sidebar Mode panels added 2026-09-20: Activity (Recents|Recordings), Notes tab, compact Teammates; CallNotes/Contacts/ContactsView compact props"
metadata: 
  node_type: memory
  type: project
  originSessionId: d39d4353-9ee0-4f3c-8592-c23fd2645cef
  modified: 2026-09-20T16:36:51.993Z
---

Exe-only Sidebar Mode (see [[project_sidebar_mode]]) changes, 2026-09-20:

- **Activity panel** (`components/sidebar-mode/SidebarActivity.tsx`) replaces the
  old Recents panel that just embedded `CallHistory` (its max-w-4xl Card overflowed
  the 380px panel). Segmented Recents | Recordings with counts; 7px-avatar rows,
  text-xs, "Today 14:05" dates; Sparkles = AI summary (premium/enterprise), Play
  opens `RecordingPlayerModal` inside the sidebar window. Realtime on call_history
  + call_recordings. Strip item id stays "recents", label "Activity".
- **Notes panel** (id "notes", NotebookPen, premium/enterprise only via
  `canUseNotes`) renders `<CallNotes compact />`. `CallNotes` got a `compact` prop
  (no Card/header, smaller rows) — shared component, synced to web.
- **Teammates in the sidebar**: `ContactsView` + `Contacts` got `compact`. Compact
  `Contacts` is single-column (search + grouped list); tapping a teammate opens an
  in-place detail with a back arrow instead of the w-80 list + detail split, which
  never fit. Admin dropdown (assign/move/remove department) kept.
- Enterprise Notes tab (`EnterprisePlatform` case "notes") is now wrapped in
  `<div className="p-6">` in BOTH apps — the Card's top edge was flush with the
  header (Dashboard's container already had py-8).

Recording diagnostics (`recDiag`, `telnyx.socket.message` listener) were removed
from `useTelnyxCall.ts` the same day; `greencaller_telnyx_creds_v3` cache key stays.
Web `useTelnyxCall.ts` is still July's version (not synced — it diverges by PiP).
