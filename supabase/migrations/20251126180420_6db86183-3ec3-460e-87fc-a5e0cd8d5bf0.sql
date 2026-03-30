-- Create call_recordings table
CREATE TABLE public.call_recordings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_sid TEXT NOT NULL,
  recording_sid TEXT NOT NULL,
  recording_url TEXT NOT NULL,
  duration INTEGER,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  direction TEXT NOT NULL,
  user_id UUID REFERENCES public.profiles(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Public read access for call_recordings"
ON public.call_recordings
FOR SELECT
USING (true);

-- Users can create own recordings
CREATE POLICY "Users can create own recordings"
ON public.call_recordings
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can view own recordings
CREATE POLICY "Users can view own recordings"
ON public.call_recordings
FOR SELECT
USING (auth.uid() = user_id OR true);

-- Users can delete own recordings
CREATE POLICY "Users can delete own recordings"
ON public.call_recordings
FOR DELETE
USING (auth.uid() = user_id);

-- Admins can view all recordings
CREATE POLICY "Admins can view all recordings"
ON public.call_recordings
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));