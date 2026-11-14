---
name: project_settings_modal
description: "Unified Settings modal (Profile/Audio/Ringtone tabs) + where each account type opens it, ringtone + audio-device wiring"
metadata: 
  node_type: memory
  type: project
  originSessionId: b0da3a16-9c05-49b7-b356-7e321617cdd2
---

Added 2026-07-02. A bigger tabbed Settings modal with a LEFT tab rail: **Profile / Audio Settings / Ringtone**.

## Component
`components/SettingsModal.tsx` (shared web+exe) — DialogContent max-w-4xl, h-560px, left rail + right scroll area. Props: `open, onOpenChange, userId, onProfileSaved?`.
- Profile tab → renders existing `ProfileSettings` (avatar/name/email/subscription) unchanged; onClose closes modal + calls onProfileSaved.
- Audio tab → `components/AudioSettings.tsx`: Input (mic `<Select>` + live 8-oval green VU meter via getUserMedia+AnalyserNode RMS) and Output (speaker `<Select>`, disabled if no setSinkId). Persists to localStorage via `utils/audioDevices.ts`.
- Ringtone tab → `components/RingtoneSettings.tsx` (rewritten, tab-friendly; was orphaned exe-only): 10 presets list + preview + custom upload.

## Where it opens
- **Enterprise**: replaced the old profile-only Dialog in `EnterprisePlatform.tsx` (trigger = top-right profile → `profileOpen`). Removed `ProfileSettings`/`Dialog` imports there.
- **Basic/premium**: `AppSidebar.tsx` footer — added a Settings gear button to the RIGHT of Logout (own gear row when sidebar collapsed) opening the modal. AppSidebar now tracks its own `userId`.

## Ringtone system (utils/ringtone.ts, shared) — expanded to 10
Was 4 presets (exe-only). Now 10: id `classic` renamed display "**Default**" (=public/ringtone.wav) + marimba/reflection/ripple + 6 new generated tones (beacon/chimes/aurora/cascade/pulse/crystal) via a generic `scheduleMelody` + playNote/playBell. No audio files needed. `getRingtonePreference` falls back to classic for unknown ids (back-compat with stored "classic"). **`IncomingCallModal` now calls `createRingtoneAudio()` instead of hardcoded `new Audio('/ringtone.wav')`** — this is the ONLY call-side change and it's isolated (ringtone is a plain <audio>, TelnyxRTC has ringtoneFile:undefined, so NO call-architecture impact).

## Audio device wiring (utils/audioDevices.ts) — safe/additive
Keys `selectedMicId`/`selectedSpeakerId` in localStorage (""=system default). `applySelectedSpeaker(el)` = setSinkId (guarded), `applySelectedMic(client)` = client.setAudioInDevice (guarded). Both try/catch + no-op on default so they CANNOT break calls. `useTelnyxCall` (both apps, hand-edited since files diverge by PiP): import + a useEffect([isClientReady]) that applies both and listens for `AUDIO_DEVICES_CHANGED`, plus applySelectedSpeaker at remote-audio element creation and at remote-stream attach. Changing a device dispatches AUDIO_DEVICES_CHANGED so live calls re-apply.

Both apps tsc clean 2026-07-02. Not yet pushed to GitHub / not yet in exe rebuild.
