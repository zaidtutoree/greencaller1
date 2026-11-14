-- AI assistants (Telnyx AI Assistant integration).
-- Each row mirrors a Telnyx assistant; it carries the Telnyx assistant id, the
-- auto-provisioned TeXML app id (used to route a DEDICATED number to the AI —
-- fully separate from the normal telnyx-incoming-call flow), and the insight
-- group id used for data extraction. `assigned_user_id` is the app user who
-- sees the assistant in their "AI Assistant" tab.
CREATE TABLE IF NOT EXISTS public.ai_assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telnyx_assistant_id text,
  telnyx_texml_app_id text,
  insight_group_id text,
  name text NOT NULL,
  description text,
  model text NOT NULL DEFAULT 'anthropic/claude-haiku-4-5',
  character_prompt text,
  instructions text,
  greeting text,
  voice text NOT NULL DEFAULT 'Telnyx.KokoroTTS.af_heart',
  collect_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  telnyx_phone_number text,
  telnyx_phone_number_id text,
  assigned_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.ai_assistants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assigned user can view own assistant" ON public.ai_assistants;
CREATE POLICY "assigned user can view own assistant"
  ON public.ai_assistants FOR SELECT
  USING (assigned_user_id = auth.uid());

CREATE INDEX IF NOT EXISTS ai_assistants_assigned_user_idx ON public.ai_assistants(assigned_user_id);

CREATE OR REPLACE FUNCTION public.ai_assistants_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_assistants_updated_at ON public.ai_assistants;
CREATE TRIGGER ai_assistants_updated_at
  BEFORE UPDATE ON public.ai_assistants
  FOR EACH ROW EXECUTE FUNCTION public.ai_assistants_set_updated_at();
