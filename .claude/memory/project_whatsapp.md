---
name: WhatsApp Business (Telnyx)
description: Per-user WhatsApp tab — admin grants it on a Telnyx number, user connects via Telnyx hosted Meta Embedded Signup, chat + business profile in-app. Tables, functions, prerequisites, traps.
type: project
---

## What it is (built 2026-11-15, not yet deployed/tested live)
Admin dashboard → **WhatsApp** tab grants a user WhatsApp on one of their Telnyx numbers. The user then
gets a **WhatsApp** tab (basic/premium `AppSidebar` route `/dashboard/whatsapp`; enterprise `MainSidebar`
tab `whatsapp`) where they: click Connect (opens Telnyx **hosted signup** = Meta Embedded Signup on
`acct.fyi`), register the assigned number, then send/receive messages and edit the business profile
(photo, display name, about, description, category, email, website, address).

## Pieces
- Migration `supabase/migrations/20261115000000_create_whatsapp.sql`: `whatsapp_accounts` (user_id PK,
  SELECT-only for users — all writes via service role so users can't self-enable), `whatsapp_conversations`
  (users may UPDATE own rows: mark read / rename), `whatsapp_messages` (read-only), `whatsapp_config`
  (service only; holds `messaging_profile_id`, `signup_webhook_set`). All three user tables are in the
  realtime publication.
- Edge functions (all `verify_jwt = false` in config.toml):
  - `admin-whatsapp` (x-admin-token): readiness / setup / list / enable / disable / remove.
  - `whatsapp-connect` (user JWT): status (polls Telnyx signup session, finalises), start, reset, profile,
    update-profile, upload-photo (base64 → multipart), delete-photo, templates.
  - `whatsapp-send` (user JWT): text | template | media → `POST /v2/messages/whatsapp`, stores row.
  - `telnyx-whatsapp-webhook` (public): message.received (WHATSAPP → store; SMS → OTP capture),
    message.sent/finalized/read → status, `whatsapp.waba_added` → signup state. Optional Ed25519 check
    when `TELNYX_PUBLIC_KEY` secret is set.
- Frontend: `components/WhatsAppView.tsx` (user), `components/admin/WhatsAppAdmin.tsx` (admin). Both copied
  to the exe app. `Dashboard.tsx` / `EnterprisePlatform.tsx` edited by hand in each app.

## Prerequisites Zaid must do once (the feature is dead without them)
1. Meta: Business account + a **Business-type app** with `whatsapp_business_messaging` and
   `whatsapp_business_management` (Advanced Access for prod), complete **Tech Provider** onboarding, app in Live mode.
2. Email Telnyx support with the Meta App ID + business name → accept Meta partner invite.
   Verify with `GET /v2/whatsapp/foreign_apps` (enabled + solution_id). Admin tab shows this as "Meta app linked".
3. Supabase secret `TELNYX_WHATSAPP_APP_ID` = that App ID. (`TELNYX_API_KEY` already exists.)
4. Admin tab → **Run setup**: creates messaging profile "Greencaller WhatsApp" (webhook → our function)
   and `PATCH /v2/whatsapp/user_data` signup webhook.
5. Deploy the 4 functions from repo root; run the migration.

## Telnyx/Meta facts that shaped the design
- Hosted signup: `POST /v2/whatsapp/hosted_signups {app_id, expires_at≤3d}` → `{id, url}`; no return URL,
  so the UI polls `GET /v2/whatsapp/signup/{id}/status` every 4 s. `state` steps: SUBSCRIBE_WEBHOOKS →
  ASSIGNED_USERS → SHARE_CREDIT_LINE → REGISTER_PHONE_NUMBER → ADD_WABA_TO_DB → ADD_PHONE_NUMBERS_TO_DB → COMPLETE.
- The customer types the number themselves in Meta's popup — we can't pre-fill it. UI shows the assigned
  number big + copy button; `finalize` checks `GET /v2/whatsapp/phone_numbers/{assigned}` and fails with a
  clear message if they registered a different number.
- Meta's OTP goes to the number by SMS or voice. SMS lands on the messaging profile webhook → we store
  `last_otp_code` and show it in the tab (`enable` tries `PATCH /v2/phone_numbers/{id}/messaging` to put the
  number on our profile; non-SMS numbers fall back to voice → answered in Greencaller normally).
- Inbound WhatsApp routing needs `PATCH /v2/whatsapp/phone_numbers/{n}/profile {profile_id}` after signup
  (done in finalize). Sending needs no profile; `from` resolves it.
- Free text only inside the 24-hour window after the customer's last message; otherwise an **approved
  template** (`GET /v2/whatsapp/message_templates?filter[status]=APPROVED`). UI banner + template dialog.
- Common signup failures: SHARE_CREDIT_LINE ("already using a payment method" → WABA has its own billing;
  month-end close → retry), number active on WhatsApp app → needs Coexistence (not implemented).
- Inbound payload shape is only partially documented (`payload.body.text.body`, `body.<type>.url|id`,
  `body.foreign_id`); webhook parser is defensive. `raw` column keeps the full payload — check it first when
  something doesn't render.

## Not done / ideas
- Sending media (function supports `media_url`, UI doesn't). Downloading non-prefetched media
  (`GET /v2/whatsapp/media/{phone}/{id}`) — stored as `telnyx-media:<id>` placeholder.
- Coexistence signup type; template creation UI; deregistering number on remove.
