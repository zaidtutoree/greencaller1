-- Create voicemails table
CREATE TABLE public.voicemails (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  recording_url TEXT NOT NULL,
  recording_sid TEXT NOT NULL,
  duration INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  transcription TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.voicemails ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view own voicemails"
  ON public.voicemails
  FOR SELECT
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can view all voicemails"
  ON public.voicemails
  FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can update own voicemails"
  ON public.voicemails
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own voicemails"
  ON public.voicemails
  FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "System can insert voicemails"
  ON public.voicemails
  FOR INSERT
  WITH CHECK (true);

-- Create trigger for updated_at
CREATE TRIGGER update_voicemails_updated_at
  BEFORE UPDATE ON public.voicemails
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();