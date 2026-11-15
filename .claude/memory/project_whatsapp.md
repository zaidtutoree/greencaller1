---
name: WhatsApp Business (Meta Cloud API direct)
description: Per-user WhatsApp tab — admin grants it on a number, user connects THEIR OWN Meta business via Embedded Signup in-page, chat + business profile in-app. Meta bills the customer. Tables, functions, secrets, Meta app setup, traps.
type: project
---

## Decision history
- 2026-11-15: first built on Telnyx's WhatsApp API (hosted signup). Blocked: Telnyx's own portal
  button uses Telnyx's Meta app; getting it into Greencaller needs a Greencaller Meta Tech Provider
  app linked by Telnyx support anyway. Zaid chose to **go direct to Meta** so customers own their
  WABA and Meta bills them (no Telnyx markup / support ticket). Telnyx code removed same day.
- PDL CRM (`C:\Users\zaid\Downloads\PDLU`) looks similar but its Connect button is a bare link to
  business.facebook.com; numbers were onboarded by hand in the Telnyx portal. Not a reference.

## What it is
Admin dashboard → **WhatsApp** tab grants a user WhatsApp on one of their numbers. The user's
**WhatsApp** tab (basic/premium route `/dashboard/whatsapp`; enterprise `MainSidebar` tab
`whatsapp`) opens Meta's Embedded Signup popup (Facebook JS SDK, `FB.login` with `config_id`,
`response_type: 'code'`); the customer logs into THEIR Facebook, creates THEIR portfolio + WABA,
registers the assigned number (OTP by voice call → answered in Greencaller, or SMS). The popup's
`WA_EMBEDDED_SIGNUP` FINISH message gives `waba_id`/`phone_number_id`; the login callback gives a
30-second `code`. Frontend posts both to `whatsapp-connect {action:"complete"}`.

## Pieces
- Migrations `20261115000000_create_whatsapp.sql` (tables) + `20261116000000_whatsapp_meta_direct.sql`
  (`business_id`, `name_status`, `whatsapp_secrets` service-only table for the business token + PIN,
  private storage bucket `whatsapp-media` with per-user folder read policy).
- `supabase/functions/_shared/meta-whatsapp.ts` — Graph helper (`graph()`, `graphError`, `isAuthError`,
  `copyMediaToStorage`, field lists). Graph version pinned in `GRAPH_VERSION`.
- Edge functions (all `verify_jwt = false`):
  - `admin-whatsapp` (x-admin-token): readiness (secrets, app token check via `/{app_id}`, app
    webhook subscription via `/{app_id}/subscriptions`), setup (POST subscription → Meta immediately
    GETs the webhook with hub.challenge, so deploy the webhook first), list / enable / disable / remove.
  - `whatsapp-connect` (user JWT): config, status, complete (code→token, `POST /{waba}/subscribed_apps`,
    verify `display_phone_number` matches the assigned number, `POST /{pnid}/register {pin}`, cache
    profile), reset, profile, update-profile (`whatsapp_business_profile`; display name via
    `POST /{pnid}?new_display_name=`), upload-photo (Resumable Upload API → `profile_picture_handle`),
    templates (`/{waba}/message_templates?status=APPROVED`), media (lazy copy to storage), mark-read.
  - `whatsapp-send` (user JWT): `POST /{pnid}/messages` text | template | media-by-link. Stores wamid in
    `whatsapp_messages.foreign_id` (the `telnyx_message_id` column is now unused).
  - `meta-whatsapp-webhook` (public): GET handshake (`META_WEBHOOK_VERIFY_TOKEN`), POST with
    `X-Hub-Signature-256` HMAC check (skipped only if `META_APP_SECRET` unset). Handles `messages`
    (inbound + statuses, media copied to storage immediately — Meta URLs die in 5 min),
    `phone_number_name_update` (re-registers number on APPROVED), logs `account_update`.
- Frontend: `components/WhatsAppView.tsx` (user), `components/admin/WhatsAppAdmin.tsx` (admin),
  copied to exe. Connect is disabled inside Electron (FB popup) — connect from greencaller.app.

## Secrets (Supabase → Edge Functions → Secrets)
`META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID` (Facebook Login for Business → Configurations →
Embedded Signup config), `META_WEBHOOK_VERIFY_TOKEN` (any random string). Redeploy functions after setting.

## Meta app setup Zaid must do once
1. Meta Business portfolio for Greencaller + business verification (needed for Advanced Access).
2. developers.facebook.com → app type **Business**, add **WhatsApp** product + **Facebook Login for
   Business**. App Review: Advanced Access for `whatsapp_business_messaging`,
   `whatsapp_business_management`. WhatsApp → "Become a Tech Provider" onboarding. Live mode.
3. Facebook Login for Business → Settings: enable Client OAuth, Web OAuth, JS SDK login, Enforce HTTPS;
   **Allowed Domains for the JavaScript SDK** must include `greencaller.app` (and any preview domain).
   Configurations → create a *WhatsApp Embedded Signup* config → Config ID.
4. Set the four secrets, deploy `meta-whatsapp-webhook` first, then admin tab → **Run setup**
   (registers callback `…/functions/v1/meta-whatsapp-webhook` with fields messages,
   account_update, phone_number_name_update). Readiness goes green.
5. Customers must add a payment method in WhatsApp Manager (tech-provider model: Meta bills them).
   Error 131030 on send = still in test mode / no payment method.

## Traps
- Business token from code exchange is a *business integration system user token* (non-expiring
  unless the ES config is the "60-day expiration" template). Auth errors (190/102) flip the account
  to `failed` with "reconnect".
- Register error 133005 = number already has a two-step PIN → user must disable two-step in
  WhatsApp Manager, reset, reconnect. We generate + store the PIN so re-registration (after display
  name approval) works.
- Display-name change: Meta review, then re-register within 14 days (webhook does it).
- Inbound `from` is digits without "+"; we store E.164. Outbound `to` sent without "+".
- 24-h window: error 131047 → template required. Templates are created in WhatsApp Manager (no UI here).

## Not done / ideas
- Sending media from the UI (function supports `media_url`), template creation, coexistence signup,
  deregistering on remove, Electron connect (open in browser instead).
