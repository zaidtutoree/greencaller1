-- Call notes: per-call notes written by premium/enterprise users during a call.
-- Decoupled from call_history.call_sid (which the backend swaps mid-call between the
-- WebRTC UUID and the PSTN Call Control ID). Notes are keyed by a stable client-side
-- call reference (call_ref) generated in the UI when the call becomes active, so a
-- single call always maps to a single note row regardless of provider/sid churn.

CREATE TABLE IF NOT EXISTS public.call_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_ref TEXT NOT NULL,
  call_history_id UUID REFERENCES public.call_history(id) ON DELETE SET NULL,
  phone_number TEXT,
  contact_name TEXT,
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),
  duration INTEGER DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, call_ref)
);

ALTER TABLE public.call_notes ENABLE ROW LEVEL SECURITY;

-- Owners (and admins) can do everything with their own notes.
CREATE POLICY "Users manage own call notes" ON public.call_notes
  FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS call_notes_user_created_idx
  ON public.call_notes (user_id, created_at DESC);

-- Keep updated_at fresh on every edit.
CREATE OR REPLACE FUNCTION public.set_call_notes_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS call_notes_updated_at ON public.call_notes;
CREATE TRIGGER call_notes_updated_at
  BEFORE UPDATE ON public.call_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_call_notes_updated_at();
