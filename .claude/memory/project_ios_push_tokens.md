---
name: ios-push-tokens-logout
description: "Why an iPhone kept ringing for a logged-out account's number (stale device_tokens), the fix (logout hook + wakeIOS registration guard), and the 30-day credential-cache trap that forbids expiring registration rows on logout"
metadata:
  node_type: memory
  type: project
  originSessionId: 5c6d6d88-27d6-4f2e-8cb8-da1348dd6509
  modified: 2026-10-04T14:23:55.191Z
---

**Symptom (2026-10-02):** iPhone rang for +442046203845 whether logged out or
logged in as the ...844 account; other numbers behaved. Android fine.

**Cause:** `telnyx-incoming-call` wakes iPhones with a direct APNs VoIP push
(`wakeIOSDevice`, needs `WAKE_IOS_ENABLED`) looked up in `device_tokens` by
user_id. Mobile logout only disconnected the Telnyx client and never deleted
the device's `device_tokens` rows, so zaid's iPhone rows (platform `ios` +
`ios_alert`) survived every logout. CallKit rings on the push alone.

**Fix (2026-10-04):**
- Mobile repo `C:\Users\zaid\OneDrive\Documents\Greencallerexpoapp\Expo`
  (this is the LIVE mobile repo, and the live source of telnyx-incoming-call —
  not Downloads/Expo): new `lib/logoutHooks.ts`; `AuthContext.logout` runs
  hooks BEFORE `signOut` (RLS needs auth.uid()); `CallContext` registers a hook
  deleting this user's `device_tokens` rows for this device's platforms.
  Needs an EAS update / build to reach phones. Expo tsc has many pre-existing
  errors (CallState.isRecording etc.) — not from this change.
- `telnyx-incoming-call` `wakeIOSDevice`: skips the push when the user has no
  non-expired `telnyx_webrtc_registrations` mobile row. Deployed from
  greencaller1; the Expo repo copy was synced to the identical file.
- One-off: deleted zaid's two iPhone rows from `device_tokens`.

**OTA TRAP (2026-10-04):** `expo-task-manager` was added to the working tree after
the iOS 1.0.1 App Store binary (built 2026-09-14) — `lib/androidCallPush.ts`
imported it statically and `app/_layout.tsx`/`CallContext` import that file, so
every iOS EAS update threw at bundle load and expo-updates silently rolled back to
the embedded bundle (device kept logging `[bundle] CRED-TTL-30D-v3`). Fixed by a
lazy, Android-guarded `require('expo-task-manager')`. Verify an update really
applied by looking for the startup marker `[bundle] LOGOUT-TOKENS-v1` in app_logs.
Rule: any new native dep needs a new binary + runtime version before OTA.
Logout also rotates the mobile credential via telnyx-generate-token (deletes the
old one at Telnyx → kills Telnyx's own VoIP push, the generic "Incoming call"
screen) and clears the local credential cache.

**DO NOT expire `telnyx_webrtc_registrations` on logout.** `lib/telnyxService.ts`
caches the per-user credential for 30 days (`@telnyx_creds_cache_v1:`) and
reuses it on login WITHOUT calling telnyx-generate-token, so an expired row
would make incoming-call skip the mobile endpoint for up to a month.

Related: the on-login save path already strips the token from other users via
`cleanup_cross_user_device_tokens` RPC (SECURITY DEFINER). See [[deskphone-yealink]].
