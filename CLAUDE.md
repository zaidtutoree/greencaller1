# Greencaller — project guide for Claude Code

Business phone system (web app + Windows desktop app + separate mobile app) built on
Telnyx (WebRTC/SIP/TeXML), Supabase (Postgres, edge functions, realtime) and Stripe.

Detailed, per-feature notes live in `.claude/memory/*.md` (index in `.claude/memory/MEMORY.md`).
**Read the relevant note before touching a feature** — they record Telnyx/Stripe API quirks and
traps that cost real debugging time. Keep those notes updated when behaviour changes.

## Repo layout (this folder IS the git repo root)

```
greencaller1/                 ← git root, github.com/zaidtutoree/greencaller1
├── greencallerapp1/          ← Web app (React + Vite). Deployed to greencaller.app via Netlify
│   ├── src/                  ← Frontend code
│   └── supabase/             ← LEGACY copy — never deploy from here
├── greencallerapp1exe/       ← Windows desktop app (same React code + Electron)
│   ├── src/                  ← Frontend code (kept in sync with greencallerapp1/src/ by hand)
│   ├── electron/main.ts      ← ALL main-process code lives in this one file (see sidebar note)
│   ├── scripts/generate-icon.cjs ← regenerates the ICO correctly (never use png-to-ico)
│   └── supabase/             ← LEGACY copy — never deploy from here
├── supabase/                 ← SHARED backend: edge functions, migrations, config.toml
├── release/publish.sh        ← installer upload script (the .exe installers are gitignored)
├── netlify.toml              ← tells Netlify the web app lives in greencallerapp1/
└── .claude/memory/           ← Claude Code memory notes (copied into the repo on purpose)
```

Both apps use the same Supabase project `wofpxloehneavpoiqpal`.

## Hard rules

1. **Deploy edge functions only from this root folder**:
   `npx supabase functions deploy <fn> --project-ref wofpxloehneavpoiqpal` (add `--no-verify-jwt`
   for webhook-called functions; every function needs `verify_jwt = false` in config.toml because
   the `sb_publishable_` anon key is not a JWT). Use PowerShell, not Git Bash, for npx/tsc.
2. **Before deploying a shared function, diff local against live** (`mcp get_edge_function`).
   The live mobile repo (`C:\Users\zaid\OneDrive\Documents\Greencallerexpoapp\Expo`) has also
   deployed `telnyx-incoming-call` and `telnyx-generate-token`; a stale local copy once broke
   iOS inbound (1-hour vs 30-day credential TTL).
3. **Frontend changes go to BOTH apps.** Edit `greencallerapp1/src/`, copy the file to
   `greencallerapp1exe/src/`. Exceptions that diverge and must be edited by hand per app:
   `Dashboard.tsx`, `EnterprisePlatform.tsx`, `useTelnyxCall.ts` (native PiP), plus exe-only
   `electron.d.ts`, `utils/`, Sidebar Mode components.
4. **Never touch the live call architecture casually.** Outbound calls use the WebRTC SDK's
   `client.newCall()` directly because Telnyx Call Control webhooks proved unreliable; inbound
   goes through `telnyx-incoming-call` (TeXML). New features must be guarded/additive
   (see opening-hours, AI Lab, Slack notes for the pattern).
5. **Desk phones and mobile must never write to `telnyx_webrtc_registrations`**, and
   registration rows are never expired on logout (30-day credential cache on mobile).
6. **Netlify**: pushing to `main` auto-deploys the web app with base directory
   `greencallerapp1` (set in `netlify.toml`). Env vars for the build are in the Netlify dashboard.

## Setting up on a new machine

```
git clone https://github.com/zaidtutoree/greencaller1.git
cd greencaller1/greencallerapp1    && npm install
cd ../greencallerapp1exe           && npm install
```
The two `.env` files (Supabase URL + publishable key only) are committed, so nothing else is needed
to run. To deploy functions: `npx supabase login` then
`npx supabase link --project-ref wofpxloehneavpoiqpal` from the repo root.
Edge-function secrets (TELNYX_API_KEY, OPENAI_API_KEY, STRIPE_*, SLACK_*, DEEPGRAM_API_KEY) live in
Supabase, not in the repo.

To make Claude Code's auto-memory pick up the notes on a new machine, copy `.claude/memory/` to
`%USERPROFILE%\.claude\projects\<project-path-key>\memory\` (the key is the clone path with
`\` and `:` replaced by `-`, e.g. `C--Users-zaid-Downloads-greencaller1`).

## Feature map (→ note in .claude/memory/)

| Area | Note | One-line gist |
|---|---|---|
| Call queue / Take Call | project_call_queue_implementation | Hold-music Gather loop + `GET /v2/calls/{sid}` polling for hangup detection; Take Call never checks DB status |
| Recording | project_recording_implementation, project_recording_stale_id | Needs a v3: Call Control ID; SDK calls only get one via a credential connection WITH a webhook URL (desktop CC connection 3053154786162509280) |
| Billing | project_subscription_billing | Stripe meter-backed overage price; trial overages via draft invoice on `customer.subscription.updated`, monthly via `invoice.upcoming` |
| Exe icon + floating call card | project_exe_taskbar_icon_and_pip | ICO small sizes must be BMP; AUMID is `com.greencaller.desktop`; PiP is a native window driven over IPC |
| Sidebar Mode (exe) | project_sidebar_mode, project_sidebar_activity_notes | Two BrowserWindows, one SIP registration; never put app-region drag on the panel header |
| Call notes | project_call_notes | `call_notes` keyed by client-minted `call_ref`, not call_sid |
| AI call summary | project_ai_call_summary | `summarize-call` uses gpt-5.4-nano on the Deepgram transcript; needs OPENAI_API_KEY |
| Settings modal | project_settings_modal | Profile / Audio / Ringtone / Opening Hours / Integrations / Desk Phone tabs |
| Opening hours | project_opening_hours | Out-of-hours → voicemail; NOT live in `telnyx-incoming-call` (see deskphone note trap) |
| Contacts / teammates | project_contacts | `user_contacts` (shared with mobile); Messages tab folded into Contacts |
| AI Lab / AI Assistant | project_ai_lab | Telnyx AI assistants on dedicated numbers; restoring a number means TeXML app 'New Calling' 2881667175783859984, not the credential connection |
| Slack | project_slack_integration | Per-company OAuth; missed-call DMs via DB trigger + pg_net |
| Control dashboard | project_control_dashboard | `/control` for company admins; RLS helpers `is_company_admin_for/of` |
| Desk phone (Yealink) | project_deskphone | Own credential connection + on-demand credential per handset; `sip_uri_calling_preference` must be set |
| iOS push / logout | project_ios_push_tokens | Stale `device_tokens` rang a logged-out iPhone; logout hooks in the Expo repo |
| CRM | project_crm | `/crm` CSV upload → editable grid in `crm_sheets` (jsonb columns/rows); single account via `is_crm_user()` RLS |
| WhatsApp | project_whatsapp | Per-user tab granted by admin; Meta Cloud API direct (customer owns WABA, Meta bills them); Embedded Signup in-page; `META_*` secrets; `whatsapp_*` tables |
