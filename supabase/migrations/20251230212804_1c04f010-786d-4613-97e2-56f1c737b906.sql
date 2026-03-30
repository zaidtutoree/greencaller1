-- Track the currently-connected Telnyx WebRTC SIP username per user so inbound calls can be bridged immediately
CREATE TABLE IF NOT EXISTS public.telnyx_webrtc_registrations (
  user_id UUID PRIMARY KEY,
  sip_username TEXT NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link to profiles (not auth.users)
ALTER TABLE public.telnyx_webrtc_registrations
  ADD CONSTRAINT telnyx_webrtc_registrations_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.profiles(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_telnyx_webrtc_registrations_expires_at
  ON public.telnyx_webrtc_registrations (expires_at);

-- Enable RLS
ALTER TABLE public.telnyx_webrtc_registrations ENABLE ROW LEVEL SECURITY;

-- Policies: users can manage their own registration
DO $$ BEGIN
  CREATE POLICY "Users can view their own Telnyx registration"
  ON public.telnyx_webrtc_registrations
  FOR SELECT
  USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can upsert their own Telnyx registration"
  ON public.telnyx_webrtc_registrations
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own Telnyx registration"
  ON public.telnyx_webrtc_registrations
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete their own Telnyx registration"
  ON public.telnyx_webrtc_registrations
  FOR DELETE
  USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS set_telnyx_webrtc_registrations_updated_at ON public.telnyx_webrtc_registrations;
CREATE TRIGGER set_telnyx_webrtc_registrations_updated_at
BEFORE UPDATE ON public.telnyx_webrtc_registrations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
