---
name: project_ai_lab
description: "AI Lab (admin) + AI Assistant (user) — Telnyx AI Assistant integration; separate call architecture; data model, edge functions, voices/models"
metadata: 
  node_type: memory
  type: project
  originSessionId: b0da3a16-9c05-49b7-b356-7e321617cdd2
---

Added 2026-07-06/07. Admin creates Telnyx AI phone assistants in an **AI Lab** tab; assigns each a DEDICATED number + a user; the user sees an **AI Assistant** tab with stats + collected data.

## Hard requirement (met): DO NOT touch existing call architecture
AI numbers are answered by Telnyx's own AI, fully separate from `telnyx-incoming-call`. When you create a Telnyx assistant it AUTO-provisions its own `telephony_settings.default_texml_app_id` (a TeXML app) and `insight_settings.insight_group_id`. Assigning a number = PATCH `/v2/phone_numbers/{id}` `connection_id = default_texml_app_id`. So inbound calls to that number hit the assistant's TeXML app, never our webhook. Unassign/delete restore `connection_id` to the INBOUND TeXML APP (discovered by voice_url == `<SUPABASE_URL>/functions/v1/telnyx-incoming-call`, override `TELNYX_INBOUND_TEXML_APP_ID`), fixed 2026-10-10. **TRAP (bit us 2026-10-10):** `TELNYX_CONNECTION_ID` (3041757718164539203) is the WebRTC *credential* connection, NOT the inbound TeXML app — the old code restored to it, and deleting an assistant never restored the number at all, so +442046204740 stayed pointed at a dead `ai-assistant-…` TeXML app → callers heard silence and `telnyx-incoming-call` was never hit. The real inbound app is TeXML app **'New Calling' id 2881667175783859984** (all working numbers use it). Diagnose with GET /v2/phone_numbers → `connection_name`; fix = PATCH `connection_id` to that app. Delete now also removes the assistant's TeXML app. AI numbers keep `phone_numbers.assigned_to = NULL` (never a user).

## Telnyx API facts (probed live 2026-07-06)
- Create: `POST /v2/ai/assistants` body `{ name, model, instructions, greeting, voice_settings:{voice} }`. Update = `POST /v2/ai/assistants/{id}` (POST, not PATCH). Delete = DELETE.
- **Models that work for assistants**: `anthropic/claude-haiku-4-5` (default), `openai/gpt-4o`, `openai/gpt-4.1`. NOTE `/v2/ai/models` lists many that are NOT assistant-capable (gpt-4o-mini, llama-* → 422 "not available for AI Assistants").
- Voices: `GET /v2/text-to-speech/voices` → `{voices:[{id,name,language,provider,gender}]}`. Default voice `Telnyx.KokoroTTS.af_heart`. Providers telnyx/aws.
- Conversations: `GET /v2/ai/conversations?page[size]=100` → `{data:[{id, created_at, last_message_at, metadata:{from,to,assistant_id,...}}]}`. NESTED `filter[metadata][assistant_id]` 504s — do NOT use; fetch plain list + filter client-side by `metadata.assistant_id`. (This endpoint had a transient Telnyx outage 2026-07-07 — all /ai/conversations* 504'd for ~1h while /ai/assistants stayed up.)
- Transcript: `GET /v2/ai/conversations/{id}/messages?page[size]=100` → `{data:[{role:'user'|'assistant', text, name, sent_at, created_at}]}`, NEWEST-FIRST (sort ascending).
- **Collected data comes from the TRANSCRIPT, not insights** (`insight_id`/`insight_group_id` are null — Telnyx doesn't auto-extract). We extract chosen fields + a summary from the transcript via OpenAI `gpt-5.4-nano` (json_object), cached in `ai_conversation_data`. Verified on a real call: name/phone/reason/appointment all extracted correctly.
- **Voice preview**: `POST /v2/text-to-speech/speech` `{voice, text}` → `audio/mpeg` bytes. Function `ai-voice-preview` (admin-token gated) returns the audio; VoicePicker plays it via a blob URL.

## Data model
Table `public.ai_assistants` (migration `supabase/migrations/20260706000000_create_ai_assistants.sql`): telnyx_assistant_id, telnyx_texml_app_id, insight_group_id, name, description, model, character_prompt, instructions(compiled), greeting, voice, collect_fields jsonb, telnyx_phone_number(_id), assigned_user_id (FK profiles), is_active. RLS: assigned user can SELECT own. In types.ts (both apps).

## Edge functions (deployed from greencaller1/supabase/, see [[project_structure]])
- **admin-ai-assistant** — x-admin-token gated (admin_sessions pattern). Actions: list, get?, voices, models, users, numbers, create, update, assign-number, unassign-number, assign-user, delete. Create → Telnyx create + store row (compiles instructions from character_prompt + collect_fields via FIELD_LABELS). Tested end-to-end (create/assign-number/unassign/delete all verified live).
- **ai-assistant-stats** — verify_jwt, owner-checked. Returns assistant + stats + conversations. Fetches conversations (client-side filter by metadata.assistant_id), and per conversation fetches transcript → extracts {summary, collected} via gpt-5.4-nano → caches in `ai_conversation_data` (conversation_id PK, RLS on, service-role only). Falls back to cached rows if Telnyx is down (returns degraded:true). Needs SUPABASE_ANON_KEY + OPENAI_API_KEY (both exist).
- **ai-voice-preview** — admin-token gated; POST {voice,text} → audio/mpeg via Telnyx TTS.
- Table `ai_conversation_data` (migration 20260707000000): caches extracted per-call data.
- `ai-telnyx-probe` was a temporary discovery fn — NEUTERED to a 410 stub (don't rely on it; delete when possible).

## Frontend (shared web+exe)
- Admin: `components/admin/AILab.tsx` — tab in `AdminDash`/`AdminDashSidebar` (view id "ailab"). Create/edit dialog (name, model, voice, character prompt, greeting, collect-fields checkboxes), number picker (assign/unassign), user assign, delete.
- User: `components/AIAssistant.tsx` — assistant card + stats + calls/collected-data list. Tab shown ONLY if user has an assistant (RLS query `ai_assistants` by assigned_user_id): AppSidebar item + Dashboard route `/dashboard/ai-assistant` (requiresAssistant); MainSidebar item + EnterprisePlatform case + TAB_TITLES + hasAssistant state (all value "ai-assistant").

## Appointment calendar / availability (added 2026-07-07)
User's AI Assistant tab has a **Calendar** button → `components/AvailabilityCalendar.tsx`: week strip + 30-min time grid (08:00–19:30); tap a time to toggle BOOKED. Reads slots directly via RLS; mutations go through `ai-availability` edge fn.
- Table `ai_booked_slots` (migration 20260707200000): assistant_id, user_id, slot_date (date), slot_time (text "HH:MM"), title. RLS own-row.
- `ai-availability` edge fn (JWT+owner): actions list/add/remove. On add/remove it REBUILDS the Telnyx assistant instructions = `ai_assistants.instructions` (base) + availability section. **`ai_assistants.instructions` stays BASE only**; availability is only ever in Telnyx.
- Availability section lists upcoming booked slots ("- Monday 13 July 2026 at 17:00") + `{{telnyx_current_time_<tz>}}` (built-in Telnyx var, auto-substituted, NO webhook needed — tz from user's opening_hours or Europe/London) + instructions telling the AI to refuse booked slots & suggest alternatives. Claude Haiku resolves the caller's "Monday 5pm" via the current-time var.
- **Telnyx assistant update is a PARTIAL update**: `POST /v2/ai/assistants/{id}` with only `{instructions}` preserves name/model/voice (verified). So instructions-only rebuild is safe.
- admin-ai-assistant UPDATE also appends the availability section (queries ai_booked_slots) so admin edits don't wipe the user's booked slots.
- Verified end-to-end 2026-07-07: booked slot lands in live Telnyx instructions.

## Status / caveats
Both apps tsc clean 2026-07-07. NOT pushed to GitHub / not in exe rebuild yet. Analytics (ai-assistant-stats conversation/insight field mapping) is best-effort until validated by a REAL call to an AI number — may need a tweak once conversation data exists. Telnyx AI usage is billed by Telnyx.
