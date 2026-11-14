-- Booked/unavailable appointment slots for an AI assistant. The assigned user
-- marks slots as booked in their AI Assistant calendar; the slots get baked
-- into the Telnyx assistant's instructions so it won't double-book them.
CREATE TABLE IF NOT EXISTS public.ai_booked_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES public.ai_assistants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  slot_date date NOT NULL,
  slot_time text NOT NULL,          -- "HH:MM" local
  title text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (assistant_id, slot_date, slot_time)
);
ALTER TABLE public.ai_booked_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users manage own booked slots" ON public.ai_booked_slots;
CREATE POLICY "users manage own booked slots"
  ON public.ai_booked_slots FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS ai_booked_slots_assistant_idx ON public.ai_booked_slots(assistant_id, slot_date);
