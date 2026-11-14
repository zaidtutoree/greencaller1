---
name: sidebar-mode
description: Docked always-on-top strip + slide-out panels; two-window/one-registration architecture and why
metadata: 
  node_type: memory
  type: project
  originSessionId: a0c73f7d-c7a7-4c85-83a0-d040078be29f
  modified: 2026-09-18T14:04:22.889Z
---

Sidebar Mode (Electron-only, `greencallerapp1exe/` only — the web tree has no
Electron and already diverges here, like PiP and ringtones).

**Architecture decision (the important bit):** it is TWO BrowserWindows but ONE
telephony registration.
- `mainWindow` is *hidden*, never destroyed, while docked — it keeps the single
  `useCallProvider` WebRTC/SIP session, so switching modes never re-registers or
  drops media. It also keeps playing the ringtone (`IncomingCallModal` stays
  mounted), which is why the sidebar deliberately plays no audio of its own.
- `sidebarWindow` loads the same bundle at hash route `#/sidebar` →
  `src/pages/SidebarApp.tsx`, which **must never mount `useCallProvider`**. It
  mirrors call state in and posts actions out over IPC, the same pattern as the
  existing PiP card (`useCallPip`).
- Strip + slide-out panel are ONE window whose bounds grow/shrink (avoids
  z-order/focus bugs). Strip length == panel height so the strip never shifts.

**Why `sidebar:shell-ready` exists:** the app always launches on `/auth` (Auth.tsx
never auto-redirects an existing session), so restoring a persisted sidebarMode on
`did-finish-load` would hide the login form with no session to mirror. The main
process waits for the call shell (Dashboard / EnterprisePlatform) to report ready.

**Why `useSidebarMode({ enabled })` exists:** Dashboard renders EnterprisePlatform
for enterprise accounts, so both shells mount the hook. Only one may own the IPC
listeners; Dashboard passes `enabled: !!accountType && accountType !== "enterprise"`
and the disabled instance returns no cleanup (tearing down would clobber the owner).

**Sidebar ↔ floating PiP card:** the sidebar's Active Call panel has a pop-out
button that sends the `pip` action; the strip STAYS docked and collapses to the
rail (driven by `isPipActive` in the mirrored state), so the user gets both
surfaces. `pip-action "maximize"` therefore returns to whichever surface they
came from — the strip if docked, the full window otherwise — while `note` and
`transfer` always exit to the full app because they need real UI. The PiP card
carries the same controls as the minimised in-app card (mute/hold/keypad/
transfer/record/end); its DTMF keypad grows the window via `pip-keypad` rather
than overlaying. Transfer works because `ActiveCallPanel`/`ActiveCallModal` take
an optional controlled `transferOpen`/`onTransferOpenChange` pair.

**GOTCHA — never put `-webkit-app-region: drag` on the sidebar panel header.**
Inside the panel's animated (transformed) subtree Chromium mis-maps the no-drag
rects of child buttons, so the drag region silently swallows every header click
(notes, pop-out, "Open in full app", the × close) with no error anywhere. Adding
`position: relative` to the no-drag child does NOT fix it. The strip's grab
handle is the only drag region; the panel rides along with it. The strip's own
icon buttons work because the strip is not transformed.

**Dashboard mounts a phantom second call provider for enterprise accounts** (it
calls `useCallProvider` unconditionally, then returns `<EnterprisePlatform/>`
which calls it again). Pre-existing, left alone. But any hook that registers a
global IPC listener or drives a shared window MUST take an `enabled` flag and be
switched off in Dashboard for enterprise — `useSidebarMode` and `useCallPip` both
do (`enabled: !!accountType && accountType !== "enterprise"`). Without it the
child's effect runs first, the parent's registration wins the channel, and the
parent's inert call state drives the shared window.

**No toast surface while docked.** The full window is hidden, so every toast it
raises is invisible — which made recording look like a dead button (its whole
success/failure story is toasts plus a state flip that only happens on success).
`useSidebarMode` relays toasts over `sidebar:toast` into the strip. Keep that in
mind for any future feature whose only feedback is a toast.

**Call notes surfaces:** the same `call_notes` row (keyed by user_id + call_ref)
is edited from three places. `useCallNoteController` exposes `activeSession` so
the callRef is available WITHOUT opening the in-app dialog. The sidebar extends a
second panel (`AUX_W`, via `setExpanded(expanded, aux)`) and writes with
`saveCallNote` directly. The floating card has a notes drawer whose text travels
over IPC (`pip-note-load` / `pip-note-change` / `pip-note-text`) to the window
that owns the Supabase session — the note body uses its OWN channel, never the
`pip-state` payload, because state ticks every second and would clobber typing.

Prefs (`sidebarMode`, `dockEdge`, `stripX/stripY`) live in a plain JSON file at
`app.getPath("userData")/sidebar-mode.json` — no electron-store, because
`electron:compile` only renames `main.js`/`preload.js` to `.cjs`, so **all
main-process code must stay inside `electron/main.ts`** (package.json is
`type: module`, so a stray `.js` in electron-dist would be parsed as ESM).

See [[project_structure]], [[project_exe_taskbar_icon_and_pip]].

**Sidebar window is hidden, not destroyed, on exit → stale identity trap.**
`SidebarApp` originally read `supabase.auth.getSession()` once on mount, so after
logging out and in as another account the strip's Dialpad still showed the OLD
user's number (seen as "Calling from 02046203845" while logged in on ...844).
Fixed (Sept 2026): identity reloads on `onAuthStateChange` and on every
`sidebar:config` push (sent on each dock), and the Dialpad takes a `lineNumber`
override from the mirrored state so it always shows the line the hidden main
window is registered on.

**Toast relay gotcha:** `use-toast` keeps toasts in its store for ~16 min
(`TOAST_REMOVE_DELAY`), so the first relay after docking shipped the stale login
"Welcome back!" toast. `useSidebarMode` now seeds `lastToastId` when
`sidebarMode` flips true. In the sidebar window the global Radix toast viewport
is CSS-hidden (`html.gc-sidebar-window ol[role="region"]`) and `SidebarApp`
renders the newest toast as a compact `.gc-sb-notice` banner inside the open
panel (auto-dismiss 5s, dropped when no panel is open) — a 420px toast can't fit
the 56px strip and was cut off over the strip buttons.
