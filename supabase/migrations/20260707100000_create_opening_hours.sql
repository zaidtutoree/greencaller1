-- Per-user opening hours + out-of-hours voicemail message.
-- When enabled, telnyx-incoming-call sends callers straight to voicemail
-- (with the custom message) if they call outside these hours. Optional/off by
-- default, so it never affects a user's call flow unless they turn it on.
CREATE TABLE IF NOT EXISTS public.opening_hours (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'Europe/London',
  hours jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { mon:{open,start,end}, ... }
  voicemail_message text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.opening_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users manage own opening hours" ON public.opening_hours;
CREATE POLICY "users manage own opening hours"
  ON public.opening_hours FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
