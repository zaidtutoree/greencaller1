-- Add AI call summary column to call_recordings.
-- Populated on demand by the `summarize-call` edge function (gpt-5.4-nano)
-- from the recording's transcription, then cached so repeat opens are instant.
ALTER TABLE public.call_recordings
  ADD COLUMN IF NOT EXISTS ai_summary text;

COMMENT ON COLUMN public.call_recordings.ai_summary IS 'AI-generated summary of the call, produced on demand from the transcription (gpt-5.4-nano).';
