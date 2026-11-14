---
name: project_slack_integration
description: Slack integration — per-company OAuth connect (Phase 1 done); planned missed-call DM notifications + click-to-call
metadata: 
  node_type: memory
  type: project
  originSessionId: b0da3a16-9c05-49b7-b356-7e321617cdd2
---

Started 2026-07-15. Slack integration for ENTERPRISE companies. Decisions: connection is **per company** (company_name); call notifications are **DM'd to the specific user** who owns the number.

## Slack app
Created via manifest (JSON) at api.slack.com. Bot scopes: chat:write, chat:write.public, commands, users:read, users:read.email, im:write. Slash command **`/gcall`** (`/call` is reserved by Slack — rejected). Interactivity + OAuth redirect point to Supabase functions. Secrets set (hashes only shown): `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

## Data model (migration 20260715000000)
- `slack_integrations` (PK company_name): team_id, team_name, bot_token, installed_by, default_channel_id. RLS on, NO policies → service-role only (bot_token never reaches clients).
- `slack_oauth_states`: CSRF nonce (state PK, company_name, user_id, expires_at 10 min).
- `slack_user_links`: cache user_id→slack_user_id for DMs (not populated yet; Phase 2 will lazily fill via users.lookupByEmail).
NOT added to types.ts (frontend never queries these directly — all via edge functions).

## Phase 1 (DONE, deployed) — connection
- `slack-connect` (verify_jwt TRUE): actions `start` / `status` / `disconnect`. Gated to account_type='enterprise' + company_name. `start` creates a state nonce and returns the Slack authorize URL. TODO: could tighten `start`/`disconnect` to is_company_admin only.
- `slack-oauth-callback` (verify_jwt FALSE — Slack redirects browser here): validates+consumes state, POSTs `oauth.v2.access` (client_id/secret/code/redirect_uri), upserts slack_integrations, returns an HTML success page.
- Redirect URI = `https://wofpxloehneavpoiqpal.supabase.co/functions/v1/slack-oauth-callback` (matches manifest).
- UI: `components/SlackIntegration.tsx` (Connect via popup + poll status + disconnect) in a new **Integrations** tab of `SettingsModal` — shown only when `isEnterprise` prop is true (passed from EnterprisePlatform; AppSidebar/basic-premium don't get it). Verified: callback returns HTML page, slack-connect returns 401 for anon.

## Phase 2 (DONE, deployed) — missed-call DM + per-user link
- `slack-notify` (verify_jwt FALSE, shared-secret `x-webhook-secret` = `SLACK_WEBHOOK_SECRET` env): on {type:'missed_call', user_id, from_number, created_at} → profile → company slack_integrations bot_token → resolve slack_user_id (slack_user_links cache, else users.lookupByEmail) → conversations.open → chat.postMessage (Block Kit: "Missed call" + "Call back" URL button to /dashboard/dialpad?number=). GOTCHA: `users.lookupByEmail` needs a QUERY param, NOT JSON body (JSON → invalid_arguments).
- DB trigger `slack_notify_missed_call_trg` on call_history (AFTER INSERT/UPDATE, status='missed', inbound, has user_id) → pg_net net.http_post → slack-notify. Migration 20260715100000 (secret redacted in file; real value applied). **Call flow untouched.**
- **Per-user link** (solves "Slack email ≠ app email"): reuses the OAuth flow — Slack's `oauth.v2.access` always returns `authed_user.id` (the authorizer's Slack id), NO extra scopes/config needed. slack_oauth_states got a `mode` column ('install'|'link'). slack-connect action `link` → authorize URL with mode='link'. Callback: mode='link' → store slack_user_links{user_id, slack_user_id=authed_user.id}; mode='install' → store integration AND auto-link the installer. `status` action now also returns `linked`. UI: SlackIntegration.tsx shows a "Link your Slack" per-user section when connected.
- Tested: slack-notify reaches Slack correctly (mike@clinic5.com not in the workspace → users_not_found, expected). Live DM works once a user links (captures their real slack id regardless of email).

## Planned next
- Phase 2: missed-call DM — Supabase DB webhook/trigger on `call_history` status='missed' → `slack-notify` edge fn → users.lookupByEmail → conversations.open → chat.postMessage (Block Kit + "Call back" button). Also voicemails + AI summaries. KEY: use DB webhooks so the call flow (telnyx-incoming-call) is NEVER touched.
- Phase 3: click-to-call via `/gcall` (`slack-commands`) + interactivity (`slack-interactivity`) — must verify Slack signing secret. Two dial options: Supabase Realtime signal to open app (simple) or Telnyx Call Control callback (robust).

Both apps tsc clean 2026-07-15. NOT pushed to GitHub / not in exe rebuild yet.
