---
name: project_ai_call_summary
description: AI call summary feature — button in Call History that summarizes a call from its recording transcript
metadata: 
  node_type: memory
  type: project
  originSessionId: b0da3a16-9c05-49b7-b356-7e321617cdd2
---

Added 2026-06-29. AI-generated call summaries for **premium + enterprise** (same gating as [[project_call_notes]]). A "AI Summary" button (Sparkles icon) appears in Call History on rows that have a recording; clicking opens a dialog with an Overview / Key points / Action items summary.

## Data model
- New column `call_recordings.ai_summary text` (migration `supabase/migrations/20260629000000_add_ai_summary_to_call_recordings.sql`, applied to wofpxloehneavpoiqpal). Cached so repeat opens are instant/free.
- Summary source = `call_recordings.transcription` (Deepgram, speaker-labeled `[CALLER]`/`[RECIPIENT]`). See [[project_recording_implementation]].

## Edge function `summarize-call` (shared backend, deployed)
Input `{ recordingId, force? }`. Returns cached `ai_summary` unless `force`. If no transcription yet, it invokes `transcribe-recording` server-to-server (Bearer = service role key) then summarizes. Uses **OpenAI `gpt-5.4-nano`** Chat Completions (`reasoning_effort: "none"` — nano does NOT support "minimal"; valid: none/low/medium/high/xhigh — and `max_completion_tokens: 600`). ~$0.0006/summary. Maps `[CALLER]`/`[RECIPIENT]` → Business/Customer by direction before sending. Verified working end-to-end 2026-06-29 (generate + cache).

**REQUIRES `OPENAI_API_KEY` secret** — it was NOT set on the project (only DEEPGRAM_API_KEY existed; preview-voice's OpenAI TTS was effectively dead). User set it 2026-06-29 via `npx supabase secrets set OPENAI_API_KEY=... --project-ref wofpxloehneavpoiqpal` (CLI is authenticated in this env).

## Fixed `transcribe-recording` (shared, deployed) — was always broken for aged calls
Telnyx recordings are presigned S3 URLs (`s3.amazonaws.com/telephony-recorder-prod/...`) that EXPIRE; the stored `recording_url` is dead within hours. transcribe-recording only fetched the stored URL → "Failed to download audio file" → all 61 recordings had 0 transcriptions. Fixed to resolve a FRESH url from `GET https://api.telnyx.com/v2/recordings/{recording_sid}` (`download_urls.mp3`) using TELNYX_API_KEY first, falling back to stored URL — same pattern as `proxy-recording`. This fix also makes the existing CallRecordings "Transcribe" button work.

## Summary vs transcription are DECOUPLED (user requirement 2026-06-29)
AI Summary needs a transcript internally, but must NOT reveal it in the Recordings tab — the transcript only shows there when the user clicks **Transcribe** explicitly. Implemented via a `save` flag on `transcribe-recording` (default true; the existing Transcribe button saves). `summarize-call` calls it with `save:false` so it transcribes in-memory, summarizes, and persists ONLY `ai_summary` (transcription stays NULL). Verified: after AI Summary, transcription_still_null=true, summary_saved=true. If a transcript already exists (user transcribed), it's reused as-is (no re-charge).

## Frontend (shared web+exe — keep in sync, see [[project_structure]])
- `components/CallSummaryDialog.tsx` — calls `summarize-call`, renders lightweight markdown, Regenerate button (force). Extracts the real error from the FunctionsHttpError body (`error.context.json()`); friendly copy for silent/no-speech calls.
- Button lives in BOTH (user chose "both places"): `components/CallHistory.tsx` (gated premium/enterprise, on rows with a matching recording) AND `components/CallRecordings.tsx` (next to Transcribe, always shown — recordings tab is already its own surface).
- `components/CallHistory.tsx` — fetches `call_recordings` for the user, matches each call to its recording by `call_sid` (primary) then by from/to numbers within 5 min (fallback ~82% match by call_sid alone). Takes `accountType` prop.
- `accountType` threaded: Dashboard `/history` route, EnterprisePlatform→ActivityView (`accountType="enterprise"`), ActivityView→CallHistory.
- Dashboard.tsx + EnterprisePlatform.tsx differ web-vs-exe ONLY by native PiP — edit those two by hand per app, never copy wholesale.
