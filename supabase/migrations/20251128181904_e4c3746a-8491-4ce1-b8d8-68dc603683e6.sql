-- Create team_messages table for internal team communication
CREATE TABLE IF NOT EXISTS public.team_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message_body TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.team_messages ENABLE ROW LEVEL SECURITY;

-- Users can view messages they sent or received
CREATE POLICY "Users can view their team messages"
ON public.team_messages
FOR SELECT
USING (
  auth.uid() = from_user_id OR 
  auth.uid() = to_user_id
);

-- Users can send messages to team members in their company
CREATE POLICY "Users can send messages to team members"
ON public.team_messages
FOR INSERT
WITH CHECK (
  auth.uid() = from_user_id AND
  EXISTS (
    SELECT 1 FROM profiles sender
    JOIN profiles recipient ON sender.company_name = recipient.company_name
    WHERE sender.id = auth.uid() 
    AND recipient.id = to_user_id
    AND sender.account_type = 'enterprise'
  )
);

-- Users can update read status of messages sent to them
CREATE POLICY "Users can mark messages as read"
ON public.team_messages
FOR UPDATE
USING (auth.uid() = to_user_id)
WITH CHECK (auth.uid() = to_user_id);

-- Users can delete their own sent messages
CREATE POLICY "Users can delete their sent messages"
ON public.team_messages
FOR DELETE
USING (auth.uid() = from_user_id);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_team_messages_from_user ON public.team_messages(from_user_id);
CREATE INDEX IF NOT EXISTS idx_team_messages_to_user ON public.team_messages(to_user_id);
CREATE INDEX IF NOT EXISTS idx_team_messages_created_at ON public.team_messages(created_at DESC);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_team_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_team_messages_updated_at
BEFORE UPDATE ON public.team_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_team_messages_updated_at();