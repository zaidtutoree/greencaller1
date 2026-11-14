-- Cache of per-conversation extracted data (summary + collected fields),
-- derived from the Telnyx conversation transcript by the ai-assistant-stats
-- function (service role). Not directly readable by clients.
CREATE TABLE IF NOT EXISTS public.ai_conversation_data (
  conversation_id text PRIMARY KEY,
  assistant_id text,
  user_id uuid,
  from_number text,
  started_at timestamptz,
  duration_secs integer DEFAULT 0,
  summary text,
  collected jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.ai_conversation_data ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS ai_conversation_data_assistant_idx ON public.ai_conversation_data(assistant_id);
