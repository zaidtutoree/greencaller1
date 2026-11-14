-- 1) Fix linter: make function search_path immutable for update_ivr_updated_at
CREATE OR REPLACE FUNCTION public.update_ivr_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 2) Track Telnyx outbound bridge legs (PSTN + WebRTC) so we can bridge reliably
CREATE TABLE IF NOT EXISTS public.telnyx_call_bridges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  to_number TEXT NOT NULL,
  from_number TEXT NOT NULL,
  pstn_call_control_id TEXT NOT NULL,
  webrtc_call_control_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.telnyx_call_bridges
  ADD CONSTRAINT telnyx_call_bridges_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.profiles(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_telnyx_call_bridges_user_id ON public.telnyx_call_bridges(user_id);
CREATE INDEX IF NOT EXISTS idx_telnyx_call_bridges_pstn ON public.telnyx_call_bridges(pstn_call_control_id);
CREATE INDEX IF NOT EXISTS idx_telnyx_call_bridges_webrtc ON public.telnyx_call_bridges(webrtc_call_control_id);

ALTER TABLE public.telnyx_call_bridges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view their own telnyx call bridges"
  ON public.telnyx_call_bridges
  FOR SELECT
  USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert their own telnyx call bridges"
  ON public.telnyx_call_bridges
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own telnyx call bridges"
  ON public.telnyx_call_bridges
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- updated_at trigger for telnyx_call_bridges
DROP TRIGGER IF EXISTS set_telnyx_call_bridges_updated_at ON public.telnyx_call_bridges;
CREATE TRIGGER set_telnyx_call_bridges_updated_at
BEFORE UPDATE ON public.telnyx_call_bridges
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
